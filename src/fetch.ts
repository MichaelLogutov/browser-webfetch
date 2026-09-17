import {
  errors as PlaywrightErrors,
  type Download,
  type Page,
  type Response,
} from 'rebrowser-playwright';
import { JSDOM } from 'jsdom';
import { BrowserSingleton } from './browser.js';
import { FifoQueue } from './queue.js';
import { BwfError, ErrorCode } from './errors.js';
import { detectCaptchaInDom, detectLoginWall, readableContentLength } from './captcha.js';
import { downloadToFile, isHtmlLike, saveDownloadToFile } from './download.js';
import { extractContent, OutputFormat } from './extract.js';
import {
  injectOverlay,
  removeOverlay,
  waitForManualResolution,
  waitForManualInteraction,
} from './manual.js';
import { logger } from './logger.js';

export interface FetchRequest {
  url: string;
  format: OutputFormat;
  waitFor?: string;
  navTimeoutMs: number;
  manualTimeoutMs: number;
  download?: boolean;
  interactive?: boolean;
  downloadDir: string;
  browser: BrowserSingleton;
  queue: FifoQueue;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  body: string;
  durationMs: number;
}

export function fetchUrl(req: FetchRequest): Promise<FetchResult> {
  return req.queue.run(() => runOne(req));
}

async function runOne(req: FetchRequest): Promise<FetchResult> {
  const t0 = Date.now();
  const page = await req.browser.acquireTab();
  try {
    if (req.download === true) {
      const filePath = await downloadViaBrowser(page, req);
      return { url: req.url, finalUrl: req.url, body: filePath, durationMs: Date.now() - t0 };
    }

    const response = await navigate(page, req);
    const status = response?.status() ?? 200;
    const contentType = response?.headers()['content-type'];

    if (!isHtmlLike(contentType)) {
      logger.warn('non-HTML content-type, auto-downloading', {
        url: req.url,
        contentType,
      });
      // The page already navigated here, so the context cookie jar is warm; fetch
      // the bytes through it rather than a cold raw request.
      const dl = await downloadToFile(page.context(), req.url, req.downloadDir, req.navTimeoutMs);
      return { url: req.url, finalUrl: req.url, body: dl.path, durationMs: Date.now() - t0 };
    }

    if (req.interactive === true) {
      const outcome = await handleInteractive(page, req);
      if (outcome.kind === 'download') {
        return { url: req.url, finalUrl: req.url, body: outcome.filePath, durationMs: Date.now() - t0 };
      }
      return {
        url: req.url,
        finalUrl: page.url(),
        body: extractContent(outcome.html, req.format, req.url),
        durationMs: Date.now() - t0,
      };
    }

    await maybeWaitForSelector(page, req);
    const cap = await handleCaptchaIfPresent(page, status, req);
    // A handled anti-bot wall has navigated us to real content, so the original
    // status (e.g. the 401 a Qrator captcha is served with) is stale — passing
    // it on would re-trigger the login-wall flow on the now-clean page.
    const loginStatus = cap.handled ? 200 : status;
    const html = await handleLoginWallIfPresent(page, loginStatus, req, cap.html);
    const body = extractContent(html, req.format, req.url);
    return {
      url: req.url,
      finalUrl: page.url(),
      body,
      durationMs: Date.now() - t0,
    };
  } finally {
    await req.browser.releaseTab(page);
  }
}

// How many times captureBytesInPage re-probes the endpoint while a JS challenge
// is still settling (its redirect / cookie dance runs a beat after navigation
// returns), and the pause between tries.
const DOWNLOAD_SETTLE_ATTEMPTS = 4;
const DOWNLOAD_SETTLE_DELAY_MS = 2000;

// Moving a file's bytes is not a navigation: a large download legitimately runs
// for minutes, so it must never be measured against navTimeoutMs. The browser's
// own download machinery carries no deadline at all; this budget only bounds the
// raw-request fallback below.
const DOWNLOAD_TRANSFER_TIMEOUT_MS = 10 * 60_000;

/**
 * Download a binary through the real browser so JS challenges / anti-bot walls
 * are actually cleared — the old raw request executed no JS and just saved the
 * challenge stub. Two outcomes:
 *   - the server streams an attachment (`Content-Disposition: attachment`) or the
 *     browser downloads this type outright → a `download` event fires, saved as-is;
 *   - the URL renders as a page (JS challenge, captcha wall, or an in-browser PDF
 *     viewer) → clear any captcha, then pull the bytes via an in-page fetch
 *     (see captureBytesInPage).
 */
async function downloadViaBrowser(page: Page, req: FetchRequest): Promise<string> {
  let native: Download | null = null;
  const onDownload = (d: Download): void => {
    native ??= d;
  };
  page.on('download', onDownload);
  let response: Response | null = null;
  try {
    const nav = await navigateForDownload(page, req);
    response = nav.response;
    if (!native && nav.downloadAbort) {
      native = await page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
    }
  } finally {
    page.off('download', onDownload);
  }
  if (native) return (await saveDownloadToFile(native, req.downloadDir)).path;
  await handleCaptchaIfPresent(page, response?.status() ?? 200, req);
  return await captureBytesInPage(page, req);
}

/**
 * Navigate to a binary URL. Beyond the normal timeout tolerance, a navigation
 * that turns into a download aborts the main request (`net::ERR_ABORTED`); that
 * is expected here and reported so the caller can pick up the download event.
 */
async function navigateForDownload(
  page: Page,
  req: FetchRequest,
): Promise<{ response: Response | null; downloadAbort: boolean }> {
  try {
    const response = await page.goto(req.url, {
      waitUntil: 'networkidle',
      timeout: req.navTimeoutMs,
    });
    return { response, downloadAbort: false };
  } catch (err) {
    if (err instanceof PlaywrightErrors.TimeoutError) return { response: null, downloadAbort: false };
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('net::ERR_ABORTED') || msg.includes('Download is starting')) {
      return { response: null, downloadAbort: true };
    }
    throw new BwfError(ErrorCode.NAV_ERROR, `navigation failed: ${msg}`, { url: req.url });
  }
}

interface ProbeResult {
  kind: 'binary' | 'challenge' | 'error' | 'retry';
  status: number;
  ct: string;
  detail: string;
}

/**
 * Runs inside the page: ask the endpoint what it is answering with, using the
 * browser's own network stack — its genuine TLS/JA3 fingerprint and the page's
 * clearance cookies — which a raw Playwright request (context.request) lacks, so
 * anti-bot endpoints that fingerprint the handshake (Servicepipe, Qrator,
 * DataDome) reveal the file instead of a fresh challenge.
 *
 * Only the response headers are wanted, so the body is aborted the moment they
 * land: the bytes themselves are pulled afterwards by the browser's download
 * machinery, which streams to disk instead of buffering the whole file in the
 * renderer. That also keeps the timeout honest — it bounds how long the endpoint
 * may take to answer, never how long a large file takes to transfer.
 */
const IN_PAGE_PROBE = async (arg: { url: string; timeoutMs: number }): Promise<ProbeResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), arg.timeoutMs);
  try {
    const resp = await fetch(arg.url, { credentials: 'include', signal: controller.signal });
    const ct = resp.headers.get('content-type') || '';
    const status = resp.status;
    controller.abort();
    if (!resp.ok) return { kind: 'error', status, ct, detail: '' };
    if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(ct)) {
      return { kind: 'challenge', status, ct, detail: '' };
    }
    return { kind: 'binary', status, ct, detail: '' };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { kind: 'error', status: 0, ct: '', detail: `${e?.name ?? 'Error'}: ${e?.message ?? ''}` };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs inside the page: hand the URL to the browser's download machinery via an
 * `<a download>` click, so Chrome fetches it through its own network stack and
 * streams it straight to disk — no size ceiling, no renderer buffering and no
 * deadline of our own. Same-origin only; a cross-origin URL has its `download`
 * attribute ignored, which the caller detects by the absent download event.
 */
const IN_PAGE_TRIGGER_DOWNLOAD = (url: string): void => {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/**
 * Pull the file bytes through the browser network, retrying while a JS challenge
 * is still settling. A page that never yields a file raises an error describing
 * what the endpoint actually did, rather than saving a stub.
 */
async function captureBytesInPage(page: Page, req: FetchRequest): Promise<string> {
  let captured: Download | null = null;
  const onDownload = (d: Download): void => {
    captured ??= d;
  };
  page.on('download', onDownload);
  try {
    await page.waitForLoadState('networkidle', { timeout: req.navTimeoutMs }).catch(() => {});
    let last: ProbeResult = { kind: 'retry', status: 0, ct: '', detail: '' };
    for (let attempt = 0; attempt < DOWNLOAD_SETTLE_ATTEMPTS; attempt++) {
      last = await page
        .evaluate(IN_PAGE_PROBE, { url: req.url, timeoutMs: req.navTimeoutMs })
        .catch((err: unknown) => ({
          kind: 'retry' as const,
          status: 0,
          ct: '',
          detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
        }));
      if (last.kind === 'binary') return await streamBytesToDisk(page, req, () => captured);
      if (last.kind === 'error' && last.status >= 400) {
        throw new BwfError(ErrorCode.NAV_ERROR, `download failed: HTTP ${last.status}`, {
          url: req.url,
        });
      }
      if (attempt < DOWNLOAD_SETTLE_ATTEMPTS - 1) await sleep(DOWNLOAD_SETTLE_DELAY_MS);
    }
    throw unresolvedDownloadError(req.url, last);
  } finally {
    page.off('download', onDownload);
  }
}

/**
 * The endpoint is serving the real file: let the browser download it. The wait
 * bounds how long the download takes to *start*, not to finish — Playwright's
 * saveAs then waits out the whole transfer. When the `download` attribute was
 * ignored (a cross-origin URL, e.g. after a redirect to a CDN) no download event
 * ever fires, and the bytes are fetched through the context's warm cookie jar
 * instead, on a transfer-sized budget.
 */
async function streamBytesToDisk(
  page: Page,
  req: FetchRequest,
  peekCaptured: () => Download | null,
): Promise<string> {
  await page.evaluate(IN_PAGE_TRIGGER_DOWNLOAD, req.url).catch(() => undefined);
  const dl =
    peekCaptured() ??
    (await page.waitForEvent('download', { timeout: req.navTimeoutMs }).catch(() => null));
  if (dl) return (await saveDownloadToFile(dl, req.downloadDir)).path;
  logger.warn('download attribute ignored (cross-origin); falling back to a context request', {
    url: req.url,
  });
  const fallback = await downloadToFile(
    page.context(),
    req.url,
    req.downloadDir,
    DOWNLOAD_TRANSFER_TIMEOUT_MS,
  );
  return fallback.path;
}

function unresolvedDownloadError(url: string, last: ProbeResult): BwfError {
  if (last.kind === 'challenge') {
    return new BwfError(
      ErrorCode.NAV_ERROR,
      `download did not return a file: the endpoint kept answering with HTML (last content-type ${last.ct || 'unknown'}); ` +
        'the anti-bot challenge did not clear',
      { url, htmlChallenge: true },
    );
  }
  return new BwfError(
    ErrorCode.NAV_ERROR,
    `download did not return a file: the endpoint never answered with readable headers (last error: ${last.detail || 'unknown'})`,
    { url },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function navigate(page: Page, req: FetchRequest): Promise<Response | null> {
  try {
    return await page.goto(req.url, {
      waitUntil: 'networkidle',
      timeout: req.navTimeoutMs,
    });
  } catch (err) {
    if (err instanceof PlaywrightErrors.TimeoutError) {
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new BwfError(ErrorCode.NAV_ERROR, `navigation failed: ${msg}`, { url: req.url });
  }
}

async function maybeWaitForSelector(page: Page, req: FetchRequest): Promise<void> {
  if (!req.waitFor) return;
  try {
    await page.waitForSelector(req.waitFor, { timeout: req.navTimeoutMs });
  } catch {
    logger.warn('wait_for selector did not appear', { selector: req.waitFor });
  }
}

type InteractiveOutcome = { kind: 'html'; html: string } | { kind: 'download'; filePath: string };

async function handleInteractive(page: Page, req: FetchRequest): Promise<InteractiveOutcome> {
  logger.info('interactive flag set; surfacing window for manual interaction', {
    url: req.url,
  });
  await req.browser.unminimize(page);
  await page.bringToFront();
  const res = await waitForManualInteraction(page, {
    timeoutMs: req.manualTimeoutMs,
    captureDownloadDir: req.downloadDir,
  });
  if (res.reason === 'downloaded' && res.filePath) {
    return { kind: 'download', filePath: res.filePath };
  }
  return { kind: 'html', html: res.html };
}

async function handleLoginWallIfPresent(
  page: Page,
  status: number,
  req: FetchRequest,
  currentHtml: string,
): Promise<string> {
  const doc = new JSDOM(currentHtml).window.document;
  const detection = detectLoginWall(doc, status, page.url(), req.url);
  if (!detection.detected) return currentHtml;

  logger.info('login wall detected; surfacing window for manual login', {
    url: req.url,
    finalUrl: page.url(),
    provider: detection.provider,
  });
  await req.browser.unminimize(page);
  await page.bringToFront();

  const { html, reason } = await waitForManualInteraction(page, {
    timeoutMs: req.manualTimeoutMs,
    isResolved: (url, resolvedHtml) =>
      sameHost(url, req.url) &&
      !detectLoginWall(new JSDOM(resolvedHtml).window.document, 200, url, req.url).detected,
  });

  // Auto-resolved but the OAuth flow may have landed on a different path of the
  // requested host — re-navigate to the originally requested URL for content.
  if (reason === 'resolved' && sameHost(page.url(), req.url) && page.url() !== req.url) {
    try {
      await page.goto(req.url, { waitUntil: 'networkidle', timeout: req.navTimeoutMs });
      return await page.content();
    } catch {
      return html;
    }
  }
  return html;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

interface CaptchaOutcome {
  html: string;
  // True once we have entered the manual-resolution flow (the wall was real and
  // surfaced). Lets the caller treat the page as past the wall regardless of
  // whether it cleared automatically or the user signalled done.
  handled: boolean;
}

async function handleCaptchaIfPresent(
  page: Page,
  status: number,
  req: FetchRequest,
): Promise<CaptchaOutcome> {
  const initialHtml = await page.content();
  const initialDom = new JSDOM(initialHtml).window.document;
  const detection = detectCaptchaInDom(initialDom, status);
  if (!detection.detected) return { html: initialHtml, handled: false };

  // Weak (heuristic) detections are gated by a content guard so a real article
  // that coincidentally carries captcha-ish markers is not mistaken for a wall.
  // Strong detections (dedicated captcha assets / vendor block pages) are
  // unambiguous, so they surface the window regardless of how much explanatory
  // boilerplate the interstitial contains.
  if (!detection.strong && readableContentLength(initialDom) > 500) {
    logger.info('captcha markers but page has substantial content; skipping manual wait', {
      type: detection.type,
    });
    return { html: initialHtml, handled: false };
  }

  logger.info('captcha detected; waiting for manual resolution', { type: detection.type });
  await req.browser.unminimize(page);
  await page.bringToFront();
  await injectOverlay(page);

  // Solving a captcha (or clicking the interstitial's own refresh/submit)
  // reloads the page, which wipes our injected overlay — re-add it on every load
  // so the "✓ Готово" fallback button survives across reloads.
  const reinjectOverlay = (): void => {
    void injectOverlay(page).catch(() => undefined);
  };
  page.on('load', reinjectOverlay);
  try {
    await waitForManualResolution(page, {
      timeoutMs: req.manualTimeoutMs,
      pollIntervalMs: 1000,
      isCaptchaGone: () => captchaCleared(page),
    });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  } finally {
    page.off('load', reinjectOverlay);
    await removeOverlay(page).catch(() => {});
  }
  // After resolution, re-fetch the page content since the page likely changed.
  return { html: await page.content(), handled: true };
}

// Whether the captcha/wall is gone, evaluated defensively. The user's solve or
// the interstitial's own refresh reloads the page; reading content mid-reload
// throws ("page is navigating") and a half-loaded document can momentarily lack
// the captcha markers. So we only judge a fully-settled page and treat any
// navigation hiccup as "still here, keep waiting" — never a false "resolved"
// that would tear the window down before the user finishes.
async function captchaCleared(page: Page): Promise<boolean> {
  try {
    const ready = await page.evaluate(() => document.readyState).catch(() => 'loading');
    if (ready !== 'complete') return false;
    const html = await page.content();
    const doc = new JSDOM(html).window.document;
    return !detectCaptchaInDom(doc, 200).detected;
  } catch {
    return false;
  }
}

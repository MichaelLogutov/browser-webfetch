import { errors as PlaywrightErrors, type Page, type Response } from 'rebrowser-playwright';
import { JSDOM } from 'jsdom';
import { BrowserSingleton } from './browser.js';
import { FifoQueue } from './queue.js';
import { BwfError, ErrorCode } from './errors.js';
import { detectCaptchaInDom, detectLoginWall, readableContentLength } from './captcha.js';
import { downloadToFile } from './download.js';
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

  if (req.download === true) {
    const dl = await req.browser.withContext((ctx) =>
      downloadToFile(ctx, req.url, req.downloadDir, req.navTimeoutMs),
    );
    return {
      url: req.url,
      finalUrl: req.url,
      body: dl.path,
      durationMs: Date.now() - t0,
    };
  }

  const page = await req.browser.acquireTab();
  let releasedEarly = false;
  try {
    const response = await navigate(page, req);
    const status = response?.status() ?? 200;
    const contentType = response?.headers()['content-type'];

    if (!isHtmlLike(contentType)) {
      logger.warn('non-HTML content-type, auto-downloading', {
        url: req.url,
        contentType,
      });
      releasedEarly = true;
      await req.browser.releaseTab(page);
      const dl = await req.browser.withContext((ctx) =>
        downloadToFile(ctx, req.url, req.downloadDir, req.navTimeoutMs),
      );
      return {
        url: req.url,
        finalUrl: req.url,
        body: dl.path,
        durationMs: Date.now() - t0,
      };
    }

    if (req.interactive === true) {
      const html = await handleInteractive(page, req);
      return {
        url: req.url,
        finalUrl: page.url(),
        body: extractContent(html, req.format, req.url),
        durationMs: Date.now() - t0,
      };
    }

    await maybeWaitForSelector(page, req);
    let html = await handleCaptchaIfPresent(page, status, req);
    html = await handleLoginWallIfPresent(page, status, req, html);
    const body = extractContent(html, req.format, req.url);
    return {
      url: req.url,
      finalUrl: page.url(),
      body,
      durationMs: Date.now() - t0,
    };
  } finally {
    if (!releasedEarly) await req.browser.releaseTab(page);
  }
}

function isHtmlLike(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const ct = contentType.split(';')[0].trim().toLowerCase();
  return ct === 'text/html' || ct === 'application/xhtml+xml';
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

async function handleInteractive(page: Page, req: FetchRequest): Promise<string> {
  logger.info('interactive flag set; surfacing window for manual interaction', {
    url: req.url,
  });
  await req.browser.unminimize(page);
  await page.bringToFront();
  const { html } = await waitForManualInteraction(page, { timeoutMs: req.manualTimeoutMs });
  return html;
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

async function handleCaptchaIfPresent(
  page: Page,
  status: number,
  req: FetchRequest,
): Promise<string> {
  const initialHtml = await page.content();
  const initialDom = new JSDOM(initialHtml).window.document;
  const detection = detectCaptchaInDom(initialDom, status);
  if (!detection.detected) return initialHtml;

  if (readableContentLength(initialDom) > 500) {
    logger.info('captcha markers but page has substantial content; skipping manual wait', {
      type: detection.type,
    });
    return initialHtml;
  }

  logger.info('captcha detected; waiting for manual resolution', { type: detection.type });
  await req.browser.unminimize(page);
  await page.bringToFront();
  await injectOverlay(page);

  try {
    await waitForManualResolution(page, {
      timeoutMs: req.manualTimeoutMs,
      pollIntervalMs: 1000,
      isCaptchaGone: async () => {
        const html = await page.content();
        const doc = new JSDOM(html).window.document;
        return !detectCaptchaInDom(doc, 200).detected;
      },
    });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  } finally {
    await removeOverlay(page).catch(() => {});
  }
  // After resolution, re-fetch the page content since the page likely changed.
  return await page.content();
}

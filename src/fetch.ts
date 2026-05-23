import { errors as PlaywrightErrors, type Page, type Response } from 'playwright';
import { JSDOM } from 'jsdom';
import { BrowserSingleton } from './browser.js';
import { FifoQueue } from './queue.js';
import { BwfError, ErrorCode } from './errors.js';
import { detectCaptchaInDom, readableContentLength } from './captcha.js';
import { downloadToFile } from './download.js';
import { extractContent, OutputFormat } from './extract.js';
import { injectOverlay, removeOverlay, waitForManualResolution } from './manual.js';
import { logger } from './logger.js';

export interface FetchRequest {
  url: string;
  format: OutputFormat;
  waitFor?: string;
  navTimeoutMs: number;
  manualTimeoutMs: number;
  download?: boolean;
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

    await maybeWaitForSelector(page, req);
    const html = await handleCaptchaIfPresent(page, status, req);
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

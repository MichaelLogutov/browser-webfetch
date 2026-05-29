import type { Page } from 'rebrowser-playwright';
import { BwfError, ErrorCode } from './errors.js';

const OVERLAY_HTML = `
<div id="__bwf_overlay" style="
  position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
  font: 14px -apple-system, Segoe UI, sans-serif; color: #fff;
  background: rgba(20, 20, 22, 0.92); padding: 12px 14px; border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4); display: flex; gap: 10px; align-items: center;
">
  <span>browser-webfetch ждёт…</span>
  <button id="__bwf_done_btn" style="
    background: #2a7fff; color: #fff; border: 0; padding: 6px 12px;
    border-radius: 6px; font: inherit; cursor: pointer;
  ">✓ Готово</button>
</div>
`;

const OVERLAY_SCRIPT = `
(() => {
  if (document.getElementById('__bwf_overlay')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = ${JSON.stringify(OVERLAY_HTML)};
  document.documentElement.appendChild(wrap.firstElementChild);
  window.__bwf_done = false;
  document.getElementById('__bwf_done_btn').addEventListener('click', () => {
    window.__bwf_done = true;
  });
})();
`;

export async function injectOverlay(page: Page): Promise<void> {
  await page.evaluate(OVERLAY_SCRIPT);
}

export async function removeOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__bwf_overlay');
    if (el?.parentElement) el.parentElement.removeChild(el);
    delete (window as unknown as { __bwf_done?: boolean }).__bwf_done;
  });
}

export type ResolutionReason = 'overlay_clicked' | 'captcha_cleared';

export interface ManualWaitOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  isCaptchaGone: () => Promise<boolean>;
}

export async function waitForManualResolution(
  page: Page,
  opts: ManualWaitOptions,
): Promise<ResolutionReason> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page
      .evaluate(() => (window as unknown as { __bwf_done?: boolean }).__bwf_done === true)
      .catch(() => false);
    if (clicked) return 'overlay_clicked';
    if (await opts.isCaptchaGone()) return 'captcha_cleared';
    await sleep(opts.pollIntervalMs);
  }
  throw new BwfError(ErrorCode.MANUAL_TIMEOUT, 'manual captcha solve timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type InteractionEndReason = 'closed' | 'resolved';

export interface ManualInteractionOptions {
  timeoutMs: number;
  // Optional auto-resolve predicate, evaluated against the current URL and the
  // freshly loaded HTML on each load event. Used by the auto login-wall flow;
  // omitted by the forced `interactive` flow (which only ends on tab close).
  isResolved?: (url: string, html: string) => boolean;
}

export interface ManualInteractionResult {
  html: string;
  reason: InteractionEndReason;
}

/**
 * Surface-and-wait for manual interaction (login, etc.). No DOM overlay is
 * injected. Content is snapshotted on every `load`/`domcontentloaded` (no
 * polling); the wait ends when the user closes the tab, when `isResolved`
 * becomes true, or — by throwing MANUAL_TIMEOUT — when `timeoutMs` elapses.
 * Returns a live read if the page is still open, else the last snapshot.
 */
export function waitForManualInteraction(
  page: Page,
  opts: ManualInteractionOptions,
): Promise<ManualInteractionResult> {
  return new Promise<ManualInteractionResult>((resolve, reject) => {
    let settled = false;
    let lastSnapshot = '';
    let haveLoadSnapshot = false;
    let timer: NodeJS.Timeout;

    // `timeoutMs` is an INACTIVITY window, not an absolute deadline: every
    // navigation (a clear sign the user is mid-flow, e.g. stepping through a
    // login) re-arms it, so an actively-working user is never cut off. It fires
    // only after `timeoutMs` of no navigation (the user walked away).
    const armTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new BwfError(ErrorCode.MANUAL_TIMEOUT, manualTimeoutMessage(opts.timeoutMs)));
      }, opts.timeoutMs);
    };

    const onLoad = (): void => {
      armTimer();
      page
        .content()
        .then((html) => {
          lastSnapshot = html;
          haveLoadSnapshot = true;
          if (opts.isResolved && opts.isResolved(page.url(), html)) finish('resolved', html);
        })
        .catch(() => undefined);
    };
    const onClose = (): void => finish('closed', lastSnapshot);

    function finish(reason: InteractionEndReason, html: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ html, reason });
    }
    function cleanup(): void {
      clearTimeout(timer);
      page.off('load', onLoad);
      page.off('domcontentloaded', onLoad);
      page.off('close', onClose);
    }

    // Attach listeners synchronously so an early load/close is never missed.
    page.on('load', onLoad);
    page.on('domcontentloaded', onLoad);
    page.on('close', onClose);
    armTimer();

    // Seed an initial snapshot, but don't clobber one a load event already set.
    page
      .content()
      .then((html) => {
        if (!haveLoadSnapshot) lastSnapshot = html;
      })
      .catch(() => undefined);
  });
}

function manualTimeoutMessage(timeoutMs: number): string {
  const secs = Math.round(timeoutMs / 1000);
  return (
    `Timed out after ${secs}s of inactivity in the browser window. ` +
    'This almost always means the user did not notice the window or stepped away — ' +
    'it is NOT a tool or website failure. A Chromium window was opened for the user ' +
    'to log in / interact. Ask the user to complete it in that window, then call ' +
    'browser_fetch again (optionally with a larger manual_timeout). Do not report ' +
    'this as something to debug.'
  );
}

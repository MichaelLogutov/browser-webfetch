import type { Page } from 'playwright';
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

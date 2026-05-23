import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { BrowserSingleton } from '../../src/browser.js';
import { injectOverlay, waitForManualResolution } from '../../src/manual.js';

const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-manual-'));
const singleton = new BrowserSingleton({ profileDir: tmpProfile, idleTimeoutMs: 60_000 });

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><body><h1>Fake captcha page</h1></body>');
});

afterAll(async () => {
  await singleton.close();
  server.close();
  rmSync(tmpProfile, { recursive: true, force: true });
});

describe('manual interaction', () => {
  it('injects overlay and resolves when __bwf_done is set', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const tab = await singleton.acquireTab();
    await tab.goto(`http://127.0.0.1:${port}/`);
    await injectOverlay(tab);

    const overlayPresent = await tab.evaluate(() => !!document.getElementById('__bwf_overlay'));
    expect(overlayPresent).toBe(true);

    // Simulate overlay click by setting the flag directly.
    setTimeout(() => {
      void tab.evaluate(() => { (window as unknown as { __bwf_done: boolean }).__bwf_done = true; });
    }, 100);

    const reason = await waitForManualResolution(tab, {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      isCaptchaGone: async () => false,
    });
    expect(reason).toBe('overlay_clicked');

    await singleton.releaseTab(tab);
  });

  it('resolves when isCaptchaGone returns true', async () => {
    const tab = await singleton.acquireTab();
    await tab.goto('about:blank');
    await injectOverlay(tab);

    let calls = 0;
    const reason = await waitForManualResolution(tab, {
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      isCaptchaGone: async () => ++calls >= 3,
    });
    expect(reason).toBe('captcha_cleared');
    await singleton.releaseTab(tab);
  });
});

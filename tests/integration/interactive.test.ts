import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSingleton } from '../../src/browser.js';
import { FifoQueue } from '../../src/queue.js';
import { fetchUrl } from '../../src/fetch.js';

const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-interactive-'));
const browser = new BrowserSingleton({ profileDir: tmpProfile, idleTimeoutMs: 60_000 });
const queue = new FifoQueue({ queueTimeoutMs: 30_000 });

afterAll(async () => {
  await browser.close();
  rmSync(tmpProfile, { recursive: true, force: true });
});

describe('interactive flow', () => {
  it('surfaces the page, returns last content when the user closes the tab', async () => {
    // Drive fetchUrl with interactive:true, then simulate the user closing the
    // tab shortly after by closing the acquired page out-of-band.
    const original = browser.acquireTab.bind(browser);
    let capturedPage: Awaited<ReturnType<typeof browser.acquireTab>> | undefined;
    browser.acquireTab = async () => {
      const page = await original();
      capturedPage = page;
      return page;
    };

    const closeSoon = (async () => {
      const start = Date.now();
      while (!capturedPage && Date.now() - start < 20_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // let navigation settle, then the "user" closes the tab
      await new Promise((r) => setTimeout(r, 1500));
      await capturedPage?.close();
    })();

    const result = await fetchUrl({
      url: 'https://example.com',
      format: 'markdown',
      navTimeoutMs: 30_000,
      manualTimeoutMs: 30_000,
      interactive: true,
      downloadDir: tmpProfile,
      browser,
      queue,
    });
    await closeSoon;

    expect(result.body).toContain('Example Domain');
  }, 60_000);
});

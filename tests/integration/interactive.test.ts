import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSingleton } from '../../src/browser.js';
import { FifoQueue } from '../../src/queue.js';
import { fetchUrl } from '../../src/fetch.js';

const tmpDownloads = mkdtempSync(join(tmpdir(), 'bwf-interactive-dl-'));
// Each test gets its own browser/profile: the close-tab test tears its context
// down, which would race a shared context reused by the next test.
const profiles: string[] = [];
function freshBrowser(): BrowserSingleton {
  const dir = mkdtempSync(join(tmpdir(), 'bwf-interactive-'));
  profiles.push(dir);
  return new BrowserSingleton({ profileDir: dir, idleTimeoutMs: 60_000 });
}
const queue = new FifoQueue({ queueTimeoutMs: 30_000 });

afterAll(() => {
  rmSync(tmpDownloads, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  for (const dir of profiles) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * Drive fetchUrl(interactive) while `onPage` acts as the user against the tab it
 * opens. acquireTab is wrapped to capture that tab, then restored.
 */
async function withCapturedTab(
  browser: BrowserSingleton,
  downloadDir: string,
  onPage: (page: Awaited<ReturnType<typeof browser.acquireTab>>) => Promise<void>,
): Promise<string> {
  const rawAcquireTab = browser.acquireTab.bind(browser);
  let capturedPage: Awaited<ReturnType<typeof browser.acquireTab>> | undefined;
  browser.acquireTab = async () => {
    const page = await rawAcquireTab();
    capturedPage = page;
    return page;
  };
  const driver = (async () => {
    const start = Date.now();
    while (!capturedPage && Date.now() - start < 20_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // let the initial navigation settle before the "user" acts
    await new Promise((r) => setTimeout(r, 1500));
    if (capturedPage) await onPage(capturedPage);
  })();
  try {
    const { body } = await fetchUrl({
      url: 'https://example.com',
      format: 'markdown',
      navTimeoutMs: 30_000,
      manualTimeoutMs: 30_000,
      interactive: true,
      downloadDir,
      browser,
      queue,
    });
    await driver;
    return body;
  } finally {
    await browser.close();
  }
}

describe('interactive flow', () => {
  it('surfaces the page, returns last content when the user closes the tab', async () => {
    const body = await withCapturedTab(freshBrowser(), tmpDownloads, (page) => page.close());
    expect(body).toContain('Example Domain');
  }, 60_000);

  it('captures a file the user downloads and returns its path', async () => {
    const body = await withCapturedTab(freshBrowser(), tmpDownloads, (page) =>
      page.evaluate(() => {
        const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], {
          type: 'application/octet-stream',
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'user-file.bin';
        document.body.appendChild(a);
        a.click();
      }),
    );

    expect(existsSync(body)).toBe(true);
    expect(body.endsWith('user-file.bin')).toBe(true);
    expect(readFileSync(body)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  }, 60_000);
});

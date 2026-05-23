import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSingleton } from '../../src/browser.js';

const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-stealth-'));
const browser = new BrowserSingleton({ profileDir: tmpProfile, idleTimeoutMs: 60_000 });

afterAll(async () => {
  await browser.close();
  rmSync(tmpProfile, { recursive: true, force: true });
});

describe('stealth patches (network-bound)', () => {
  it('passes core checks on bot.sannysoft.com', async () => {
    const page = await browser.acquireTab();
    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'networkidle', timeout: 30_000 });

    const checks = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      pluginsLength: navigator.plugins.length,
      languages: navigator.languages,
      chromeRuntime: typeof (window as unknown as { chrome?: { runtime?: unknown } }).chrome?.runtime,
    }));

    expect(checks.webdriver).toBe(false);
    expect(checks.pluginsLength).toBeGreaterThan(0);
    expect(checks.languages.length).toBeGreaterThan(0);
    expect(checks.chromeRuntime).toBe('object');

    await browser.releaseTab(page);
  }, 60_000);
});

import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ root: '', executable: '' }));

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, tmpdir: () => state.root || original.tmpdir() };
});

vi.mock('rebrowser-playwright', () => ({
  chromium: { executablePath: () => state.executable },
}));

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 1));
    return child;
  },
  spawnSync: () => {
    mkdirSync(dirname(state.executable), { recursive: true });
    writeFileSync(state.executable, 'extracted browser');
    return { status: 0 };
  },
}));

const platform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (state.root) rmSync(state.root, { recursive: true, force: true });
});

it('installs Chromium from Chrome for Testing when the Windows installer fails', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'bwf-bootstrap-'));
  state.executable = join(state.root, 'chromium-1248', 'chrome-win64', 'chrome.exe');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', state.root);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const archives = new Set([
    'https://cdn.playwright.dev/builds/cft/156.0.8078.4/win64/chrome-win64.zip',
    'https://cdn.playwright.dev/dbazure/download/playwright/builds/winldd/1007/winldd-win64.zip',
  ]);
  vi.stubGlobal('fetch', async (url: string) => new Response('archive', {
    status: archives.has(url) ? 200 : 404,
  }));

  const { ensureChromium } = await import('../src/bootstrap.js');
  await expect(ensureChromium()).resolves.toBeUndefined();
  expect(existsSync(join(state.root, 'chromium-1248', 'INSTALLATION_COMPLETE'))).toBe(true);
  expect(existsSync(join(state.root, 'winldd-1007', 'INSTALLATION_COMPLETE'))).toBe(true);
});

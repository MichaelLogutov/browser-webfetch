// ─────────────────────────────────────────────────────────────────────────────
// HACK / WORKAROUND — remove when no longer needed
//
// playwright-core bundles yauzl/extract-zip into lib/zipBundleImpl.js. On some
// Windows configurations (specifically reported on machines running Kaspersky
// real-time protection and on Node v26, see microsoft/playwright#40724) the
// bundled yauzl hangs indefinitely after the Chromium zip download completes,
// blocking the install. The upstream fix is in yauzl PR #168, but rebrowser-
// playwright is pinned to playwright-core@1.52 which predates that fix and
// upstream lags behind playwright by several minor versions.
//
// As a workaround, this module:
//   1. Runs `playwright-core install chromium` with a hard timeout.
//   2. On timeout (Windows only), kills the stuck process and falls back to
//      downloading the zip ourselves and extracting via PowerShell's
//      Expand-Archive, which uses .NET System.IO.Compression — a code path
//      that is not affected by the yauzl bug.
//
// Once any of the following happens, this whole file can be reduced to the
// "happy path" (just `spawnSync('playwright-core install chromium')`):
//   - rebrowser-playwright tracks a playwright-core version that includes the
//     yauzl fix, OR
//   - we drop rebrowser-playwright in favour of stock playwright + manual
//     stealth args.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'rebrowser-playwright';
import { logger } from './logger.js';

const require_ = createRequire(import.meta.url);

// Hard timeout for playwright's native installer. Real download+extract on a
// normal machine takes 30-90 seconds; anything past 4 minutes is almost
// certainly the yauzl/extract-zip hang seen on some Windows configurations.
const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 4 * 60 * 1000;

let ensurePromise: Promise<void> | null = null;

export function ensureChromium(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = run();
  return ensurePromise;
}

async function run(): Promise<void> {
  const exe = chromium.executablePath();
  if (exe && existsSync(exe)) return;

  printFirstRunBanner();

  if (await tryPlaywrightInstall()) {
    process.stderr.write('\n[browser-webfetch] Chromium installed. Continuing...\n\n');
    return;
  }

  if (process.platform === 'win32') {
    process.stderr.write(
      '\n[browser-webfetch] playwright install did not complete cleanly. Falling back\n',
    );
    process.stderr.write(
      '[browser-webfetch] to manual download + PowerShell Expand-Archive (workaround\n',
    );
    process.stderr.write(
      '[browser-webfetch] for yauzl/extract-zip hangs seen on some Windows machines).\n\n',
    );
    await manualInstallWindows();
    if (existsSync(exe)) {
      process.stderr.write(
        '\n[browser-webfetch] Chromium installed via manual fallback. Continuing...\n\n',
      );
      return;
    }
  }

  throw new Error(
    'Chromium install failed. Try running `npx playwright-core install chromium` ' +
      'manually, or report the issue at ' +
      'https://github.com/MichaelLogutov/browser-webfetch/issues',
  );
}

function printFirstRunBanner(): void {
  const sep = '─'.repeat(64);
  process.stderr.write(`\n${sep}\n`);
  process.stderr.write('[browser-webfetch] First-run setup: Chromium is not installed yet.\n');
  process.stderr.write('[browser-webfetch] Downloading (~150 MB) and extracting now — this is a\n');
  process.stderr.write('[browser-webfetch] one-time step that typically takes 1-2 minutes.\n');
  process.stderr.write('[browser-webfetch] Please DO NOT interrupt; there is no progress output\n');
  process.stderr.write('[browser-webfetch] between the download finishing and extraction completing.\n');
  process.stderr.write(`${sep}\n\n`);
}

async function tryPlaywrightInstall(): Promise<boolean> {
  const cliPath = join(dirname(require_.resolve('playwright-core/package.json')), 'cli.js');

  return new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      stdio: 'inherit',
    });
    const timeout = setTimeout(() => {
      logger.warn('playwright install exceeded timeout, killing', {
        timeoutMs: PLAYWRIGHT_INSTALL_TIMEOUT_MS,
      });
      // On Windows, .kill('SIGKILL') maps to TerminateProcess — sufficient
      // to break out of a yauzl-stuck child. The orphaned download/extract
      // worker processes also die when the parent does.
      child.kill('SIGKILL');
      resolve(false);
    }, PLAYWRIGHT_INSTALL_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error('playwright install spawn error', { err: err.message });
      resolve(false);
    });
  });
}

interface BrowsersJson {
  browsers: Array<{ name: string; revision: string; browserVersion: string }>;
}

async function manualInstallWindows(): Promise<void> {
  const playwrightDir = dirname(require_.resolve('playwright-core/package.json'));
  const browsers = require_(join(playwrightDir, 'browsers.json')) as BrowsersJson;
  const chromiumEntry = browsers.browsers.find((b) => b.name === 'chromium');
  if (!chromiumEntry) throw new Error('chromium entry not found in browsers.json');

  const revision = chromiumEntry.revision;
  const url = `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-win64.zip`;
  const installRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'ms-playwright');
  const installDir = join(installRoot, `chromium-${revision}`);
  const zipPath = join(tmpdir(), `browser-webfetch-chromium-${revision}.zip`);

  process.stderr.write(`[browser-webfetch] Downloading ${url}\n`);
  await downloadFile(url, zipPath);

  process.stderr.write(`[browser-webfetch] Extracting via PowerShell to ${installDir}\n`);
  await mkdir(installDir, { recursive: true });

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`,
    ],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    throw new Error(
      `PowerShell Expand-Archive exited with code ${result.status ?? result.signal ?? 'unknown'}`,
    );
  }

  // Marker file playwright writes after a successful install. Without it
  // playwright considers the browser missing and re-attempts the broken
  // install on every subsequent launch.
  await writeFile(join(installDir, 'INSTALLATION_COMPLETE'), '');
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buffer);
}

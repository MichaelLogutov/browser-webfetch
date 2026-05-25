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
//      downloading each required component zip ourselves and extracting via
//      PowerShell's Expand-Archive, which uses .NET System.IO.Compression —
//      a code path that is not affected by the yauzl bug.
//
// "Required components" on Windows = chromium + winldd. winldd is a tiny
// Windows-only helper (PrintDeps.exe) that playwright invokes during launch
// validation to check chrome.exe's DLL dependencies; without it, every
// launch fails with "Executable doesn't exist at ...\winldd-*\PrintDeps.exe"
// even if chromium itself is installed.
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

const REQUIRED_COMPONENTS_WIN32 = ['chromium', 'winldd'] as const;

interface BrowsersJson {
  browsers: Array<{ name: string; revision: string }>;
}

let ensurePromise: Promise<void> | null = null;

export function ensureChromium(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = run();
  return ensurePromise;
}

async function run(): Promise<void> {
  if (allRequiredPresent()) return;

  printFirstRunBanner();

  if (await tryPlaywrightInstall() && allRequiredPresent()) {
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
    if (allRequiredPresent()) {
      process.stderr.write(
        '\n[browser-webfetch] Installed via manual fallback. Continuing...\n\n',
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

function getInstallRoot(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') {
    const local =
      process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
    return join(local, 'ms-playwright');
  }
  // mac/linux: only used for our Windows-specific marker-file checks; on
  // those platforms we rely on chromium.executablePath() instead.
  return '';
}

function getBrowsersManifest(): BrowsersJson {
  const playwrightDir = dirname(require_.resolve('playwright-core/package.json'));
  return require_(join(playwrightDir, 'browsers.json')) as BrowsersJson;
}

function allRequiredPresent(): boolean {
  const exe = chromium.executablePath();
  if (!exe || !existsSync(exe)) return false;

  if (process.platform === 'win32') {
    const browsers = getBrowsersManifest();
    for (const name of REQUIRED_COMPONENTS_WIN32) {
      const entry = browsers.browsers.find((b) => b.name === name);
      if (!entry) return false;
      const dir = join(getInstallRoot(), `${name}-${entry.revision}`);
      // INSTALLATION_COMPLETE is the marker playwright writes after a clean
      // install; we write it too in the manual fallback so re-runs short-
      // circuit. Without this check, a partial install (chromium present,
      // winldd missing) would never trigger a retry.
      if (!existsSync(join(dir, 'INSTALLATION_COMPLETE'))) return false;
    }
  }

  return true;
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

async function manualInstallWindows(): Promise<void> {
  const browsers = getBrowsersManifest();
  for (const name of REQUIRED_COMPONENTS_WIN32) {
    const entry = browsers.browsers.find((b) => b.name === name);
    if (!entry) throw new Error(`${name} entry not found in browsers.json`);
    await installComponentWindows(name, entry.revision);
  }
}

async function installComponentWindows(name: string, revision: string): Promise<void> {
  const installDir = join(getInstallRoot(), `${name}-${revision}`);

  if (existsSync(join(installDir, 'INSTALLATION_COMPLETE'))) {
    process.stderr.write(`[browser-webfetch] ${name}-${revision} already installed, skipping.\n`);
    return;
  }

  const url = `https://cdn.playwright.dev/dbazure/download/playwright/builds/${name}/${revision}/${name}-win64.zip`;
  const zipPath = join(tmpdir(), `browser-webfetch-${name}-${revision}.zip`);

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
  // playwright considers the component missing and re-attempts the broken
  // install on every subsequent launch.
  await writeFile(join(installDir, 'INSTALLATION_COMPLETE'), '');
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buffer);
}

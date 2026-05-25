import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'rebrowser-playwright';
import { logger } from './logger.js';

const require_ = createRequire(import.meta.url);

let ensurePromise: Promise<void> | null = null;

export function ensureChromium(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = run();
  return ensurePromise;
}

async function run(): Promise<void> {
  const exe = chromium.executablePath();
  if (exe && existsSync(exe)) return;

  const sep = '─'.repeat(64);
  process.stderr.write(`\n${sep}\n`);
  process.stderr.write('[browser-webfetch] First-run setup: Chromium is not installed yet.\n');
  process.stderr.write('[browser-webfetch] Downloading (~150 MB) and extracting now — this is a\n');
  process.stderr.write('[browser-webfetch] one-time step that typically takes 2-5 minutes (extraction\n');
  process.stderr.write('[browser-webfetch] is slow on Windows due to antivirus scanning).\n');
  process.stderr.write('[browser-webfetch] Please DO NOT interrupt; there is no progress output\n');
  process.stderr.write('[browser-webfetch] between the download finishing and extraction completing.\n');
  process.stderr.write(`${sep}\n\n`);

  // Resolve playwright-core's package directory via its package.json (which
  // is allowed by its `exports` map), then point at `cli.js` at the root.
  // We can't `require('playwright-core/cli.js')` directly because cli.js is
  // not listed in `exports`, but we don't need to — we just spawn it.
  // We also can't rely on a `playwright-core` binary on PATH because npm
  // only links the bins of the directly-installed package globally, not of
  // nested deps.
  const cliPath = join(dirname(require_.resolve('playwright-core/package.json')), 'cli.js');

  const result = spawnSync(process.execPath, [cliPath, 'install', 'chromium'], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    const code = result.status ?? result.signal ?? 'unknown';
    logger.error('chromium install failed', { code });
    throw new Error(
      `Chromium install failed (exit ${code}). ` +
        'Try running `npx playwright-core install chromium` manually, or ' +
        'switch to Node 22 LTS / 24 LTS if you are on a bleeding-edge Node release.',
    );
  }

  process.stderr.write('\n[browser-webfetch] Chromium installed. Continuing...\n\n');
}

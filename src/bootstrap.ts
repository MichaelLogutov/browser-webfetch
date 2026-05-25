import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from 'rebrowser-playwright';
import { logger } from './logger.js';

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

  const result = spawnSync('playwright-core', ['install', 'chromium'], {
    stdio: 'inherit',
    shell: true,
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

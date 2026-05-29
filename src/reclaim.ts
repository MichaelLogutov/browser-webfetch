import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Persistent-profile lock handling.
//
// A persistent launch (launchPersistentContext) fails with
//   "Target page, context or browser has been closed"
// whenever a *stale* Chromium still holds the same --user-data-dir. The new
// chrome.exe detects the existing session via the Windows process-singleton,
// prints "Opening in existing browser session.", and exits immediately — so the
// --remote-debugging-pipe never comes up and playwright cannot attach.
//
// Those stale processes are orphans from a previous run that was hard-killed
// (the MCP host SIGKILLs the server, the terminal is closed, a crash) before
// playwright could tear the browser tree down. Worse, playwright itself SKIPS
// its taskkill when the main process exited on its own (processLauncher.js:
// `if (... && !processClosed)`), so a first failure leaves a tree of GPU /
// utility / crashpad helpers that keep the profile locked. From then on every
// launch to that profile fails the same way — a self-sustaining trap.
//
// We break the trap in two ways:
//   • isProfileLocked() — a NATIVE detector (no child process) so the caller can
//     skip a doomed persistent launch and fall back to a throwaway profile.
//   • reclaimProfile() — an OPT-IN killer that frees the persistent profile so
//     it (and its saved logins) can be reused. It needs WMI to match Chromium
//     by --user-data-dir, which means spawning PowerShell — a pattern some
//     endpoint-security suites (e.g. Kaspersky Adaptive Anomaly Control) block
//     when a script process launches it. So it is off unless explicitly enabled.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether opt-in profile reclaim is enabled (BROWSER_WEBFETCH_RECLAIM=1). Off by
 * default because the reclaim spawns PowerShell, which is blocked (and pops an
 * alert) under some locked-down AV policies. Enable it on machines where the AV
 * permits node→PowerShell to recover the persistent profile after a crash.
 */
export function reclaimEnabled(): boolean {
  const v = process.env.BROWSER_WEBFETCH_RECLAIM;
  return v === '1' || v === 'true';
}

/**
 * Native, child-process-free check for whether a live Chromium still holds the
 * persistent profile. Chromium keeps an exclusive OS lock on
 * `<profileDir>/lockfile` for the whole browser lifetime, so if the file exists
 * but cannot be opened, the profile is busy. A missing lockfile means a fresh or
 * cleanly-released profile.
 */
export function isProfileLocked(profileDir: string): boolean {
  const lock = join(profileDir, 'lockfile');
  if (!existsSync(lock)) return false;
  try {
    closeSync(openSync(lock, 'r+'));
    return false;
  } catch {
    return true;
  }
}

/** Poll (natively) until the profile is free, or the deadline passes. */
export async function waitForProfileFree(profileDir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProfileLocked(profileDir)) return true;
    if (Date.now() >= deadline) return false;
    await delay(150);
  }
}

/**
 * OPT-IN (see reclaimEnabled). Force-kill every Chromium process that still
 * holds `profileDir` as its `--user-data-dir`, returning the number of holder
 * processes found and attacked (0 when none / not on Windows / enumeration
 * blocked).
 *
 * NB: taskkill's exit code is deliberately ignored — `taskkill /T /F` tears down
 * the whole tree but returns NON-ZERO whenever a transient descendant already
 * exited, so its status is useless as a success signal. Success is confirmed by
 * the caller via waitForProfileFree() / isProfileLocked() instead.
 */
export function reclaimProfile(profileDir: string): number {
  if (process.platform !== 'win32') return 0;

  const pids = findChromePidsHoldingProfile(profileDir);
  if (pids.length === 0) return 0;

  for (const pid of pids) {
    // /T kills the whole tree, so later iterations on already-dead children are
    // harmless no-ops.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  }

  logger.warn('reclaimed persistent profile from stale chromium processes', {
    profileDir,
    holders: pids.length,
  });
  return pids.length;
}

function findChromePidsHoldingProfile(profileDir: string): number[] {
  // Match `--user-data-dir=<profileDir>` case-insensitively inside the full
  // command line. .Contains() (not -like) avoids treating [] ? * in the path as
  // wildcards; single quotes are doubled to stay inside the PS string literal.
  const needle = `--user-data-dir=${profileDir}`.toLowerCase().replace(/'/g, "''");
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}') } | ` +
    `Select-Object -ExpandProperty ProcessId`;

  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  );
  if (res.status !== 0 || !res.stdout) return [];

  const pids: number[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { chromium, type BrowserContext, type Page } from 'rebrowser-playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sweepOldDownloads } from './download.js';
import { logger } from './logger.js';
import { ensureChromium } from './bootstrap.js';
import {
  crashReportCount,
  deleteProfile,
  isProfileLocked,
  reclaimEnabled,
  reclaimProfile,
  waitForNewCrashReport,
  waitForProfileFree,
} from './reclaim.js';
import { BwfError, ErrorCode, buildLaunchFailureMessage } from './errors.js';

export interface BrowserSingletonOptions {
  profileDir: string;
  idleTimeoutMs: number;
  windowPosition?: { x: number; y: number };
  windowSize?: { width: number; height: number };
  startMinimized?: boolean;
  downloadDir?: string;
}

export class BrowserSingleton {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeOps = 0;
  private didSweep = false;
  private ephemeralProfileDir: string | null = null;
  // A free, reusable tab kept open between fetches. Seeded with the context's
  // launch tab so the first fetch reuses it instead of opening a second tab,
  // and re-parked on release so the persistent browser never drops to zero
  // pages (which would close it and force a relaunch). null while in use.
  private parkedPage: Page | null = null;

  constructor(private readonly opts: BrowserSingletonOptions) {}

  async withContext<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    const ctx = await this.ensureContext();
    this.beginActivity();
    try {
      return await fn(ctx);
    } finally {
      this.endActivity();
    }
  }

  async acquireTab(): Promise<Page> {
    const ctx = await this.ensureContext();
    this.beginActivity();
    try {
      return await this.reuseOrOpenTab(ctx);
    } catch (err) {
      this.endActivity();
      throw err;
    }
  }

  /**
   * Reuse the single parked tab when one is free; otherwise (first use of a
   * fresh context, or a concurrent acquire) open a new one. The parked tab is
   * reset to about:blank first so a prior fetch's leftover navigation — a loaded
   * page or, crucially, a lingering error-page commit from a failed goto — can't
   * interrupt the caller's own goto.
   */
  private async reuseOrOpenTab(ctx: BrowserContext): Promise<Page> {
    const parked = this.parkedPage;
    this.parkedPage = null;
    if (!parked || parked.isClosed()) return ctx.newPage();
    try {
      await parked.goto('about:blank', { waitUntil: 'commit' });
      return parked;
    } catch {
      // The parked tab is wedged — open a fresh one and discard it. Create the
      // new tab first so the persistent browser never drops to zero pages.
      const fresh = await ctx.newPage();
      await parked.close().catch(() => undefined);
      return fresh;
    }
  }

  async unminimize(page: Page): Promise<void> {
    await this.applyWindowBounds(page, { windowState: 'normal' });
    // A minimized window was launched off-screen to avoid a flash; restoring it
    // to 'normal' brings it back at that off-screen position, so move it onto
    // the visible desktop. (Two calls: bounds can't be set while minimized.)
    if (this.opts.startMinimized !== false) {
      await this.applyWindowBounds(page, this.visibleBounds());
    }
  }

  private async minimize(page: Page): Promise<void> {
    await this.applyWindowBounds(page, { windowState: 'minimized' });
  }

  // --start-minimized is not a real Chromium switch (only --start-maximized /
  // --start-fullscreen exist), so window placement is driven over CDP instead.
  private async applyWindowBounds(page: Page, bounds: Record<string, unknown>): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page);
      try {
        const win = (await cdp.send('Browser.getWindowForTarget')) as {
          windowId: number;
          bounds: Record<string, unknown>;
        };
        await cdp.send('Browser.setWindowBounds', {
          windowId: win.windowId,
          bounds,
        });
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch (err) {
      logger.warn('set window bounds failed', {
        bounds,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async releaseTab(page: Page): Promise<void> {
    try {
      if (page.isClosed()) return;
      // Keep one tab alive and reusable instead of closing the last page (which
      // would close the persistent browser and force a relaunch). Park this page
      // if no parked tab is held; any extra tab (concurrent overflow) is closed.
      // The next fetch's goto overwrites the parked tab's leftover content.
      if (this.parkedPage && !this.parkedPage.isClosed()) {
        await page.close();
        return;
      }
      this.parkedPage = page;
    } finally {
      this.endActivity();
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      if (this.launching) {
        try {
          const ctx = await this.launching;
          await ctx.close();
        } catch {
          // launch failed — nothing to close
        }
        this.launching = null;
        this.context = null;
        return;
      }
      if (this.context) {
        const ctx = this.context;
        this.context = null;
        // The browser may already be gone — e.g. in interactive mode the user
        // closed the single tab, which exits the persistent browser. Tolerate it.
        await ctx.close().catch(() => undefined);
      }
    } finally {
      this.cleanupEphemeralProfile();
    }
  }

  private beginActivity(): void {
    this.activeOps++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private endActivity(): void {
    this.activeOps = Math.max(0, this.activeOps - 1);
    this.scheduleIdleShutdown();
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launchContext();
    try {
      this.context = await this.launching;
      return this.context;
    } finally {
      this.launching = null;
    }
  }

  private async launchContext(): Promise<BrowserContext> {
    await ensureChromium();
    const startMinimized = this.opts.startMinimized !== false;
    const args = this.buildLaunchArgs(startMinimized);

    logger.info('launching browser', {
      profileDir: this.opts.profileDir,
      startMinimized,
    });

    const ctx = await this.launchWithRecovery(args);
    // Reuse the context's launch tab for the first fetch instead of opening a
    // second tab beside it.
    this.parkedPage = ctx.pages()[0] ?? null;

    // Minimize via CDP (the --start-minimized switch is a no-op). A login,
    // captcha, or interactive step restores the window when it needs attention.
    if (startMinimized && this.parkedPage) await this.minimize(this.parkedPage);

    // Real Chrome exposes `window.chrome.runtime` as an object; non-extension
    // Chromium builds leave it undefined, which bot-detection scripts flag.
    await ctx.addInitScript(() => {
      const w = window as unknown as { chrome?: { runtime?: unknown } };
      w.chrome = w.chrome ?? {};
      w.chrome.runtime = w.chrome.runtime ?? {};
    });

    ctx.on('close', () => {
      this.context = null;
      this.parkedPage = null;
    });

    if (!this.didSweep && this.opts.downloadDir) {
      this.didSweep = true;
      void sweepOldDownloads(this.opts.downloadDir);
    }

    return ctx;
  }

  // Far off any monitor. When starting minimized we launch the window here so it
  // is never visible before CDP minimizes it (the window is shown a frame or two
  // before we can act, and --start-minimized is a no-op) — avoiding a flash.
  private static readonly OFFSCREEN = { x: -32000, y: -32000 };

  private visibleBounds(): { left: number; top: number; width: number; height: number } {
    const pos = this.opts.windowPosition ?? { x: 100, y: 100 };
    const size = this.opts.windowSize ?? { width: 1280, height: 900 };
    return { left: pos.x, top: pos.y, width: size.width, height: size.height };
  }

  private buildLaunchArgs(startMinimized: boolean): string[] {
    const windowArgs: string[] = startMinimized
      ? [`--window-position=${BrowserSingleton.OFFSCREEN.x},${BrowserSingleton.OFFSCREEN.y}`]
      : (() => {
          const b = this.visibleBounds();
          return [`--window-position=${b.left},${b.top}`, `--window-size=${b.width},${b.height}`];
        })();

    // Disables the AutomationControlled blink feature that otherwise sets
    // `navigator.webdriver = true`. rebrowser-playwright handles deeper
    // Runtime.evaluate detection but does not touch this flag.
    const stealthArgs = ['--disable-blink-features=AutomationControlled'];

    return [...windowArgs, ...stealthArgs];
  }

  /**
   * Launch the persistent context, recovering from the most common failure mode:
   * a stale/orphan Chromium still holding the persistent profile, which makes a
   * fresh launch hand off via the Windows singleton and exit before playwright
   * can attach ("Target page, context or browser has been closed").
   *
   * We detect that case NATIVELY (isProfileLocked, no child process) and avoid a
   * doomed launch. When opt-in reclaim is enabled we try to free the profile so
   * its saved logins are reused; otherwise (or if the lock persists) we fall back
   * to a throwaway temporary profile so the fetch still succeeds.
   */
  private async launchWithRecovery(args: string[]): Promise<BrowserContext> {
    const profileDir = this.opts.profileDir;

    if (isProfileLocked(profileDir)) {
      logger.warn(
        'persistent profile is locked by another Chromium process ' +
          '(likely a leftover orphan from a previously killed run)',
        { profileDir, reclaimEnabled: reclaimEnabled() },
      );
      if (reclaimEnabled()) {
        const reclaimed = reclaimProfile(profileDir);
        if (reclaimed > 0) await waitForProfileFree(profileDir, 5_000);
      }
      if (isProfileLocked(profileDir)) {
        return this.launchEphemeralFallback(
          args,
          'persistent profile is locked by another Chromium process',
        );
      }
    }

    const crashesBefore = crashReportCount(profileDir);
    try {
      return await this.openPersistentContext(profileDir, args);
    } catch (err) {
      if (!isProfileDisconnectError(err)) throw err;

      // Tell a CORRUPT profile (chrome crashed → a new Crashpad dump appears)
      // from a transport/AV failure (chrome did not crash → no dump). Only a
      // crash warrants resetting the profile; otherwise fall back to a throwaway.
      const crashed = await waitForNewCrashReport(profileDir, crashesBefore, 3_000);
      if (crashed) {
        const healed = await this.healCorruptProfile(args);
        if (healed) return healed;
        // A fresh profile crashed too → the cause is environmental, not the
        // profile (broken Chromium / AV). Surface the full help message.
        throw this.buildLaunchFailedError(err);
      }
      return this.launchEphemeralFallback(args, err);
    }
  }

  /**
   * Confirm via A/B that the persistent profile — not the environment — is at
   * fault: launch a throwaway profile. If that works, the persistent profile is
   * corrupt, so delete it and relaunch fresh (logins persist again going
   * forward). Returns the new context, or null if a fresh profile ALSO crashes
   * (environmental — the caller surfaces the help message).
   */
  private async healCorruptProfile(args: string[]): Promise<BrowserContext | null> {
    const profileDir = this.opts.profileDir;
    const probeDir = mkdtempSync(join(tmpdir(), 'bwf-probe-'));
    let freshWorks = false;
    try {
      const probe = await this.openPersistentContext(probeDir, args);
      freshWorks = true;
      await probe.close().catch(() => undefined);
    } catch (probeErr) {
      if (!isProfileDisconnectError(probeErr)) {
        rmSync(probeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        throw probeErr;
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }

    if (!freshWorks) return null;

    logger.warn(
      'persistent profile is corrupted (chrome crashed launching it, but a fresh ' +
        'profile works) — deleting and recreating it; saved logins are lost, log in again',
      { profileDir },
    );
    deleteProfile(profileDir);
    try {
      return await this.openPersistentContext(profileDir, args);
    } catch (reErr) {
      // The recreated profile unexpectedly failed too (transient) → throwaway.
      if (!isProfileDisconnectError(reErr)) throw reErr;
      return this.launchEphemeralFallback(args, reErr);
    }
  }

  private openPersistentContext(profileDir: string, args: string[]): Promise<BrowserContext> {
    return chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    });
  }

  /**
   * Last resort when the persistent profile cannot be opened even after a
   * reclaim. A throwaway profile loses saved logins/cookies for this run but
   * lets the fetch succeed instead of failing outright. The temp dir is removed
   * on close(). If even this fails the cause is environmental (AV breaking the
   * pipe, a broken Chromium install), so surface the full help message.
   */
  private async launchEphemeralFallback(args: string[], cause: unknown): Promise<BrowserContext> {
    const ephemeral = mkdtempSync(join(tmpdir(), 'bwf-ephemeral-'));
    logger.warn(
      'falling back to a temporary throwaway profile; saved logins/cookies are ' +
        'unavailable for this run',
      { ephemeralProfileDir: ephemeral, cause: errMessage(cause) },
    );
    try {
      const ctx = await this.openPersistentContext(ephemeral, args);
      this.ephemeralProfileDir = ephemeral;
      return ctx;
    } catch (err) {
      rmSync(ephemeral, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      if (isProfileDisconnectError(err)) throw this.buildLaunchFailedError(cause);
      throw err;
    }
  }

  private buildLaunchFailedError(cause: unknown): BwfError {
    const exePath = chromium.executablePath();
    // chrome.exe lives at <ms-playwright>/chromium-<rev>/chrome-win/chrome.exe;
    // walk up three levels to recover the ms-playwright root.
    const msPlaywrightDir = exePath ? dirname(dirname(dirname(exePath))) : '(unknown)';
    return new BwfError(
      ErrorCode.LAUNCH_FAILED,
      buildLaunchFailureMessage({
        profileDir: this.opts.profileDir,
        msPlaywrightDir,
        originalMessage: errMessage(cause),
      }),
      { profileDir: this.opts.profileDir },
    );
  }

  private cleanupEphemeralProfile(): void {
    if (!this.ephemeralProfileDir) return;
    const dir = this.ephemeralProfileDir;
    this.ephemeralProfileDir = null;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      logger.warn('failed to remove ephemeral profile', { dir, err: errMessage(err) });
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.activeOps > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.info('browser idle timeout reached, closing');
      void this.close();
    }, this.opts.idleTimeoutMs);
  }
}

/**
 * A launch that spawned chrome.exe but lost it before playwright could attach.
 * This is what both an AV-broken pipe handshake and an orphan-locked profile
 * surface as, so it gates the reclaim/retry/fallback recovery path.
 */
function isProfileDisconnectError(err: unknown): boolean {
  return errMessage(err).includes('Target page, context or browser has been closed');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { chromium, type BrowserContext, type Page } from 'rebrowser-playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sweepOldDownloads } from './download.js';
import { logger } from './logger.js';
import { ensureChromium } from './bootstrap.js';
import { isProfileLocked, reclaimEnabled, reclaimProfile, waitForProfileFree } from './reclaim.js';
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
      return await ctx.newPage();
    } catch (err) {
      this.endActivity();
      throw err;
    }
  }

  async unminimize(page: Page): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page);
      try {
        const win = (await cdp.send('Browser.getWindowForTarget')) as {
          windowId: number;
          bounds: Record<string, unknown>;
        };
        await cdp.send('Browser.setWindowBounds', {
          windowId: win.windowId,
          bounds: { windowState: 'normal' },
        });
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch (err) {
      logger.warn('unminimize failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  async releaseTab(page: Page): Promise<void> {
    try {
      if (!page.isClosed()) await page.close();
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
        await ctx.close();
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

    // Real Chrome exposes `window.chrome.runtime` as an object; non-extension
    // Chromium builds leave it undefined, which bot-detection scripts flag.
    await ctx.addInitScript(() => {
      const w = window as unknown as { chrome?: { runtime?: unknown } };
      w.chrome = w.chrome ?? {};
      w.chrome.runtime = w.chrome.runtime ?? {};
    });

    ctx.on('close', () => {
      this.context = null;
    });

    if (!this.didSweep && this.opts.downloadDir) {
      this.didSweep = true;
      void sweepOldDownloads(this.opts.downloadDir);
    }

    return ctx;
  }

  private buildLaunchArgs(startMinimized: boolean): string[] {
    const windowArgs: string[] = startMinimized
      ? ['--start-minimized']
      : (() => {
          const pos = this.opts.windowPosition ?? { x: 100, y: 100 };
          const size = this.opts.windowSize ?? { width: 1280, height: 900 };
          return [
            `--window-position=${pos.x},${pos.y}`,
            `--window-size=${size.width},${size.height}`,
          ];
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

    try {
      return await this.openPersistentContext(profileDir, args);
    } catch (err) {
      // A disconnect even though the profile was free points at something
      // environmental (AV breaking the DevTools pipe, a corrupted profile, a
      // race). A throwaway profile sidesteps profile corruption and lets the
      // fetch proceed; if it still fails the cause is surfaced with full help.
      if (!isProfileDisconnectError(err)) throw err;
      return this.launchEphemeralFallback(args, err);
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

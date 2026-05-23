import { chromium as playwrightChromium, type BrowserContext, type Page } from 'playwright';
import { chromium as extraChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { sweepOldDownloads } from './download.js';
import { logger } from './logger.js';

extraChromium.use(StealthPlugin());

export interface BrowserSingletonOptions {
  profileDir: string;
  idleTimeoutMs: number;
  disableStealth?: boolean;
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
    const launcher = this.opts.disableStealth ? playwrightChromium : extraChromium;
    const startMinimized = this.opts.startMinimized !== false;
    const args: string[] = startMinimized
      ? ['--start-minimized']
      : (() => {
          const pos = this.opts.windowPosition ?? { x: 100, y: 100 };
          const size = this.opts.windowSize ?? { width: 1280, height: 900 };
          return [
            `--window-position=${pos.x},${pos.y}`,
            `--window-size=${size.width},${size.height}`,
          ];
        })();

    logger.info('launching browser', {
      profileDir: this.opts.profileDir,
      startMinimized,
    });

    const ctx = await launcher.launchPersistentContext(this.opts.profileDir, {
      headless: false,
      viewport: null,
      args,
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

  private scheduleIdleShutdown(): void {
    if (this.activeOps > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.info('browser idle timeout reached, closing');
      void this.close();
    }, this.opts.idleTimeoutMs);
  }
}

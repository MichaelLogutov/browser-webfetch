import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BrowserSingleton } from './browser.js';
import { FifoQueue } from './queue.js';
import { fetchUrl } from './fetch.js';
import { BwfError, ErrorCode } from './errors.js';
import { resolveDownloadDir } from './download.js';
import { resolveProfileDir, profileDirForChannel } from './profile.js';
import { resolveChannel, type BrowserChannel } from './channel.js';
import { logger } from './logger.js';
import type { OutputFormat } from './extract.js';

export async function runMcpServer(): Promise<void> {
  const downloadDir = resolveDownloadDir();
  const baseProfileDir = resolveProfileDir();
  const queue = new FifoQueue({ queueTimeoutMs: 30_000 });

  // One reusable browser per channel (each with its own profile). The server
  // tears the browser down after every call, so this map just caches the
  // singleton objects; the underlying browser is relaunched on next use.
  const browsers = new Map<BrowserChannel, BrowserSingleton>();
  const browserFor = (channel: BrowserChannel): BrowserSingleton => {
    let b = browsers.get(channel);
    if (!b) {
      b = new BrowserSingleton({
        profileDir: profileDirForChannel(baseProfileDir, channel),
        idleTimeoutMs: 300_000,
        startMinimized: true,
        channel,
        downloadDir,
      });
      browsers.set(channel, b);
    }
    return b;
  };

  const server = new Server(
    { name: 'browser-webfetch', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'browser_fetch',
        description:
          'Fetch a URL through a real headed Chromium with stealth patches and a persistent profile. USE THIS AS A FALLBACK FOR THE BUILT-IN WebFetch whenever WebFetch is blocked or returns something unusable, specifically: (a) any HTTP error other than 404 (403, 429, 503, 5xx, network/TLS errors, timeouts); (b) a response that looks like an anti-bot / WAF / DDoS-protection challenge or interstitial — Cloudflare ("Just a moment...", "Checking your browser"), Servicepipe, DataDome, PerimeterX, Akamai Bot Manager, Imperva/Incapsula, Qrator, Kaspersky Anti-DDoS, etc. — even when the HTTP status is 200; (c) a captcha (reCAPTCHA, hCaptcha, Turnstile, Yandex SmartCaptcha, FunCaptcha); (d) a near-empty body or a JS-only shell where the real content is rendered client-side; (e) a page that requires a logged-in session (the browser profile persists across runs, so a one-time manual login is enough). If a captcha is detected, the Chromium window surfaces and waits for the user to solve it interactively, then continues. For non-HTML URLs (PDFs, images, binaries), set `download: true` to save the bytes to disk; the response is the absolute file path. If `download` is omitted and the URL turns out to be non-HTML, the tool auto-downloads and returns the path (a warning is logged). If a fetch returns a login / SSO / sign-in page (often a redirect to accounts.google.com, login.microsoftonline.com, etc.), retry the SAME url with `interactive: true`: the Chromium window is surfaced for the user to log in, and after they close it the real content is returned. The login persists in the profile, so later fetches of that site succeed without `interactive`. By default the response is a reader-mode Markdown extract (Mozilla Readability) that intentionally strips navigation and boilerplate; on non-article pages it can also omit secondary structured content such as spec/ingredient tables, product attributes, tab panels and collapsed accordions, so the `markdown` (and `text`) output may be incomplete. If the rendered page clearly contains data that is missing from the `markdown`/`text` output, retry the SAME url with `format: html` to get the full raw rendered DOM and read the value from there (`html` can be large for content-heavy pages, so grep for the part you need).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
            format: {
              type: 'string',
              enum: ['markdown', 'html', 'text'],
              description:
                'Output format (default: markdown). `markdown` and `text` are a reader-mode extract (Mozilla Readability): they strip navigation/boilerplate and may also omit secondary structured sections (spec/ingredient tables, product attributes, tab panels, collapsed accordions). If expected data is missing from `markdown`/`text`, refetch the same url with `html` to get the full raw rendered DOM. `html` can be large for content-heavy pages.',
            },
            wait_for: { type: 'string', description: 'CSS selector to wait for before snapshot' },
            manual_timeout: {
              type: 'number',
              description: 'Seconds to wait for manual captcha solve (default: 300)',
            },
            download: {
              type: 'boolean',
              description:
                'If true, skip page rendering and download raw bytes (PDF/image/binary) to disk. Response is the absolute file path. Default: false.',
            },
            interactive: {
              type: 'boolean',
              description:
                'Force the interactive flow: surface the Chromium window and wait for the user to finish (e.g. log in) and CLOSE the tab, then return the last page content. Use when a response looks like a login/SSO page or otherwise needs the user to act. Default: false.',
            },
            browser: {
              type: 'string',
              enum: ['chrome', 'msedge', 'chromium'],
              description:
                "Which browser to launch. Default 'chrome' (the real installed Google Chrome) already clears strict anti-bots (Qrator, DataDome, etc.) via its genuine TLS fingerprint, so usually leave this unset. Set it only to: 'chromium' = the self-contained bundled build (faster, no system browser needed, but more likely to be blocked) for simple sites where speed matters; 'msedge' = real Microsoft Edge, e.g. if a site still blocks Chrome or Chrome isn't installed. Falls back automatically when the requested binary is missing.",
            },
          },
          required: ['url'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'browser_fetch') {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as {
      url?: string;
      format?: string;
      wait_for?: string;
      manual_timeout?: number;
      download?: boolean;
      interactive?: boolean;
      browser?: string;
    };
    if (!args.url) {
      throw new BwfError(ErrorCode.INVALID_ARGS, 'url is required');
    }
    const format = (args.format ?? 'markdown') as OutputFormat;
    if (!['markdown', 'html', 'text'].includes(format)) {
      throw new BwfError(ErrorCode.INVALID_ARGS, `invalid format: ${format}`);
    }
    const channel = resolveChannel(args.browser);
    const browser = browserFor(channel);
    try {
      const result = await fetchUrl({
        url: args.url,
        format,
        waitFor: args.wait_for,
        navTimeoutMs: 30_000,
        manualTimeoutMs: (args.manual_timeout ?? 300) * 1000,
        download: args.download === true,
        interactive: args.interactive === true,
        downloadDir,
        browser,
        queue,
      });
      return {
        content: [{ type: 'text', text: result.body }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof BwfError ? err.code : ErrorCode.INTERNAL;
      logger.error('tool call failed', { code, msg });
      return {
        content: [{ type: 'text', text: `Error (${code}): ${msg}` }],
        isError: true,
      };
    } finally {
      await browser.close().catch((err) => {
        logger.warn('post-call browser close failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await Promise.all([...browsers.values()].map((b) => b.close().catch(() => undefined)));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
}

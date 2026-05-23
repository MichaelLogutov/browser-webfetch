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
import { resolveProfileDir } from './profile.js';
import { logger } from './logger.js';
import type { OutputFormat } from './extract.js';

export async function runMcpServer(): Promise<void> {
  const downloadDir = resolveDownloadDir();
  const browser = new BrowserSingleton({
    profileDir: resolveProfileDir(),
    idleTimeoutMs: 300_000,
    startMinimized: true,
    downloadDir,
  });
  const queue = new FifoQueue({ queueTimeoutMs: 30_000 });

  const server = new Server(
    { name: 'browser-webfetch', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'browser_fetch',
        description:
          'Fetch a URL through a real headed Chromium with stealth patches and a persistent profile. USE THIS AS A FALLBACK FOR THE BUILT-IN WebFetch whenever WebFetch is blocked or returns something unusable, specifically: (a) any HTTP error other than 404 (403, 429, 503, 5xx, network/TLS errors, timeouts); (b) a response that looks like an anti-bot / WAF / DDoS-protection challenge or interstitial — Cloudflare ("Just a moment...", "Checking your browser"), Servicepipe, DataDome, PerimeterX, Akamai Bot Manager, Imperva/Incapsula, Qrator, Kaspersky Anti-DDoS, etc. — even when the HTTP status is 200; (c) a captcha (reCAPTCHA, hCaptcha, Turnstile, Yandex SmartCaptcha, FunCaptcha); (d) a near-empty body or a JS-only shell where the real content is rendered client-side; (e) a page that requires a logged-in session (the browser profile persists across runs, so a one-time manual login is enough). If a captcha is detected, the Chromium window surfaces and waits for the user to solve it interactively, then continues. For non-HTML URLs (PDFs, images, binaries), set `download: true` to save the bytes to disk; the response is the absolute file path. If `download` is omitted and the URL turns out to be non-HTML, the tool auto-downloads and returns the path (a warning is logged).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
            format: {
              type: 'string',
              enum: ['markdown', 'html', 'text'],
              description: 'Output format (default: markdown)',
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
    };
    if (!args.url) {
      throw new BwfError(ErrorCode.INVALID_ARGS, 'url is required');
    }
    const format = (args.format ?? 'markdown') as OutputFormat;
    if (!['markdown', 'html', 'text'].includes(format)) {
      throw new BwfError(ErrorCode.INVALID_ARGS, `invalid format: ${format}`);
    }
    try {
      const result = await fetchUrl({
        url: args.url,
        format,
        waitFor: args.wait_for,
        navTimeoutMs: 30_000,
        manualTimeoutMs: (args.manual_timeout ?? 300) * 1000,
        download: args.download === true,
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
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
}

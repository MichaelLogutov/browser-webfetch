import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'rebrowser-playwright';
import { BrowserSingleton } from '../../src/browser.js';
import { downloadToFile } from '../../src/download.js';
import { fetchUrl } from '../../src/fetch.js';
import { FifoQueue } from '../../src/queue.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake-pdf-bytes\n%%EOF\n');

let server: Server;
let port: number;
let tmpProfile: string;
let tmpDownloads: string;
let browser: BrowserSingleton;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/file.pdf') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(PDF_BYTES.length),
      });
      res.end(PDF_BYTES);
      return;
    }
    if (req.url === '/named') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="custom-name.pdf"',
      });
      res.end(PDF_BYTES);
      return;
    }
    if (req.url === '/attachment') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="attach-name.pdf"',
        'Content-Length': String(PDF_BYTES.length),
      });
      res.end(PDF_BYTES);
      return;
    }
    if (req.url === '/challenge') {
      const html =
        '<!DOCTYPE html><html><head><title>Loading</title></head><body>please wait</body></html>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(html)),
      });
      res.end(html);
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-dl-prof-'));
  tmpDownloads = mkdtempSync(join(tmpdir(), 'bwf-dl-out-'));
  browser = new BrowserSingleton({ profileDir: tmpProfile, idleTimeoutMs: 60_000 });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpProfile, { recursive: true, force: true });
  rmSync(tmpDownloads, { recursive: true, force: true });
});

async function runWithCtx<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  const tab = await browser.acquireTab();
  try {
    return await fn(tab.context());
  } finally {
    await browser.releaseTab(tab);
  }
}

describe('downloadToFile (integration)', () => {
  it('saves bytes to disk and returns path/size/contentType', async () => {
    const result = await runWithCtx((ctx) =>
      downloadToFile(ctx, `http://127.0.0.1:${port}/file.pdf`, tmpDownloads, 10_000),
    );
    expect(result.contentType.startsWith('application/pdf')).toBe(true);
    expect(result.size).toBe(PDF_BYTES.length);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path)).toEqual(PDF_BYTES);
    expect(result.path.endsWith('file.pdf')).toBe(true);
  });

  it('uses Content-Disposition filename', async () => {
    const result = await runWithCtx((ctx) =>
      downloadToFile(ctx, `http://127.0.0.1:${port}/named`, tmpDownloads, 10_000),
    );
    expect(result.path.endsWith('custom-name.pdf')).toBe(true);
  });

  it('throws NAV_ERROR on non-2xx', async () => {
    await expect(
      runWithCtx((ctx) =>
        downloadToFile(ctx, `http://127.0.0.1:${port}/missing`, tmpDownloads, 10_000),
      ),
    ).rejects.toMatchObject({ code: 'NAV_ERROR' });
  });

  it('guards against saving an HTML challenge as a file', async () => {
    await expect(
      runWithCtx((ctx) =>
        downloadToFile(ctx, `http://127.0.0.1:${port}/challenge`, tmpDownloads, 10_000),
      ),
    ).rejects.toMatchObject({ code: 'NAV_ERROR' });
  });
});

describe('download via browser (fetchUrl download:true, integration)', () => {
  const queue = new FifoQueue({ queueTimeoutMs: 30_000 });

  const download = (path: string) =>
    fetchUrl({
      url: `http://127.0.0.1:${port}${path}`,
      format: 'markdown',
      navTimeoutMs: 15_000,
      manualTimeoutMs: 15_000,
      download: true,
      downloadDir: tmpDownloads,
      browser,
      queue,
    });

  it('captures a browser-triggered attachment download and saves the bytes', async () => {
    const result = await download('/attachment');
    expect(existsSync(result.body)).toBe(true);
    expect(readFileSync(result.body)).toEqual(PDF_BYTES);
    expect(result.body.endsWith('attach-name.pdf')).toBe(true);
  });

  it('saves an inline PDF through the warmed browser context', async () => {
    const result = await download('/file.pdf');
    expect(existsSync(result.body)).toBe(true);
    expect(readFileSync(result.body)).toEqual(PDF_BYTES);
  });

  it('refuses to save an HTML challenge as a file', async () => {
    await expect(download('/challenge')).rejects.toMatchObject({ code: 'NAV_ERROR' });
  });
});

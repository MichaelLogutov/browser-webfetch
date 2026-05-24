import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'rebrowser-playwright';
import { BrowserSingleton } from '../../src/browser.js';
import { downloadToFile } from '../../src/download.js';

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
});

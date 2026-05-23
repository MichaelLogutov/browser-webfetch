import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSingleton } from '../../src/browser.js';
import { FifoQueue } from '../../src/queue.js';
import { fetchUrl } from '../../src/fetch.js';

const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-fetch-'));
const downloadsDir = mkdtempSync(join(tmpdir(), 'bwf-fetch-dl-'));
const browser = new BrowserSingleton({ profileDir: tmpProfile, idleTimeoutMs: 60_000 });
const queue = new FifoQueue({ queueTimeoutMs: 30_000 });

const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake\n%%EOF\n');
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/file.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(PDF_BYTES);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpProfile, { recursive: true, force: true });
  rmSync(downloadsDir, { recursive: true, force: true });
});

describe('fetchUrl (integration)', () => {
  it('fetches example.com and returns markdown', async () => {
    const result = await fetchUrl({
      url: 'https://example.com',
      format: 'markdown',
      navTimeoutMs: 20_000,
      manualTimeoutMs: 5_000,
      downloadDir: downloadsDir,
      browser,
      queue,
    });
    expect(result.body).toContain('Example Domain');
    expect(result.finalUrl).toMatch(/https:\/\/example\.com\/?/);
  });

  it('returns NAV_ERROR for invalid host', async () => {
    await expect(
      fetchUrl({
        url: 'https://this-host-should-not-resolve-bwf-test.invalid',
        format: 'markdown',
        navTimeoutMs: 5_000,
        manualTimeoutMs: 5_000,
        downloadDir: downloadsDir,
        browser,
        queue,
      }),
    ).rejects.toMatchObject({ code: 'NAV_ERROR' });
  });

  it('with download=true returns absolute path to saved bytes', async () => {
    const result = await fetchUrl({
      url: `http://127.0.0.1:${port}/file.pdf`,
      format: 'markdown',
      navTimeoutMs: 10_000,
      manualTimeoutMs: 5_000,
      download: true,
      downloadDir: downloadsDir,
      browser,
      queue,
    });
    expect(existsSync(result.body)).toBe(true);
    expect(readFileSync(result.body)).toEqual(PDF_BYTES);
    expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/file.pdf`);
  });

  it('auto-downloads when goto returns non-HTML Content-Type', async () => {
    const result = await fetchUrl({
      url: `http://127.0.0.1:${port}/file.pdf`,
      format: 'markdown',
      navTimeoutMs: 10_000,
      manualTimeoutMs: 5_000,
      downloadDir: downloadsDir,
      browser,
      queue,
    });
    expect(existsSync(result.body)).toBe(true);
    expect(readFileSync(result.body)).toEqual(PDF_BYTES);
  });
});

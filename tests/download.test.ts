import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  utimesSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Download } from 'rebrowser-playwright';
import {
  deriveDownloadFilename,
  downloadToFile,
  resolveDownloadDir,
  saveDownloadToFile,
  sweepOldDownloads,
} from '../src/download.js';

const FAKE_PDF = Buffer.from('%PDF-1.4\nfake\n%%EOF\n');

function fakeCtx(headers: Record<string, string>, body: Buffer, status = 200): BrowserContext {
  return {
    request: {
      get: async () => ({
        ok: () => status >= 200 && status < 300,
        status: () => status,
        headers: () => headers,
        body: async () => body,
      }),
    },
  } as unknown as BrowserContext;
}

function fakeDownload(suggested: string, url: string, bytes: Buffer): Download {
  return {
    suggestedFilename: () => suggested,
    url: () => url,
    saveAs: async (dest: string) => writeFileSync(dest, bytes),
  } as unknown as Download;
}

describe('deriveDownloadFilename', () => {
  it('uses Content-Disposition filename when present', () => {
    expect(
      deriveDownloadFilename({
        url: 'https://x/y',
        contentDisposition: 'attachment; filename="report.pdf"',
        contentType: 'application/pdf',
      }),
    ).toBe('report.pdf');
  });

  it('decodes RFC 5987 filename* parameter', () => {
    expect(
      deriveDownloadFilename({
        url: 'https://x/y',
        contentDisposition: "attachment; filename*=UTF-8''foo%20bar.pdf",
        contentType: 'application/pdf',
      }),
    ).toBe('foo_bar.pdf');
  });

  it('falls back to URL basename', () => {
    expect(
      deriveDownloadFilename({
        url: 'https://x/docs/file.pdf?query=1',
        contentType: 'application/pdf',
      }),
    ).toBe('file.pdf');
  });

  it('appends extension from content-type when missing', () => {
    expect(
      deriveDownloadFilename({
        url: 'https://x/no-extension',
        contentType: 'application/pdf',
      }),
    ).toBe('no-extension.pdf');
  });

  it('uses download-<hash> when URL has no basename', () => {
    const name = deriveDownloadFilename({
      url: 'https://x/',
      contentType: 'image/png',
    });
    expect(name).toMatch(/^download-[a-f0-9]{8}\.png$/);
  });

  it('sanitizes path separators and control chars', () => {
    expect(
      deriveDownloadFilename({
        url: 'https://x/y',
        contentDisposition: 'attachment; filename="..\\evil name.pdf"',
        contentType: 'application/pdf',
      }),
    ).toBe('.._evil_name.pdf');
  });

  it('caps overall length at 120 chars while preserving extension', () => {
    const long = 'a'.repeat(200) + '.pdf';
    const name = deriveDownloadFilename({
      url: `https://x/${long}`,
      contentType: 'application/pdf',
    });
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('downloadToFile content guard', () => {
  it('throws NAV_ERROR when the server returns an HTML challenge instead of a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwf-guard-'));
    try {
      const ctx = fakeCtx(
        { 'content-type': 'text/html; charset=utf-8' },
        Buffer.from('<!DOCTYPE html><html><body>js-challenge</body></html>'),
      );
      await expect(downloadToFile(ctx, 'https://x/download/1', dir, 1000)).rejects.toMatchObject({
        code: 'NAV_ERROR',
      });
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves the file when the server returns a real binary content-type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwf-ok-'));
    try {
      const ctx = fakeCtx({ 'content-type': 'application/pdf' }, FAKE_PDF);
      const res = await downloadToFile(ctx, 'https://x/file.pdf', dir, 1000);
      expect(res.contentType).toContain('application/pdf');
      expect(res.size).toBe(FAKE_PDF.length);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('saveDownloadToFile', () => {
  it('saves a captured browser download using its suggested filename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwf-savedl-'));
    try {
      const res = await saveDownloadToFile(
        fakeDownload('report.pdf', 'https://x/download/1', FAKE_PDF),
        dir,
      );
      expect(res.path.endsWith('report.pdf')).toBe(true);
      expect(res.size).toBe(FAKE_PDF.length);
      expect(readFileSync(res.path)).toEqual(FAKE_PDF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives a filename from the URL when none is suggested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwf-savedl2-'));
    try {
      const res = await saveDownloadToFile(
        fakeDownload('', 'https://x/docs/manual.pdf', FAKE_PDF),
        dir,
      );
      expect(res.path.endsWith('manual.pdf')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveDownloadDir', () => {
  it('returns override and creates it if missing', () => {
    const base = mkdtempSync(join(tmpdir(), 'bwf-dl-'));
    const target = join(base, 'nested', 'downloads');
    try {
      const out = resolveDownloadDir(target);
      expect(out).toBe(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('falls back to env-paths cache + "/downloads" when no override and no env', () => {
    delete process.env.BROWSER_WEBFETCH_DOWNLOAD_DIR;
    const out = resolveDownloadDir();
    expect(out.endsWith('downloads')).toBe(true);
    expect(existsSync(out)).toBe(true);
  });

  it('honors BROWSER_WEBFETCH_DOWNLOAD_DIR env', () => {
    const base = mkdtempSync(join(tmpdir(), 'bwf-dl-env-'));
    const target = join(base, 'env-downloads');
    process.env.BROWSER_WEBFETCH_DOWNLOAD_DIR = target;
    try {
      expect(resolveDownloadDir()).toBe(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      delete process.env.BROWSER_WEBFETCH_DOWNLOAD_DIR;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('sweepOldDownloads', () => {
  it('deletes files older than maxAgeMs and keeps fresh ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwf-sweep-'));
    try {
      const old = join(dir, 'old.pdf');
      const fresh = join(dir, 'fresh.pdf');
      writeFileSync(old, 'old');
      writeFileSync(fresh, 'fresh');
      const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
      utimesSync(old, tenDaysAgo, tenDaysAgo);

      await sweepOldDownloads(dir, 7 * 24 * 3600 * 1000);

      expect(readdirSync(dir).sort()).toEqual(['fresh.pdf']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when directory is missing', async () => {
    await expect(
      sweepOldDownloads(join(tmpdir(), 'bwf-nonexistent-' + Date.now())),
    ).resolves.toBeUndefined();
  });
});

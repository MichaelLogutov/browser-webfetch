import { createHash } from 'node:crypto';
import envPaths from 'env-paths';
import { mkdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'rebrowser-playwright';
import { BwfError, ErrorCode } from './errors.js';
import { logger } from './logger.js';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-7z-compressed': '7z',
  'application/octet-stream': 'bin',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

const MAX_NAME_LEN = 120;
const UNSAFE_CHARS = /[\\/:*?"<>| ]/g;

export interface DeriveOptions {
  url: string;
  contentType: string;
  contentDisposition?: string;
}

export function deriveDownloadFilename(opts: DeriveOptions): string {
  let name = fromContentDisposition(opts.contentDisposition);
  if (!name) name = fromUrlBasename(opts.url);
  if (!name) name = `download-${shortHash(opts.url)}`;

  name = sanitize(name);
  name = ensureExtension(name, opts.contentType);
  return capLength(name);
}

function fromContentDisposition(cd?: string): string | undefined {
  if (!cd) return undefined;
  const star = /filename\*\s*=\s*(?:([^']*)'[^']*')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim());
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : undefined;
}

function fromUrlBasename(url: string): string | undefined {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

function sanitize(name: string): string {
  return name.replace(UNSAFE_CHARS, '_');
}

function ensureExtension(name: string, contentType: string): string {
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[ct];
  return ext ? `${name}.${ext}` : name;
}

function capLength(name: string): string {
  if (name.length <= MAX_NAME_LEN) return name;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot < name.length - 9) return name.slice(0, MAX_NAME_LEN);
  const ext = name.slice(dot);
  return name.slice(0, MAX_NAME_LEN - ext.length) + ext;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

export function resolveDownloadDir(override?: string): string {
  const target =
    override ??
    process.env.BROWSER_WEBFETCH_DOWNLOAD_DIR ??
    path.join(envPaths('browser-webfetch', { suffix: '' }).cache, 'downloads');
  mkdirSync(target, { recursive: true });
  return target;
}

export interface DownloadResult {
  path: string;
  contentType: string;
  size: number;
}

export async function downloadToFile(
  ctx: BrowserContext,
  url: string,
  dir: string,
  timeoutMs: number,
): Promise<DownloadResult> {
  let response;
  try {
    response = await ctx.request.get(url, { timeout: timeoutMs, maxRedirects: 5 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BwfError(ErrorCode.NAV_ERROR, `download failed: ${msg}`, { url });
  }
  if (!response.ok()) {
    throw new BwfError(ErrorCode.NAV_ERROR, `download failed: HTTP ${response.status()}`, {
      url,
      status: response.status(),
    });
  }
  const headers = response.headers();
  const contentType = headers['content-type'] ?? 'application/octet-stream';
  const contentDisposition = headers['content-disposition'];
  const baseName = deriveDownloadFilename({ url, contentType, contentDisposition });
  const finalPath = await pickUniquePath(dir, baseName);
  const body = await response.body();
  await fsp.writeFile(finalPath, body);
  return { path: finalPath, contentType, size: body.length };
}

async function pickUniquePath(dir: string, name: string): Promise<string> {
  const candidate = path.join(dir, name);
  try {
    await fsp.access(candidate);
  } catch {
    return candidate;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot);
  const suffix = createHash('sha1')
    .update(`${name}-${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return path.join(dir, `${stem}-${suffix}${ext}`);
}

export async function sweepOldDownloads(
  dir: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn('sweepOldDownloads: readdir failed', { dir, err: String(err) });
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (name) => {
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (!st.isFile()) return;
        if (st.mtimeMs < cutoff) await fsp.unlink(full);
      } catch (err) {
        logger.warn('sweepOldDownloads: per-file error', { full, err: String(err) });
      }
    }),
  );
}

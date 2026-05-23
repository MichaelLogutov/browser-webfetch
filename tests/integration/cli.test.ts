import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-cli-'));
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

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
  rmSync(tmpProfile, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('CLI', () => {
  it('prints markdown for example.com to stdout', async () => {
    const { stdout } = await exec(
      NPX,
      ['tsx', 'src/main.ts', 'https://example.com', '--profile', tmpProfile],
      { timeout: 60_000, shell: process.platform === 'win32' },
    );
    expect(stdout).toContain('Example Domain');
  });

  it('exits 5 on missing url', async () => {
    await expect(
      exec(NPX, ['tsx', 'src/main.ts'], {
        timeout: 10_000,
        shell: process.platform === 'win32',
      }),
    ).rejects.toMatchObject({ code: 5 });
  });

  it('--download writes the file and prints its absolute path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwf-cli-dl-'));
    try {
      const { stdout } = await exec(
        NPX,
        [
          'tsx',
          'src/main.ts',
          `http://127.0.0.1:${port}/file.pdf`,
          '--download',
          '--download-dir',
          dir,
          '--profile',
          tmpProfile,
        ],
        { timeout: 60_000, shell: process.platform === 'win32' },
      );
      const filePath = stdout.trim();
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(PDF_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

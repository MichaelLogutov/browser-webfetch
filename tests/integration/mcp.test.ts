import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-mcp-'));

function send(child: ReturnType<typeof spawn>, payload: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(payload) + '\n');
}

async function readJsonRpc(
  child: ReturnType<typeof spawn>,
  id: number,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('mcp response timeout')), timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(t);
            resolve(msg);
            return;
          }
        } catch {
          /* ignore non-JSON line */
        }
      }
    });
    child.on('exit', () => reject(new Error('mcp server exited before response')));
  });
}

describe('MCP server', () => {
  it('answers tools/list and tools/call', async () => {
    const env = { ...process.env, BROWSER_WEBFETCH_PROFILE: tmpProfile };
    const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(NPX, ['tsx', 'src/main.ts', '--mcp'], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });

    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    await readJsonRpc(child, 1);

    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listResp = await readJsonRpc(child, 2);
    const tools = (listResp.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain('browser_fetch');

    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'browser_fetch', arguments: { url: 'https://example.com' } },
    });
    const callResp = await readJsonRpc(child, 3);
    const content = (callResp.result as { content: Array<{ text: string }> }).content;
    expect(content[0]!.text).toContain('Example Domain');

    // Close stdin to trigger the MCP server's graceful shutdown (which awaits
    // browser.close()).  Wait for the child to exit, then SIGKILL anything still
    // alive as a safety net before removing the profile dir.
    child.stdin!.end();
    const exited = await new Promise<boolean>((resolve) => {
      const onExit = () => resolve(true);
      child.once('exit', onExit);
      setTimeout(() => {
        child.removeListener('exit', onExit);
        child.kill('SIGKILL');
        child.once('exit', () => resolve(false));
      }, 10_000);
    });
    void exited;
    // Brief delay so the OS releases file handles after process exit.
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmpProfile, { recursive: true, force: true });
  }, 120_000);

  it('browser_fetch with download=true returns saved file path', async () => {
    const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake\n%%EOF\n');
    const server: Server = createServer((req, res) => {
      if (req.url === '/file.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(PDF_BYTES);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const profile = mkdtempSync(join(tmpdir(), 'bwf-mcp-dl-'));
    const downloads = mkdtempSync(join(tmpdir(), 'bwf-mcp-dl-out-'));

    const env = {
      ...process.env,
      BROWSER_WEBFETCH_PROFILE: profile,
      BROWSER_WEBFETCH_DOWNLOAD_DIR: downloads,
    };
    const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(NPX, ['tsx', 'src/main.ts', '--mcp'], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });

    try {
      send(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      });
      await readJsonRpc(child, 1);

      send(child, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser_fetch',
          arguments: { url: `http://127.0.0.1:${port}/file.pdf`, download: true },
        },
      });
      const resp = await readJsonRpc(child, 2);
      const content = (resp.result as { content: Array<{ text: string }> }).content;
      const savedPath = content[0]!.text.trim();

      expect(existsSync(savedPath)).toBe(true);
      expect(readFileSync(savedPath)).toEqual(PDF_BYTES);
    } finally {
      child.stdin!.end();
      await new Promise<void>((resolve) => {
        const onExit = () => resolve();
        child.once('exit', onExit);
        setTimeout(() => {
          child.removeListener('exit', onExit);
          child.kill('SIGKILL');
          resolve();
        }, 10_000);
      });
      await new Promise((r) => setTimeout(r, 500));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(profile, { recursive: true, force: true });
      rmSync(downloads, { recursive: true, force: true });
    }
  }, 120_000);
});

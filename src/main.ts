#!/usr/bin/env node
import { runCli } from './cli.js';
import { runMcpServer } from './mcp.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--mcp')) {
    await runMcpServer();
    return;
  }
  const code = await runCli(argv);
  process.exit(code);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});

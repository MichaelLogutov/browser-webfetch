#!/usr/bin/env node
/* eslint-disable no-console */
// Wraps `playwright-core install chromium` so a failed Chromium download does
// not abort the whole package install. The JS bits are useful even without a
// browser (typecheck, mcp config) and users can retry the download manually.

const { spawnSync } = require('node:child_process');

const result = spawnSync('playwright-core', ['install', 'chromium'], {
  stdio: 'inherit',
  shell: true,
});

if (result.status === 0) {
  process.exit(0);
}

const sep = '─'.repeat(60);
console.error(`\n${sep}`);
console.error('[browser-webfetch] Chromium auto-install did not finish cleanly.');
console.error('The browser-webfetch binary is still installed and usable once a');
console.error('matching Chromium is present. To retry the download manually:');
console.error('');
console.error('    npx playwright-core install chromium');
console.error('');
console.error('If that also fails, see the README troubleshooting section.');
console.error(`${sep}\n`);

// Intentionally exit 0 so npm reports the package as installed.
process.exit(0);

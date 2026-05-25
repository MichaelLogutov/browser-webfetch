# Changelog

## [1.1.1](https://github.com/MichaelLogutov/browser-webfetch/compare/v1.1.0...v1.1.1) (2026-05-24)


### Bug Fixes

* **postinstall:** make Chromium download failure non-fatal — the package now installs cleanly even when `playwright-core install chromium` exits non-zero (silent failures on bleeding-edge Node versions, Windows Defender extraction stalls, etc.). Users can retry the browser download manually with `npx playwright-core install chromium`. ([0e29a91](https://github.com/MichaelLogutov/browser-webfetch/commit/0e29a91))


### Documentation

* add Troubleshooting section covering Chromium auto-install failures (Node version, antivirus, disk space). ([0e29a91](https://github.com/MichaelLogutov/browser-webfetch/commit/0e29a91))

## [1.1.0](https://github.com/MichaelLogutov/browser-webfetch/compare/v1.0.0...v1.1.0) (2026-05-24)


### Code Refactoring

* **stealth:** replace `playwright-extra` + `puppeteer-extra-plugin-stealth` with [`rebrowser-playwright`](https://www.npmjs.com/package/rebrowser-playwright). Eliminates the deprecated `inflight` / `glob@7` / `rimraf@3` warnings during `npm install` and drops the abandoned `puppeteer-extra` dependency tree. The `--no-stealth` debug flag was removed (rebrowser stealth patches are applied at build time and cannot be disabled at runtime). ([ce15777](https://github.com/MichaelLogutov/browser-webfetch/commit/ce15777), [39a4f42](https://github.com/MichaelLogutov/browser-webfetch/commit/39a4f42))


### Documentation

* promote the global `~/.claude/CLAUDE.md` hint from a footnote to a required install step — without it Claude often skips the MCP fallback. ([c9d90a5](https://github.com/MichaelLogutov/browser-webfetch/commit/c9d90a5))

## 1.0.0 (2026-05-23)


### Features

* initial public release on npm. CLI and MCP server that fetches URLs through a real headed Chromium with stealth patches, persistent profile, captcha-surfacing, and auto-download for non-HTML responses. ([ff66d4f](https://github.com/MichaelLogutov/browser-webfetch/commit/ff66d4f))

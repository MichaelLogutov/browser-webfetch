# Changelog

## [1.1.2](https://github.com/MichaelLogutov/browser-webfetch/compare/v1.1.1...v1.1.2) (2026-05-25)


### Bug Fixes

* **bootstrap:** spawn playwright-core CLI via createRequire, not PATH ([68cbaa1](https://github.com/MichaelLogutov/browser-webfetch/commit/68cbaa116691d2e48fd92331b818068a8c6ac77d))
* **install:** fall back to PowerShell Expand-Archive on Windows when playwright install hangs ([abfd599](https://github.com/MichaelLogutov/browser-webfetch/commit/abfd5991e515bd83bc467c26bcf0c76ade89e749))
* **install:** move Chromium download out of postinstall to first run ([5f76a4c](https://github.com/MichaelLogutov/browser-webfetch/commit/5f76a4c2c03a85e1ccd8999f92415a8f539147cd))

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

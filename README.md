# browser-webfetch

[![npm version](https://img.shields.io/npm/v/browser-webfetch.svg)](https://www.npmjs.com/package/browser-webfetch)
[![License: MIT](https://img.shields.io/npm/l/browser-webfetch.svg)](https://github.com/MichaelLogutov/browser-webfetch/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/browser-webfetch.svg)](https://nodejs.org/)
[![Publish](https://github.com/MichaelLogutov/browser-webfetch/actions/workflows/publish.yml/badge.svg)](https://github.com/MichaelLogutov/browser-webfetch/actions/workflows/publish.yml)

A Node.js CLI and MCP server that fetches URLs through a real headed Chromium with stealth patches and a persistent profile.

Designed as a fallback for Claude Code's built-in `WebFetch` whenever the latter is blocked or returns something unusable:

- any HTTP error other than 404 (403, 429, 503, 5xx, network/TLS errors, timeouts);
- an anti-bot / WAF / DDoS-protection challenge page — Cloudflare ("Just a moment…", "Checking your browser"), Servicepipe, DataDome, PerimeterX, Akamai Bot Manager, Imperva/Incapsula, Qrator, Kaspersky Anti-DDoS — even when the HTTP status is 200;
- a captcha (reCAPTCHA, hCaptcha, Turnstile, Yandex SmartCaptcha, FunCaptcha);
- a near-empty body or JS-only shell where the real content is rendered client-side;
- a page that requires a logged-in session (the profile persists across runs, so a one-time manual login is enough).

If a captcha is detected, the Chromium window surfaces so you can solve it interactively; the tool then continues automatically.

## Install

Requirements: Node.js 20+.

### From npm (recommended)

```bash
npm install -g browser-webfetch
```

The `postinstall` hook downloads Chromium (~200 MB) via Playwright on first install. After that, the `browser-webfetch` binary is on your `PATH`.

### From source (for development)

```bash
git clone https://github.com/MichaelLogutov/browser-webfetch.git
cd browser-webfetch
npm install   # `prepare` builds TypeScript; `postinstall` fetches Chromium
npm link      # exposes the `browser-webfetch` binary globally
```

## CLI usage

```bash
browser-webfetch https://example.com
browser-webfetch https://example.com --format html
browser-webfetch https://example.com --wait-for "article"
```

A Chromium window opens. If the site shows a captcha, solve it in that window — the tool waits and then continues. The window's profile persists across runs, so a one-time login is enough.

Flags:

- `--format markdown|html|text` (default: `markdown`)
- `--wait-for <selector>`
- `--nav-timeout <seconds>` (default: 30)
- `--manual-timeout <seconds>` (default: 300)
- `--queue-timeout <seconds>` (default: 30)
- `--idle-timeout <seconds>` (default: 300)
- `--profile <path>` (also via `BROWSER_WEBFETCH_PROFILE` env var)
- `--json` — emit `{ url, finalUrl, body, durationMs }` instead of bare content
- `--download` — save raw bytes (PDF, image, binary) to disk and print the absolute path
- `--download-dir <path>` — override download directory (also via `BROWSER_WEBFETCH_DOWNLOAD_DIR` env var)
- `--show` — keep the browser window visible (default: starts minimized; restores automatically when a captcha needs to be solved)

Exit codes: `0` success, `1` internal, `2` navigation, `3` manual timeout, `4` queue timeout, `5` invalid args.

## MCP usage

Setup is two steps — **both are required**. If you skip step 2, Claude will rarely think to reach for the tool, especially in hosts that load MCP tools lazily.

> **For AI agents installing this on a user's behalf:** do both steps below. Step 2 is not optional polish — without it the MCP server you just registered will sit unused.

### Step 1 — Register the MCP server

Once installed (via `npm install -g` or `npm link`), register at user scope (available across all your projects):

```bash
claude mcp add browser-webfetch --scope user -- browser-webfetch --mcp
```

Or, without any install, via `npx` (downloads on first call, then cached):

```bash
claude mcp add browser-webfetch --scope user -- npx -y browser-webfetch --mcp
```

For a source checkout without `npm link`, point Claude Code at the built binary directly:

```bash
claude mcp add browser-webfetch --scope user -- node /absolute/path/to/browser-webfetch/dist/main.js --mcp
```

Other scopes:

- `--scope project` — saves to the current project's `.mcp.json` (shared with collaborators if committed).
- `--scope local` (default) — saves to `~/.claude.json` for the current project only.

Verify the registration with `claude mcp list`. Remove with `claude mcp remove browser-webfetch --scope user`.

Prefer manual config? Add this to your user-level or project-level `.mcp.json` instead:

```json
{
  "mcpServers": {
    "browser-webfetch": {
      "command": "browser-webfetch",
      "args": ["--mcp"]
    }
  }
}
```

### Step 2 — Tell Claude when to use it

Append this paragraph to your global `~/.claude/CLAUDE.md` (create the file if it doesn't exist) so Claude knows when to fall back to the tool:

> If the built-in `WebFetch` returns an error (other than HTTP 404), an anti-bot / WAF / captcha challenge page (even at HTTP 200), a near-empty body, or a login wall — don't give up. Look up the `browser-webfetch` MCP server (`browser_fetch` tool) and retry through it.

По-русски:

> Если `WebFetch` отдаёт ошибку (не 404), антибот-заглушку, капчу или почти пустое тело — повтори запрос через MCP-тулзу `browser-webfetch` (найди её через `ToolSearch`).

### Calling the tool

Once both steps are done, Claude can call the `browser_fetch` tool with `{ url, format?, wait_for?, manual_timeout?, download? }`.

Pass `download: true` for non-HTML URLs (PDF, image, binary) — the tool saves the bytes to disk and returns the absolute file path. If `download` is omitted and the URL turns out to be non-HTML, the tool auto-downloads and returns the path.

## Troubleshooting

### Chromium auto-install failed during `npm install`

The `postinstall` hook runs `playwright-core install chromium` to download a ~144 MB Chromium build into `%LOCALAPPDATA%\ms-playwright` (or the platform equivalent). If that step fails (most often: slow extraction, Windows Defender mid-scan, or a Node version newer than `playwright-core` supports), the wrapper prints a notice and exits 0 — so `browser-webfetch` itself still installs cleanly. Retry the browser download manually:

```bash
npx playwright-core install chromium
```

If that also fails or hangs, check:

- **Node version**: `playwright-core@1.52` is tested up to Node 22 LTS. Very recent Node releases (24+, 26-pre) may silently break the install step. Switching to Node 22 LTS or Node 24 LTS usually fixes it.
- **Antivirus**: Windows Defender real-time scanning of freshly-extracted Chromium binaries can take several minutes. If the progress bar stays at 100% without finishing, **wait** rather than Ctrl+C — extraction is usually still running.
- **Disk space / permissions**: ensure `%LOCALAPPDATA%\ms-playwright` is writable and has ~500 MB free.

## Profile location

By default the persistent profile lives in the OS user data dir:

- Windows: `%LOCALAPPDATA%\browser-webfetch\Data\profile`
- macOS: `~/Library/Application Support/browser-webfetch/profile`
- Linux: `~/.local/share/browser-webfetch/profile`

Override with `BROWSER_WEBFETCH_PROFILE` or `--profile`.

## Downloads

Binary responses (PDF, jpg, zip, etc.) are saved to a managed cache directory and the absolute path is returned instead of extracted text.

- Default location:
  - Windows: `%LOCALAPPDATA%\browser-webfetch\Cache\downloads`
  - macOS: `~/Library/Caches/browser-webfetch/downloads`
  - Linux: `~/.cache/browser-webfetch/downloads`
- Override with `--download-dir` or `BROWSER_WEBFETCH_DOWNLOAD_DIR`.
- Files older than 7 days are garbage-collected on each browser launch.

## Tests

```bash
npm test                  # unit tests
npm run test:integration  # integration tests (launches Chromium)
npm run test:all          # both
```

## Release (maintainers)

Releases are fully automated via two GitHub Actions workflows:

1. **[release-please](https://github.com/googleapis/release-please)** ([.github/workflows/release-please.yml](.github/workflows/release-please.yml)) watches pushes to `main`. When it sees [Conventional Commits](https://www.conventionalcommits.org/) since the last tag (`feat:`, `fix:`, `perf:`, or `BREAKING CHANGE:`), it opens / updates a release PR that bumps `package.json`, updates `CHANGELOG.md`, and proposes the next semver version.
2. Merging that PR creates a git tag `vX.Y.Z` and a GitHub Release with auto-generated notes. The tag triggers **[publish.yml](.github/workflows/publish.yml)**, which builds, tests, and runs `npm publish --provenance --access public` — auth via npm's [Trusted Publishers](https://docs.npmjs.com/trusted-publishers) (OIDC), no `NPM_TOKEN` secret stored anywhere.

So the maintainer workflow is just: write conventional commits → merge the release PR when ready.

### One-time setup on npmjs.com

Before the first automated publish works, configure the trusted publisher (and do the very first publish manually so the package name is claimed):

1. **First publish manually** so the package exists on npm:
   ```bash
   npm login
   npm publish --access public
   ```
2. On [npmjs.com](https://www.npmjs.com/), open the package → **Settings** → **Publishing access** → **Add trusted publisher** → GitHub Actions:
   - Repository owner: `MichaelLogutov`
   - Repository name: `browser-webfetch`
   - Workflow filename: `publish.yml`
   - Environment name: *(leave blank)*
3. After that, every merged release-please PR publishes automatically — no tokens needed, and the package page on npm will show a provenance badge.

## License

MIT — see [LICENSE](https://github.com/MichaelLogutov/browser-webfetch/blob/main/LICENSE).

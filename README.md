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

The install itself is just JavaScript and finishes in seconds. The first time you run the CLI (or the MCP server makes its first tool call), `browser-webfetch` downloads Chromium (~150 MB) via Playwright and extracts it into the OS user data dir. That step is one-time and takes 2-5 minutes — please don't interrupt it.

### From source (for development)

```bash
git clone https://github.com/MichaelLogutov/browser-webfetch.git
cd browser-webfetch
npm install   # `prepare` builds TypeScript
npm link      # exposes the `browser-webfetch` binary globally
```

Chromium is downloaded on first run; if you want to do it ahead of time:

```bash
npx playwright-core install chromium
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
- `--interactive` — surface the window and wait for manual login/interaction, then return the last page content
- `--show` — keep the browser window visible (default: starts minimized; restores automatically when a captcha needs to be solved)

Environment variables: `BROWSER_WEBFETCH_PROFILE` (profile dir), `BROWSER_WEBFETCH_DOWNLOAD_DIR` (download dir), `BROWSER_WEBFETCH_LOG_LEVEL` (`debug|info|warn|error`), `BROWSER_WEBFETCH_RECLAIM=1` (opt-in: kill stale Chromium that holds the persistent profile after a crash — off by default; see [Troubleshooting](#browser-launches-but-immediately-exits-target-page-context-or-browser-has-been-closed)).

Exit codes: `0` success, `1` internal, `2` navigation, `3` manual timeout, `4` queue timeout, `5` invalid args, `6` launch failed.

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

## Login / SSO walls

If a URL is behind a login or SSO session, an unauthenticated fetch lands on the
sign-in page. browser-webfetch detects common login walls (redirects to known
identity providers, `/login` `/sso` `/oauth` paths, HTTP 401, password forms)
and surfaces the Chromium window so you can log in; after you finish it returns
the real content. The login persists in the profile, so later fetches succeed
automatically.

You can also force this: pass `interactive: true` (MCP) or `--interactive` (CLI).
The window is surfaced and the tool waits until you **close the tab**, then
returns whatever was last loaded. If you don't act within `manual_timeout`
(default 300s) the call fails with `MANUAL_TIMEOUT` and a message telling the
agent the user likely didn't notice / stepped away, so it should retry rather
than treat it as a failure.

## Troubleshooting

### Chromium first-run install failed

The first invocation of `browser-webfetch` (CLI or MCP) downloads Chromium (~150 MB) into `%LOCALAPPDATA%\ms-playwright` (or the platform equivalent). If that step fails or hangs, check:

- **Antivirus**: Windows Defender real-time scanning of freshly-extracted Chromium binaries can take several minutes. If the progress bar stays at 100% without finishing, **wait** rather than Ctrl+C — extraction is usually still running. browser-webfetch falls back to PowerShell `Expand-Archive` after a 4-minute hang.
- **Node version**: `playwright-core@1.52` is tested up to Node 22 LTS. Very recent Node releases (26+, pre-release builds) may silently break the install step. Switching to Node 22 LTS or Node 24 LTS usually fixes it.
- **Disk space / permissions**: ensure `%LOCALAPPDATA%\ms-playwright` is writable and has ~500 MB free.

To run the download manually (e.g. on a machine that won't have internet at first run):

```bash
npx playwright-core install chromium
```

### Browser launches but immediately exits ("Target page, context or browser has been closed")

Chrome spawned, was given a PID, then disconnected before browser-webfetch could attach. The most common cause is a **stale Chromium still holding the persistent profile**: an orphan from a previous run that was hard-killed (the MCP host restarted/killed the server, the terminal was closed, a crash) before the browser tree was torn down. On Windows a dead parent does not cascade-kill its children, and playwright skips its own `taskkill` when the main process exited on its own — so the helpers keep the profile's `--user-data-dir` locked. The next launch then hands off to that orphan via the Windows process-singleton ("Opening in existing browser session.") and exits before the DevTools pipe comes up.

**browser-webfetch now recovers from this automatically.** It detects a locked profile *natively* (no child process) and falls back to a throwaway temporary profile, so the fetch still succeeds. You'll see a one-line `WARN ... persistent profile is locked` / `falling back to a temporary throwaway profile` instead of a hard failure.

The only downside of the fallback is that the **throwaway profile has no saved logins/cookies** for that run. To reuse the persistent profile, clear the orphans (one of):

- **Kill the orphans yourself** (run this PowerShell *in your terminal* — that's an interactive launch, unaffected by AV "script → PowerShell" rules):
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like '*ms-playwright*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```
  …or just reboot.
- **Let browser-webfetch do it** — set `BROWSER_WEBFETCH_RECLAIM=1` and it will kill the orphans holding *its* profile and reuse it. This is **off by default** because it shells out to PowerShell (the only way to match Chromium by `--user-data-dir`), and some endpoint-security suites — notably **Kaspersky Adaptive Anomaly Control** — block "Windows PowerShell launched from a script" and will pop an alert while the reclaim quietly no-ops. Leave it off on such machines; the automatic throwaway-profile fallback already keeps things working.

If even the throwaway profile fails to launch, the cause is environmental and browser-webfetch exits with code 6, printing this checklist to stderr:

1. **Antivirus blocking Chrome's helper processes or the DevTools pipe**. Kaspersky, ESET, Norton, and similar HIPS-style products often interfere with `chrome.exe` subprocesses launched from a non-`Program Files` path. Add the Chromium folder (e.g. `%LOCALAPPDATA%\ms-playwright`) to your AV's process / file exclusions (or trusted-applications list).
2. **Chromium install incomplete**. Force a reinstall:
   ```bash
   npx playwright-core install chromium --force
   ```
3. **Corrupted profile**. Move it aside so a fresh one is created:
   ```powershell
   # Windows
   Rename-Item "$env:LOCALAPPDATA\browser-webfetch\Data\profile" profile.bak
   ```
   ```bash
   # macOS / Linux
   mv ~/Library/Application\ Support/browser-webfetch/profile profile.bak    # macOS
   mv ~/.local/share/browser-webfetch/profile profile.bak                     # Linux
   ```

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

Releases are one command:

```bash
npm version patch     # or minor / major — bumps package.json, creates commit + git tag
git push --follow-tags
```

Pushing a `v*` tag triggers [.github/workflows/publish.yml](.github/workflows/publish.yml), which builds, runs unit tests, publishes to npm via [Trusted Publishers](https://docs.npmjs.com/trusted-publishers) (OIDC — no `NPM_TOKEN` secret), and creates a GitHub Release with auto-generated notes from the commits since the previous tag.

Commit history follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, etc.) so the auto-generated release notes are readable without manual editing.

`CHANGELOG.md` documents 1.0.0 – 1.1.2 historically; new versions live on the GitHub Releases page.

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
3. After that, every `git push --follow-tags` of a `v*` tag publishes automatically — no tokens needed, and the package page on npm will show a provenance badge.

## License

MIT — see [LICENSE](https://github.com/MichaelLogutov/browser-webfetch/blob/main/LICENSE).

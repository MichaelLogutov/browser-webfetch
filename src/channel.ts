import { BwfError, ErrorCode } from './errors.js';

export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

const KNOWN: readonly BrowserChannel[] = ['chrome', 'msedge', 'chromium'];

// Default to the real, locally-installed Google Chrome. Its genuine TLS/JA3
// handshake and "Google Chrome" identity clear anti-bot/WAF systems (notably
// Qrator) that flag Playwright's bundled open-source Chromium — and rebrowser's
// CDP-leak patches still apply on top of it. Overridable via the
// BROWSER_WEBFETCH_BROWSER env var or a per-call argument; falls back to msedge
// and finally the bundled Chromium when the requested binary is not installed.
export const DEFAULT_CHANNEL: BrowserChannel = 'chrome';

export function resolveChannel(override?: string): BrowserChannel {
  const raw = override ?? process.env.BROWSER_WEBFETCH_BROWSER ?? DEFAULT_CHANNEL;
  const ch = raw.trim().toLowerCase();
  if (ch === 'edge') return 'msedge';
  if (!KNOWN.includes(ch as BrowserChannel)) {
    throw new BwfError(
      ErrorCode.INVALID_ARGS,
      `invalid browser: ${raw} (expected chrome | msedge | chromium)`,
    );
  }
  return ch as BrowserChannel;
}

// Launch candidates in preference order: try the requested channel, then degrade
// to widely-available binaries, ending at the always-present bundled Chromium so
// a fetch still succeeds on machines without Chrome/Edge installed.
export function channelCandidates(channel: BrowserChannel): BrowserChannel[] {
  switch (channel) {
    case 'chrome':
      return ['chrome', 'msedge', 'chromium'];
    case 'msedge':
      return ['msedge', 'chromium'];
    case 'chromium':
      return ['chromium'];
  }
}

// Playwright's `channel` launch option; the bundled Chromium is selected by
// omitting `channel` entirely, so it maps to undefined.
export function channelLaunchOption(channel: BrowserChannel): string | undefined {
  return channel === 'chromium' ? undefined : channel;
}

// A launch failure that means the requested system browser is simply not
// installed (as opposed to a profile/transport problem) — the signal to fall
// back to the next candidate channel rather than surfacing an error.
export function isChannelUnavailableError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /is not found|doesn't exist|not installed|Failed to launch|Chromium distribution/i.test(m);
}

import envPaths from 'env-paths';
import path from 'node:path';
import type { BrowserChannel } from './channel.js';

export function resolveProfileDir(override?: string): string {
  if (override !== undefined) return override;
  const fromEnv = process.env.BROWSER_WEBFETCH_PROFILE;
  if (fromEnv !== undefined) return fromEnv;
  const paths = envPaths('browser-webfetch', { suffix: '' });
  return path.join(paths.data, 'profile');
}

// Each browser channel gets its own profile so different Chrome/Chromium builds
// never share — and corrupt — a profile (Chrome refuses a profile written by a
// newer version). The bundled Chromium keeps the original location for
// backwards compatibility with existing installs; system browsers go in a
// per-channel subdir.
export function profileDirForChannel(base: string, channel: BrowserChannel): string {
  return channel === 'chromium' ? base : path.join(base, channel);
}

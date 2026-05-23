import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { resolveProfileDir } from '../src/profile.js';

describe('resolveProfileDir', () => {
  const origEnv = process.env.BROWSER_WEBFETCH_PROFILE;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.BROWSER_WEBFETCH_PROFILE;
    else process.env.BROWSER_WEBFETCH_PROFILE = origEnv;
  });

  it('honors explicit override argument', () => {
    expect(resolveProfileDir('/custom/path')).toBe('/custom/path');
  });

  it('honors BROWSER_WEBFETCH_PROFILE env var', () => {
    process.env.BROWSER_WEBFETCH_PROFILE = '/env/path';
    expect(resolveProfileDir()).toBe('/env/path');
  });

  it('falls back to env-paths default with /profile suffix', () => {
    delete process.env.BROWSER_WEBFETCH_PROFILE;
    const result = resolveProfileDir();
    expect(result).toMatch(/[/\\]browser-webfetch[/\\]/);
    expect(path.basename(result)).toBe('profile');
  });
});

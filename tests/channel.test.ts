import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveChannel,
  channelCandidates,
  channelLaunchOption,
  isChannelUnavailableError,
  DEFAULT_CHANNEL,
} from '../src/channel.js';

const ENV = 'BROWSER_WEBFETCH_BROWSER';
const original = process.env[ENV];
afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe('resolveChannel', () => {
  it('defaults to chrome when nothing is set', () => {
    delete process.env[ENV];
    expect(resolveChannel()).toBe('chrome');
    expect(DEFAULT_CHANNEL).toBe('chrome');
  });

  it('an explicit argument overrides the env default', () => {
    process.env[ENV] = 'chromium';
    expect(resolveChannel('chrome')).toBe('chrome');
  });

  it('falls back to the env var when no argument is given', () => {
    process.env[ENV] = 'chromium';
    expect(resolveChannel()).toBe('chromium');
  });

  it('accepts "edge" as an alias for msedge and is case-insensitive', () => {
    delete process.env[ENV];
    expect(resolveChannel('Edge')).toBe('msedge');
    expect(resolveChannel('CHROME')).toBe('chrome');
  });

  it('throws on an unknown channel', () => {
    expect(() => resolveChannel('firefox')).toThrow(/invalid browser/i);
  });
});

describe('channelCandidates (fallback order)', () => {
  it('chrome degrades to msedge then bundled chromium', () => {
    expect(channelCandidates('chrome')).toEqual(['chrome', 'msedge', 'chromium']);
  });
  it('msedge degrades to bundled chromium', () => {
    expect(channelCandidates('msedge')).toEqual(['msedge', 'chromium']);
  });
  it('chromium has no fallback', () => {
    expect(channelCandidates('chromium')).toEqual(['chromium']);
  });
});

describe('channelLaunchOption', () => {
  it('maps bundled chromium to undefined (no channel)', () => {
    expect(channelLaunchOption('chromium')).toBeUndefined();
  });
  it('passes system channels through verbatim', () => {
    expect(channelLaunchOption('chrome')).toBe('chrome');
    expect(channelLaunchOption('msedge')).toBe('msedge');
  });
});

describe('isChannelUnavailableError', () => {
  it('recognises a missing-binary launch error', () => {
    expect(isChannelUnavailableError(new Error("Chromium distribution 'chrome' is not found"))).toBe(true);
    expect(isChannelUnavailableError(new Error('Failed to launch chrome because executable doesn\'t exist'))).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isChannelUnavailableError(new Error('navigation timeout'))).toBe(false);
  });
});

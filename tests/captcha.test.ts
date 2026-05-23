import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { detectCaptchaInDom } from '../src/captcha.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

function detect(html: string, status = 200) {
  const dom = new JSDOM(html);
  return detectCaptchaInDom(dom.window.document, status);
}

describe('detectCaptchaInDom', () => {
  it('detects Cloudflare interstitial', () => {
    const result = detect(fixture('cf-interstitial.html'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('cloudflare');
  });

  it('detects hCaptcha iframe', () => {
    const result = detect(fixture('hcaptcha.html'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('hcaptcha');
  });

  it('detects reCAPTCHA', () => {
    const result = detect(fixture('recaptcha.html'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('recaptcha');
  });

  it('does not flag a clean article', () => {
    const result = detect(fixture('clean-article.html'));
    expect(result.detected).toBe(false);
  });

  it('flags HTTP 403 with HTML body', () => {
    const result = detect('<!doctype html><body>Forbidden</body>', 403);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('http_403');
  });

  it('detects Datadome iframe', () => {
    const result = detect(fixture('datadome.html'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('datadome');
  });

  it('detects generic anti-bot wall by title', () => {
    const result = detect(fixture('generic-wall.html'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('generic_wall');
  });
});

import { readableContentLength } from '../src/captcha.js';

describe('readableContentLength', () => {
  it('returns 0 for empty body', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    expect(readableContentLength(dom.window.document)).toBe(0);
  });

  it('counts substantial article text', () => {
    const dom = new JSDOM(fixture('false-positive-rich.html'));
    expect(readableContentLength(dom.window.document)).toBeGreaterThan(500);
  });
});

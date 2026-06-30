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

  it('detects Servicepipe rotated captcha (empty title) as a strong signal', () => {
    const result = detect(fixture('servicepipe-captcha.html'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('servicepipe');
    // Strong: dedicated captcha assets cannot appear on a real page, so this
    // must bypass the readable-content guard even though the page carries a
    // few hundred characters of "why you're blocked" boilerplate (>500).
    expect(result.strong).toBe(true);
  });

  it('detects Qrator captcha served with 401 (empty title) as a strong signal', () => {
    // petrovich serves a Qrator "Введите символы с картинки" captcha with HTTP
    // 401. Without a dedicated branch it falls through to the login-wall path
    // (status===401), which auto-resolves and closes the window immediately.
    const result = detect(fixture('qrator-captcha.html'), 401);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('qrator');
    expect(result.strong).toBe(true);
  });

  it('prefers the strong Servicepipe signature over weak http_403 when both apply', () => {
    // The site alternates between 200 and 403. A 403 must not down-rank a real
    // Servicepipe captcha to the weak http_403 type (which the content guard
    // could then skip on a long interstitial).
    const result = detect(fixture('servicepipe-captcha.html'), 403);
    expect(result.type).toBe('servicepipe');
    expect(result.strong).toBe(true);
  });

  it('detects a soft-block / access-restricted page by title as a strong signal', () => {
    const result = detect(fixture('petrovich-block.html'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('soft_block');
    expect(result.strong).toBe(true);
  });

  it('does not mark title-only heuristics as strong (guard still protects rich pages)', () => {
    // false-positive-rich has the "Just a moment..." title AND >500 chars of
    // real prose. It is still "detected" by the cloudflare title branch, but it
    // must NOT be strong, so the content guard in fetch.ts keeps gating it.
    const result = detect(fixture('false-positive-rich.html'));
    expect(result.strong).toBeFalsy();
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

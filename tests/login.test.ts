import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { detectLoginWall } from '../src/captcha.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');
const doc = (html: string) => new JSDOM(html).window.document;

const GRAFANA = 'https://grafana.cloud.cian.tech/d/abc/dash?orgId=1';

describe('detectLoginWall', () => {
  it('detects a cross-origin redirect to Google SSO', () => {
    const r = detectLoginWall(
      doc(fixture('login-google-sso.html')),
      200,
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      GRAFANA,
    );
    expect(r.detected).toBe(true);
  });

  it('detects HTTP 401', () => {
    const r = detectLoginWall(doc('<!doctype html><body>nope</body>'), 401, GRAFANA, GRAFANA);
    expect(r.detected).toBe(true);
  });

  it('detects a same-origin /login path with a password field', () => {
    const r = detectLoginWall(
      doc(fixture('login-form.html')),
      200,
      'https://app.example.com/login',
      'https://app.example.com/dashboard',
    );
    expect(r.detected).toBe(true);
  });

  it('does NOT flag a rich same-origin article that merely has a login box', () => {
    const r = detectLoginWall(
      doc(fixture('false-positive-rich.html')),
      200,
      'https://news.example.com/article/123',
      'https://news.example.com/article/123',
    );
    expect(r.detected).toBe(false);
  });

  it('does NOT flag a plain content page', () => {
    const r = detectLoginWall(
      doc('<!doctype html><body>' + 'x'.repeat(600) + '</body>'),
      200,
      'https://example.com/page',
      'https://example.com/page',
    );
    expect(r.detected).toBe(false);
  });
});

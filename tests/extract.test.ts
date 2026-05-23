import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractContent } from '../src/extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

describe('extractContent', () => {
  it('extracts markdown for a clean article', () => {
    const html = fixture('clean-article.html');
    const out = extractContent(html, 'markdown', 'https://example.com');
    expect(out).toContain('# How to use Playwright');
    expect(out).toContain('persistent context');
    expect(out).not.toContain('<article>');
  });

  it('returns raw HTML when format is html', () => {
    const html = fixture('clean-article.html');
    const out = extractContent(html, 'html', 'https://example.com');
    expect(out).toContain('<article>');
  });

  it('returns plain text when format is text', () => {
    const html = fixture('clean-article.html');
    const out = extractContent(html, 'text', 'https://example.com');
    expect(out).toContain('Playwright is a Node.js library');
    expect(out).not.toContain('<');
    expect(out).not.toContain('#');
  });
});

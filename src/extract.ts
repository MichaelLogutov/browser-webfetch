import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import Turndown from 'turndown';
// @ts-expect-error — turndown-plugin-gfm lacks types
import { gfm } from 'turndown-plugin-gfm';

export type OutputFormat = 'markdown' | 'html' | 'text';

const turndown = new Turndown({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.use(gfm);
turndown.remove(['script', 'style', 'noscript']);

export function extractContent(rawHtml: string, format: OutputFormat, url: string): string {
  if (format === 'html') return rawHtml;

  const dom = new JSDOM(rawHtml, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (format === 'text') {
    if (article?.textContent) return normalizeWhitespace(article.textContent);
    return normalizeWhitespace(dom.window.document.body?.textContent ?? '');
  }

  let htmlForTurndown = article?.content ?? dom.window.document.body?.innerHTML ?? '';
  if (article?.title) {
    htmlForTurndown = `<h1>${article.title}</h1>\n${htmlForTurndown}`;
  }
  return turndown.turndown(htmlForTurndown);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

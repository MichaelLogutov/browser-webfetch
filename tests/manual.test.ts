import { describe, it, expect } from 'vitest';
import type { Page } from 'rebrowser-playwright';
import { waitForManualInteraction } from '../src/manual.js';
import { ErrorCode } from '../src/errors.js';

// Minimal Page stand-in exercising only what waitForManualInteraction uses.
class FakePage {
  private handlers = new Map<string, Array<() => void>>();
  url_ = 'https://idp.example.com/login';
  content_ = '<html><body>login</body></html>';
  on(event: string, h: () => void) {
    const arr = this.handlers.get(event) ?? [];
    arr.push(h);
    this.handlers.set(event, arr);
    return this as unknown as Page;
  }
  off(event: string, h: () => void) {
    const arr = this.handlers.get(event) ?? [];
    const i = arr.indexOf(h);
    if (i >= 0) arr.splice(i, 1);
    return this as unknown as Page;
  }
  url() {
    return this.url_;
  }
  content() {
    return Promise.resolve(this.content_);
  }
  emit(event: string) {
    for (const h of (this.handlers.get(event) ?? []).slice()) h();
  }
  asPage() {
    return this as unknown as Page;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('waitForManualInteraction', () => {
  it('returns the last loaded snapshot when the tab is closed', async () => {
    const page = new FakePage();
    const p = waitForManualInteraction(page.asPage(), { timeoutMs: 5000 });
    page.content_ = '<html><body>dashboard</body></html>';
    page.emit('load');
    await tick();
    page.emit('close');
    const res = await p;
    expect(res.reason).toBe('closed');
    expect(res.html).toContain('dashboard');
  });

  it('finishes early when isResolved becomes true on load', async () => {
    const page = new FakePage();
    const p = waitForManualInteraction(page.asPage(), {
      timeoutMs: 5000,
      isResolved: (url) => url.includes('grafana'),
    });
    page.url_ = 'https://grafana.example.com/d/abc';
    page.content_ = '<html><body>panel</body></html>';
    page.emit('load');
    const res = await p;
    expect(res.reason).toBe('resolved');
    expect(res.html).toContain('panel');
  });

  it('treats the timeout as inactivity — a load event resets the deadline', async () => {
    const page = new FakePage();
    const p = waitForManualInteraction(page.asPage(), { timeoutMs: 100 });
    // Activity (navigation) at t=60ms resets the 100ms deadline to ~160ms.
    await new Promise((r) => setTimeout(r, 60));
    page.content_ = '<html><body>still going</body></html>';
    page.emit('load');
    // At t=120ms we are past the ORIGINAL 100ms deadline; without reset this
    // would already have rejected. Close now → should resolve, not time out.
    await new Promise((r) => setTimeout(r, 60));
    page.emit('close');
    const res = await p;
    expect(res.reason).toBe('closed');
    expect(res.html).toContain('still going');
  });

  it('throws MANUAL_TIMEOUT with an instructive message on timeout', async () => {
    const page = new FakePage();
    await expect(
      waitForManualInteraction(page.asPage(), { timeoutMs: 30 }),
    ).rejects.toMatchObject({
      code: ErrorCode.MANUAL_TIMEOUT,
    });
    await expect(
      waitForManualInteraction(page.asPage(), { timeoutMs: 30 }),
    ).rejects.toThrow(/did not notice|stepped away/i);
  });
});

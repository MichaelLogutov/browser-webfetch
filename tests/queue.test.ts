import { describe, it, expect } from 'vitest';
import { FifoQueue } from '../src/queue.js';
import { BwfError, ErrorCode } from '../src/errors.js';

describe('FifoQueue', () => {
  it('runs jobs in order', async () => {
    const q = new FifoQueue({ queueTimeoutMs: 1000 });
    const order: number[] = [];
    const job = (n: number) =>
      q.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(n);
        return n;
      });
    const results = await Promise.all([job(1), job(2), job(3)]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('serializes jobs (one at a time)', async () => {
    const q = new FifoQueue({ queueTimeoutMs: 1000 });
    let concurrent = 0;
    let maxConcurrent = 0;
    const job = () =>
      q.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });
    await Promise.all([job(), job(), job()]);
    expect(maxConcurrent).toBe(1);
  });

  it('rejects with QUEUE_TIMEOUT when wait exceeds limit', async () => {
    const q = new FifoQueue({ queueTimeoutMs: 30 });
    let releaseSlow!: () => void;
    const slowPromise = new Promise<void>((res) => {
      releaseSlow = res;
    });
    const slow = q.run(() => slowPromise);
    const second = q.run(async () => 'second');
    await expect(second).rejects.toMatchObject({ code: ErrorCode.QUEUE_TIMEOUT });
    releaseSlow();
    await slow;
  });

  it('propagates job errors', async () => {
    const q = new FifoQueue({ queueTimeoutMs: 1000 });
    await expect(q.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

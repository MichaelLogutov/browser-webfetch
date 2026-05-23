import { BwfError, ErrorCode } from './errors.js';

export interface FifoQueueOptions {
  queueTimeoutMs: number;
}

interface Job<T> {
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  timeout: NodeJS.Timeout;
  cancelled: boolean;
}

export class FifoQueue {
  private queue: Job<unknown>[] = [];
  private running = false;

  constructor(private readonly opts: FifoQueueOptions) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        fn,
        resolve,
        reject,
        cancelled: false,
        timeout: setTimeout(() => {
          job.cancelled = true;
          reject(new BwfError(ErrorCode.QUEUE_TIMEOUT, 'queue wait timed out'));
        }, this.opts.queueTimeoutMs),
      };
      this.queue.push(job as Job<unknown>);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        if (job.cancelled) continue;
        clearTimeout(job.timeout);
        try {
          const result = await job.fn();
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

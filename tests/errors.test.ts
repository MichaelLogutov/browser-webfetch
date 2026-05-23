import { describe, it, expect } from 'vitest';
import { BwfError, ErrorCode, exitCodeFor } from '../src/errors.js';

describe('BwfError', () => {
  it('carries a code and message', () => {
    const err = new BwfError(ErrorCode.NAV_TIMEOUT, 'navigation timed out', { url: 'https://x' });
    expect(err.code).toBe(ErrorCode.NAV_TIMEOUT);
    expect(err.message).toBe('navigation timed out');
    expect(err.context).toEqual({ url: 'https://x' });
  });

  it('maps error codes to exit codes', () => {
    expect(exitCodeFor(ErrorCode.NAV_ERROR)).toBe(2);
    expect(exitCodeFor(ErrorCode.NAV_TIMEOUT)).toBe(2);
    expect(exitCodeFor(ErrorCode.MANUAL_TIMEOUT)).toBe(3);
    expect(exitCodeFor(ErrorCode.QUEUE_TIMEOUT)).toBe(4);
    expect(exitCodeFor(ErrorCode.INVALID_ARGS)).toBe(5);
    expect(exitCodeFor(ErrorCode.INTERNAL)).toBe(1);
  });
});

export enum ErrorCode {
  INTERNAL = 'INTERNAL',
  INVALID_ARGS = 'INVALID_ARGS',
  NAV_ERROR = 'NAV_ERROR',
  NAV_TIMEOUT = 'NAV_TIMEOUT',
  MANUAL_TIMEOUT = 'MANUAL_TIMEOUT',
  QUEUE_TIMEOUT = 'QUEUE_TIMEOUT',
}

export class BwfError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BwfError';
  }
}

const EXIT_CODE_MAP: Record<ErrorCode, number> = {
  [ErrorCode.INTERNAL]: 1,
  [ErrorCode.NAV_ERROR]: 2,
  [ErrorCode.NAV_TIMEOUT]: 2,
  [ErrorCode.MANUAL_TIMEOUT]: 3,
  [ErrorCode.QUEUE_TIMEOUT]: 4,
  [ErrorCode.INVALID_ARGS]: 5,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODE_MAP[code] ?? 1;
}

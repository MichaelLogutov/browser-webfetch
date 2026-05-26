export enum ErrorCode {
  INTERNAL = 'INTERNAL',
  INVALID_ARGS = 'INVALID_ARGS',
  NAV_ERROR = 'NAV_ERROR',
  NAV_TIMEOUT = 'NAV_TIMEOUT',
  MANUAL_TIMEOUT = 'MANUAL_TIMEOUT',
  QUEUE_TIMEOUT = 'QUEUE_TIMEOUT',
  LAUNCH_FAILED = 'LAUNCH_FAILED',
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
  [ErrorCode.LAUNCH_FAILED]: 6,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODE_MAP[code] ?? 1;
}

/**
 * Builds a multi-line, user-facing help message for the launch-failure case.
 * Used by both the CLI (printed to stderr on exit) and the MCP server
 * (returned in the tool error response so Claude sees the full guidance).
 */
export function buildLaunchFailureMessage(args: {
  profileDir: string;
  msPlaywrightDir: string;
  originalMessage: string;
}): string {
  return [
    'Browser launch failed: Chrome process started but disconnected before browser-webfetch could attach.',
    '',
    'This is a generic playwright error with several possible causes (most likely first):',
    '',
    '  1. Antivirus blocking Chrome helper processes (Kaspersky, ESET, Norton, etc.)',
    '     Add the Chromium folder to AV exclusions, then retry:',
    `       ${args.msPlaywrightDir}`,
    '',
    '  2. Corrupted profile from previous failed launches.',
    '     Move the profile out of the way and let a fresh one be created:',
    `       ${args.profileDir}`,
    '',
    '  3. Chromium binary missing dependencies.',
    '     Reinstall it forcibly:',
    '       npx playwright-core install chromium --force',
    '',
    'Original playwright error:',
    `  ${args.originalMessage}`,
  ].join('\n');
}

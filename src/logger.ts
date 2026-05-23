type Level = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): Level {
  const env = process.env.BROWSER_WEBFETCH_LOG_LEVEL;
  if (env && ['debug', 'info', 'warn', 'error'].includes(env)) {
    return env as Level;
  }
  return 'info';
}

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (levelOrder[level] < levelOrder[currentLevel()]) return;
  const ts = new Date().toISOString();
  const suffix = extra ? ' ' + JSON.stringify(extra) : '';
  process.stderr.write(`[${ts}] ${level.toUpperCase()} ${msg}${suffix}\n`);
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
};

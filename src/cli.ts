import { cac } from 'cac';
import { BrowserSingleton } from './browser.js';
import { FifoQueue } from './queue.js';
import { fetchUrl } from './fetch.js';
import { BwfError, ErrorCode, exitCodeFor } from './errors.js';
import { resolveDownloadDir } from './download.js';
import { resolveProfileDir } from './profile.js';
import { logger } from './logger.js';
import type { OutputFormat } from './extract.js';

interface CliFlags {
  format?: OutputFormat;
  waitFor?: string;
  navTimeout?: number;
  manualTimeout?: number;
  queueTimeout?: number;
  idleTimeout?: number;
  stealth?: boolean;
  profile?: string;
  json?: boolean;
  download?: boolean;
  downloadDir?: string;
  show?: boolean;
}

export async function runCli(argv: string[]): Promise<number> {
  const cli = cac('browser-webfetch');

  cli
    .command('<url>', 'Fetch a URL through Chromium')
    .option('--format <format>', 'markdown|html|text', { default: 'markdown' })
    .option('--wait-for <selector>', 'CSS selector to wait for')
    .option('--nav-timeout <seconds>', 'Page navigation timeout', { default: 30 })
    .option('--manual-timeout <seconds>', 'Captcha manual-solve timeout', { default: 300 })
    .option('--queue-timeout <seconds>', 'Queue wait timeout', { default: 30 })
    .option('--idle-timeout <seconds>', 'Browser idle shutdown', { default: 300 })
    .option('--no-stealth', 'Disable stealth patches')
    .option('--profile <path>', 'Profile dir override')
    .option('--json', 'Emit JSON envelope')
    .option('--download', 'Save raw bytes (PDF/image/binary) to disk and print the path')
    .option('--download-dir <path>', 'Override download directory')
    .option('--show', 'Show the browser window (default: minimized)')
    .action(async (url: string, flags: CliFlags) => {
      const format = (flags.format ?? 'markdown') as OutputFormat;
      if (!['markdown', 'html', 'text'].includes(format)) {
        throw new BwfError(ErrorCode.INVALID_ARGS, `invalid --format: ${format}`);
      }

      const downloadDir = resolveDownloadDir(flags.downloadDir);
      const browser = new BrowserSingleton({
        profileDir: resolveProfileDir(flags.profile),
        idleTimeoutMs: (flags.idleTimeout ?? 300) * 1000,
        disableStealth: flags.stealth === false,
        startMinimized: flags.show !== true,
        downloadDir,
      });
      const queue = new FifoQueue({ queueTimeoutMs: (flags.queueTimeout ?? 30) * 1000 });

      try {
        const result = await fetchUrl({
          url,
          format,
          waitFor: flags.waitFor,
          navTimeoutMs: (flags.navTimeout ?? 30) * 1000,
          manualTimeoutMs: (flags.manualTimeout ?? 300) * 1000,
          download: flags.download === true,
          downloadDir,
          browser,
          queue,
        });
        if (flags.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(result.body + '\n');
        }
      } finally {
        await browser.close();
      }
    });

  cli.help();
  cli.version('0.1.0');

  try {
    // CAC internally slices its `processArgs` at index 2 (mirroring process.argv
    // layout), so prepend two placeholder entries to keep our argv compatible.
    cli.parse(['node', 'script', ...argv], { run: false });
    // --help / --version are matched by CAC and printed during parse; in that
    // case cli.args will be empty but we should exit 0 rather than 5.
    const askedForHelp = argv.includes('--help') || argv.includes('-h');
    const askedForVersion = argv.includes('--version') || argv.includes('-v');
    if (cli.args.length === 0) {
      if (askedForHelp || askedForVersion) return 0;
      cli.outputHelp();
      return exitCodeFor(ErrorCode.INVALID_ARGS);
    }
    await cli.runMatchedCommand();
    return 0;
  } catch (err) {
    if (err instanceof BwfError) {
      logger.error(err.message, { code: err.code, ...err.context });
      return exitCodeFor(err.code);
    }
    logger.error('unexpected error', { message: err instanceof Error ? err.message : String(err) });
    return exitCodeFor(ErrorCode.INTERNAL);
  }
}

import envPaths from 'env-paths';
import path from 'node:path';

export function resolveProfileDir(override?: string): string {
  if (override !== undefined) return override;
  const fromEnv = process.env.BROWSER_WEBFETCH_PROFILE;
  if (fromEnv !== undefined) return fromEnv;
  const paths = envPaths('browser-webfetch', { suffix: '' });
  return path.join(paths.data, 'profile');
}

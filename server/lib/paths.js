import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
// server/lib/paths.js -> 项目根目录在上两级
export const PROJECT_ROOT = resolve(dirname(__filename), '..', '..');

export const DATA_DIR = (process.env.VBP_DATA_DIR || process.env.VB_DATA_DIR)
  ? resolve(process.env.VBP_DATA_DIR || process.env.VB_DATA_DIR)
  : join(PROJECT_ROOT, 'data');

export const SCREENSHOTS_DIR = join(DATA_DIR, 'screenshots');
export const EXPORTS_DIR = join(DATA_DIR, 'exports');
export const CHROME_PROFILE_DIR = join(DATA_DIR, 'chrome-profile');
export const DB_PATH = join(DATA_DIR, 'viral-brief-plus.db');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const KEYFILE_PATH = join(DATA_DIR, '.keyfile');
export const WEB_DIR = join(PROJECT_ROOT, 'web');

/** 确保所有运行时目录存在（幂等）。 */
export function ensureDirs() {
  for (const d of [DATA_DIR, SCREENSHOTS_DIR, EXPORTS_DIR, CHROME_PROFILE_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

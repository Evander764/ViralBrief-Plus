import { mkdtempSync, mkdirSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-storage-'));

const { CHROME_PROFILE_DIR, SCREENSHOTS_DIR, ensureDirs } = await import('../server/lib/paths.js');
const {
  cleanupStorage,
  inspectStorage,
} = await import('../server/lib/storage-cleanup.js');
const {
  CHROME_SYNC_EXCLUDES,
  chromeStorageSaverArgs,
} = await import('../server/rpa/chrome-launcher.js');

ensureDirs();

function writeSizedFile(path, size, mtime) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 7));
  if (mtime) utimesSync(path, mtime, mtime);
}

test('storage cleanup removes Chrome cache/model data but keeps login state', () => {
  const modelFile = join(CHROME_PROFILE_DIR, 'OptGuideOnDeviceModel', 'model.bin');
  const cacheFile = join(CHROME_PROFILE_DIR, 'Default', 'Cache', 'page-cache.bin');
  const cookieFile = join(CHROME_PROFILE_DIR, 'Default', 'Cookies');
  const localStorageFile = join(CHROME_PROFILE_DIR, 'Default', 'Local Storage', 'leveldb', 'state.ldb');

  writeSizedFile(modelFile, 1024);
  writeSizedFile(cacheFile, 2048);
  writeSizedFile(cookieFile, 64);
  writeSizedFile(localStorageFile, 64);

  const before = inspectStorage();
  assert.ok(before.safeCleanableBytes >= 3072);
  assert.ok(before.chromeTargets.some((item) => item.rel === 'OptGuideOnDeviceModel'));

  const result = cleanupStorage();
  assert.ok(result.removedBytes >= 3072);
  assert.equal(existsSync(modelFile), false);
  assert.equal(existsSync(cacheFile), false);
  assert.equal(existsSync(cookieFile), true);
  assert.equal(existsSync(localStorageFile), true);
});

test('storage cleanup only removes old screenshots when explicitly requested', () => {
  const now = Date.UTC(2026, 5, 1);
  const oldDate = new Date(now - 45 * 24 * 60 * 60 * 1000);
  const freshDate = new Date(now - 2 * 24 * 60 * 60 * 1000);
  const oldShot = join(SCREENSHOTS_DIR, 'old.png');
  const freshShot = join(SCREENSHOTS_DIR, 'fresh.png');
  writeSizedFile(oldShot, 512, oldDate);
  writeSizedFile(freshShot, 512, freshDate);

  cleanupStorage({ includeOldScreenshots: false, now });
  assert.equal(existsSync(oldShot), true);
  assert.equal(existsSync(freshShot), true);

  const result = cleanupStorage({ includeOldScreenshots: true, screenshotDays: 30, now });
  assert.ok(result.removed.some((item) => item.type === 'old_screenshot'));
  assert.equal(existsSync(oldShot), false);
  assert.equal(existsSync(freshShot), true);
});

test('Chrome launch sync and startup args avoid storage-heavy profile data', () => {
  assert.ok(CHROME_SYNC_EXCLUDES.includes('--exclude=OptGuideOnDeviceModel'));
  assert.ok(CHROME_SYNC_EXCLUDES.includes('--exclude=optimization_guide_model_store'));
  assert.ok(CHROME_SYNC_EXCLUDES.includes('--exclude=*/Service Worker/CacheStorage'));

  process.env.VBP_RPA_CHROME_CACHE_MB = '64';
  const args = chromeStorageSaverArgs();
  assert.ok(args.includes('--disk-cache-size=67108864'));
  assert.ok(args.includes('--media-cache-size=33554432'));
  assert.ok(args.includes('--disable-component-update'));
});

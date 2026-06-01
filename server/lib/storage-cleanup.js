import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { CHROME_PROFILE_DIR, DATA_DIR, DB_PATH, EXPORTS_DIR, SCREENSHOTS_DIR } from './paths.js';

export const CHROME_CACHE_TARGETS = [
  { rel: 'OptGuideOnDeviceModel', label: 'Chrome 本地优化模型' },
  { rel: 'OptGuideOnDeviceClassifierModel', label: 'Chrome 本地分类模型' },
  { rel: 'optimization_guide_model_store', label: 'Chrome 优化模型缓存' },
  { rel: 'component_crx_cache', label: 'Chrome 组件缓存' },
  { rel: 'extensions_crx_cache', label: 'Chrome 扩展组件缓存' },
  { rel: 'WasmTtsEngine', label: 'Chrome 语音组件缓存' },
  { rel: 'Crashpad', label: 'Chrome 崩溃报告缓存' },
  { rel: 'ShaderCache', label: 'Chrome 图形缓存' },
  { rel: 'GrShaderCache', label: 'Chrome 图形缓存' },
  { rel: 'GraphiteDawnCache', label: 'Chrome 图形缓存' },
  { rel: 'DawnCache', label: 'Chrome 图形缓存' },
  { rel: 'Default/Cache', label: '页面缓存' },
  { rel: 'Default/Code Cache', label: '脚本缓存' },
  { rel: 'Default/GPUCache', label: 'GPU 缓存' },
  { rel: 'Default/GrShaderCache', label: '图形缓存' },
  { rel: 'Default/GraphiteDawnCache', label: '图形缓存' },
  { rel: 'Default/DawnGraphiteCache', label: '图形缓存' },
  { rel: 'Default/DawnWebGPUCache', label: '图形缓存' },
  { rel: 'Default/DawnCache', label: '图形缓存' },
  { rel: 'Default/Media Cache', label: '媒体缓存' },
  { rel: 'Default/Service Worker/CacheStorage', label: '站点离线缓存' },
  { rel: 'Default/blob_storage', label: '页面临时文件' },
];

function safeResolve(root, relPath = '') {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`拒绝访问数据目录外路径：${relPath}`);
  }
  return target;
}

export function bytesOfPath(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop();
    let st;
    try {
      st = lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let entries = [];
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) stack.push(join(current, entry.name));
      continue;
    }
    total += st.size;
  }
  return total;
}

function collectChromeTargets() {
  return CHROME_CACHE_TARGETS
    .map((target) => {
      const path = safeResolve(CHROME_PROFILE_DIR, target.rel);
      const bytes = bytesOfPath(path);
      return { ...target, path, bytes, exists: bytes > 0 || existsSync(path) };
    })
    .filter((target) => target.exists);
}

function collectOldScreenshots({ olderThanDays = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(olderThanDays) || 30) * 24 * 60 * 60 * 1000;
  const files = [];
  if (!existsSync(SCREENSHOTS_DIR)) return files;
  const stack = [SCREENSHOTS_DIR];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs < cutoff) files.push({ path, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return files;
}

export function inspectStorage({ screenshotDays = 30, now = Date.now() } = {}) {
  const chromeTargets = collectChromeTargets();
  const oldScreenshots = collectOldScreenshots({ olderThanDays: screenshotDays, now });
  const chromeCleanableBytes = chromeTargets.reduce((sum, item) => sum + item.bytes, 0);
  const oldScreenshotBytes = oldScreenshots.reduce((sum, item) => sum + item.bytes, 0);
  return {
    dataDir: DATA_DIR,
    chromeProfileDir: CHROME_PROFILE_DIR,
    screenshotsDir: SCREENSHOTS_DIR,
    totalBytes: bytesOfPath(DATA_DIR),
    chromeProfileBytes: bytesOfPath(CHROME_PROFILE_DIR),
    screenshotsBytes: bytesOfPath(SCREENSHOTS_DIR),
    exportsBytes: bytesOfPath(EXPORTS_DIR),
    databaseBytes: bytesOfPath(DB_PATH),
    chromeCleanableBytes,
    oldScreenshotBytes,
    safeCleanableBytes: chromeCleanableBytes,
    screenshotDays,
    chromeTargets: chromeTargets
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12)
      .map((item) => ({
        rel: item.rel,
        label: item.label,
        bytes: item.bytes,
      })),
    oldScreenshotCount: oldScreenshots.length,
  };
}

function removePath(path) {
  const bytes = bytesOfPath(path);
  if (!existsSync(path)) return { path, bytes: 0, removed: false };
  rmSync(path, { recursive: true, force: true, maxRetries: 2 });
  return { path, bytes, removed: true };
}

export function cleanupStorage({ includeOldScreenshots = false, screenshotDays = 30, now = Date.now() } = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  const before = inspectStorage({ screenshotDays, now });
  const removed = [];

  for (const target of collectChromeTargets()) {
    const result = removePath(target.path);
    if (result.removed) {
      removed.push({
        type: 'chrome_cache',
        label: target.label,
        rel: target.rel,
        bytes: result.bytes,
      });
    }
  }

  if (includeOldScreenshots) {
    for (const file of collectOldScreenshots({ olderThanDays: screenshotDays, now })) {
      try {
        unlinkSync(file.path);
        removed.push({
          type: 'old_screenshot',
          label: '旧截图',
          rel: relative(DATA_DIR, file.path),
          bytes: file.bytes,
        });
      } catch {
        // 单个截图删不掉不影响其它缓存清理。
      }
    }
  }

  const after = inspectStorage({ screenshotDays, now: Date.now() });
  const removedBytes = removed.reduce((sum, item) => sum + item.bytes, 0);
  return {
    ok: true,
    before,
    after,
    removedBytes,
    removedCount: removed.length,
    removed: removed.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
  };
}

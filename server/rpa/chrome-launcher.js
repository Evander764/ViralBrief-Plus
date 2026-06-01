/**
 * Chrome 进程管理器。
 *
 * 自动启动一个带有 --remote-debugging-port 的 Chrome 实例，
 * 并等待端口就绪后返回。默认从用户真实 Chrome 资料目录同步一份本地 RPA
 * 登录态镜像，让小红书/抖音沿用已登录 Cookie；如需隔离空资料目录，可设置
 * VBP_RPA_CHROME_MODE=isolated（兼容旧的 VB_RPA_CHROME_MODE）。
 *
 * 关键改进：
 * - 支持多路径查找 Chrome（Chrome / Chrome Canary / Chromium）
 * - `isPortReady` 真正校验 JSON 响应（避免 "Using unsafe..." 类似非 JSON 被当作 ready）
 * - 更清晰的错误信息帮助用户排查
 */
import { execFile, execFileSync, execSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { log } from '../lib/log.js';
import { CHROME_PROFILE_DIR } from '../lib/paths.js';

const DEFAULT_PORT = 9222;
const LOGGED_IN_CHROME_DIR_MAC = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

/** macOS 上可能的 Chrome 安装路径（按优先级排列）。 */
const CHROME_PATHS_MAC = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export const CHROME_SYNC_EXCLUDES = [
  '--exclude=Singleton*',
  '--exclude=RunningChromeVersion',
  '--exclude=Crashpad',
  '--exclude=BrowserMetrics*',
  '--exclude=OptGuideOnDeviceModel',
  '--exclude=OptGuideOnDeviceClassifierModel',
  '--exclude=optimization_guide_model_store',
  '--exclude=component_crx_cache',
  '--exclude=extensions_crx_cache',
  '--exclude=WasmTtsEngine',
  '--exclude=Safe Browsing',
  '--exclude=*/Cache',
  '--exclude=*/Code Cache',
  '--exclude=*/GPUCache',
  '--exclude=*/GrShaderCache',
  '--exclude=*/GraphiteDawnCache',
  '--exclude=*/DawnGraphiteCache',
  '--exclude=*/DawnWebGPUCache',
  '--exclude=*/ShaderCache',
  '--exclude=*/DawnCache',
  '--exclude=*/Media Cache',
  '--exclude=*/Service Worker/CacheStorage',
  '--exclude=*/blob_storage',
];

export function chromeStorageSaverArgs() {
  const rawMb = Number(process.env.VBP_RPA_CHROME_CACHE_MB || process.env.VB_RPA_CHROME_CACHE_MB || 256);
  const cacheMb = Math.min(2048, Math.max(32, Number.isFinite(rawMb) ? Math.floor(rawMb) : 256));
  const diskCacheBytes = cacheMb * 1024 * 1024;
  const mediaCacheBytes = Math.max(32, Math.floor(cacheMb / 2)) * 1024 * 1024;
  return [
    `--disk-cache-size=${diskCacheBytes}`,
    `--media-cache-size=${mediaCacheBytes}`,
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=OptimizationHints,OptimizationHintsFetching,OptimizationGuideModelDownloading,OnDeviceModelExecution',
  ];
}

/**
 * 查找本机可用的 Chrome 路径。
 * @returns {string|null}
 */
function findChromePath() {
  if (process.platform === 'darwin') {
    for (const p of CHROME_PATHS_MAC) {
      if (existsSync(p)) return p;
    }
  }
  // Linux 兜底
  if (process.platform === 'linux') {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
      try {
        const result = execSync(`which ${cmd}`, { encoding: 'utf8', timeout: 3000 }).trim();
        if (result) return result;
      } catch { /* not found, try next */ }
    }
  }
  return null;
}

/**
 * 取监听调试端口的进程命令行，用于避免误连到旧的空白 RPA Chrome。
 * @returns {string}
 */
function commandForPort(port) {
  try {
    const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | head -n 1`, {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (!pid) return '';
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return '';
  }
}

function isChromeRunning() {
  if (process.platform !== 'darwin') return false;
  try {
    const out = execSync(`pgrep -x "Google Chrome" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
    return !!out;
  } catch {
    return false;
  }
}

function shouldAutoRelaunchChrome() {
  return String(process.env.VBP_RPA_CHROME_AUTO_RELAUNCH || process.env.VB_RPA_CHROME_AUTO_RELAUNCH || 'true').toLowerCase() !== 'false';
}

async function waitForChromeExit(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isChromeRunning()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return !isChromeRunning();
}

async function quitRunningChromeForRpa(userDataDir) {
  if (!shouldAutoRelaunchChrome()) {
    throw new Error(
      '当前 Chrome 已在运行，但没有开启 RPA 调试端口，应用无法直接接管它。\n' +
      '请先完全退出 Google Chrome，再点「一键自动巡检」。应用会用同一份已登录资料目录重新打开 Chrome，登录态会保留。\n' +
      `使用的资料目录：${userDataDir}`
    );
  }

  log.info('当前 Chrome 未开启调试端口，正在温和退出并用已登录资料目录重开。');
  try {
    execFileSync('osascript', ['-e', 'tell application "Google Chrome" to quit'], { timeout: 5000 });
  } catch (e) {
    log.warn(`请求 Chrome 退出失败: ${e.message}`);
  }

  const exited = await waitForChromeExit();
  if (!exited) {
    throw new Error(
      '已请求退出 Google Chrome，但它仍在运行，无法用同一登录资料目录开启 RPA。\n' +
      '请保存当前页面内容并手动退出 Chrome 后重试。'
    );
  }
}

function readChromeProfile(userDataDir) {
  const envProfile = String(process.env.VBP_RPA_CHROME_PROFILE || process.env.VB_RPA_CHROME_PROFILE || '').trim();
  if (envProfile) return envProfile;

  try {
    const localState = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8'));
    return localState.profile?.last_used
      || localState.profile?.last_active_profiles?.[0]
      || 'Default';
  } catch {
    return 'Default';
  }
}

function resolveChromeSession(opts = {}) {
  const mode = String(process.env.VBP_RPA_CHROME_MODE || process.env.VB_RPA_CHROME_MODE || opts.mode || 'logged-in').toLowerCase();
  const explicitDir = opts.dataDir || process.env.VBP_RPA_CHROME_USER_DATA_DIR || process.env.VB_RPA_CHROME_USER_DATA_DIR;
  if (explicitDir) {
    const sourceUserDataDir = resolve(explicitDir);
    return {
      mode: 'custom',
      userDataDir: CHROME_PROFILE_DIR,
      sourceUserDataDir,
      profileDirectory: readChromeProfile(sourceUserDataDir),
      expectsLoggedInProfile: true,
    };
  }

  if (mode === 'isolated') {
    return {
      mode,
      userDataDir: CHROME_PROFILE_DIR,
      sourceUserDataDir: null,
      profileDirectory: 'Default',
      expectsLoggedInProfile: false,
    };
  }

  return {
    mode: 'logged-in',
    userDataDir: CHROME_PROFILE_DIR,
    sourceUserDataDir: LOGGED_IN_CHROME_DIR_MAC,
    profileDirectory: readChromeProfile(LOGGED_IN_CHROME_DIR_MAC),
    expectsLoggedInProfile: true,
  };
}

function syncLoggedInProfile(session) {
  if (!session.expectsLoggedInProfile || !session.sourceUserDataDir) return;
  if (!existsSync(session.sourceUserDataDir)) {
    throw new Error(`未找到已登录 Chrome 资料目录：${session.sourceUserDataDir}`);
  }

  mkdirSync(session.userDataDir, { recursive: true });
  log.info(`同步已登录 Chrome 资料到 RPA 镜像: ${session.sourceUserDataDir} -> ${session.userDataDir}`);
  execFileSync('rsync', [
    '-a',
    '--delete',
    ...CHROME_SYNC_EXCLUDES,
    `${session.sourceUserDataDir}/`,
    `${session.userDataDir}/`,
  ], { timeout: 120000 });
}

function commandUsesUserDataDir(command, userDataDir) {
  if (!command || !userDataDir) return false;
  const normalizedCommand = command.replace(/\\ /g, ' ');
  return normalizedCommand.includes(`--user-data-dir=${userDataDir}`)
    || normalizedCommand.includes(`--user-data-dir="${userDataDir}"`);
}

/**
 * 启动一个带有远程调试端口的 Chrome 实例。
 * @param {object} opts
 * @param {number} [opts.port=9222] 调试端口
 * @param {string} [opts.dataDir] Chrome user-data-dir 路径
 * @param {number} [opts.waitMs=15000] 等待端口就绪的超时（毫秒）
 * @returns {Promise<{child: ChildProcess|null, port: number}>}
 */
export async function launchChrome({ port = DEFAULT_PORT, dataDir, waitMs = 15000, mode } = {}) {
  const session = resolveChromeSession({ dataDir, mode });
  const closeOnDone = !session.expectsLoggedInProfile;

  // 先检查端口是否已经可用（用户可能已经手动启动了 Chrome）
  if (await isPortReady(port)) {
    const command = commandForPort(port);
    if (session.expectsLoggedInProfile && command && command.includes('--user-data-dir=')
        && !commandUsesUserDataDir(command, session.userDataDir)) {
      throw new Error(
        `RPA 调试端口 ${port} 已被另一个 Chrome 占用，但它不是当前登录资料目录。\n` +
        `请关闭旧的 RPA Chrome 后重试，或确认它使用的是：${session.userDataDir}`
      );
    }
    log.info(`Chrome 调试端口 ${port} 已就绪（外部启动），跳过启动。`);
    return { child: null, port, userDataDir: session.userDataDir, profileDirectory: session.profileDirectory, closeOnDone: false };
  }

  if (session.expectsLoggedInProfile && process.platform === 'darwin' && isChromeRunning()) {
    await quitRunningChromeForRpa(session.sourceUserDataDir || session.userDataDir);
  }

  syncLoggedInProfile(session);
  mkdirSync(session.userDataDir, { recursive: true });

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      '未找到 Chrome/Chromium 浏览器。请安装 Google Chrome 后重试。\n' +
      '预期路径（macOS）：/Applications/Google Chrome.app'
    );
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${session.userDataDir}`,
    `--profile-directory=${session.profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
    ...chromeStorageSaverArgs(),
  ];

  log.info(`启动 RPA Chrome: port=${port}, profile=${session.profileDirectory}, dataDir=${session.userDataDir}`);

  const child = execFile(chromePath, args);
  // 收集 stderr 用于诊断（限制大小避免内存泄漏）
  let stderrBuf = '';
  child.stderr?.on('data', (chunk) => {
    if (stderrBuf.length < 2000) stderrBuf += chunk;
  });
  child.on('error', (err) => log.warn(`Chrome 进程错误: ${err.message}`));

  // 等待调试端口就绪
  const ready = await waitForPort(port, waitMs);
  if (!ready) {
    killChrome(child);
    const hint = stderrBuf ? `\nChrome stderr: ${stderrBuf.slice(0, 500)}` : '';
    throw new Error(
      `Chrome 启动超时（等待 ${waitMs}ms 仍未在端口 ${port} 就绪）。\n` +
      `请确保 Google Chrome 已安装且未被其他调试进程占用。${hint}`
    );
  }

  log.info(`Chrome 已就绪，调试端口 ${port}`);
  return { child, port, userDataDir: session.userDataDir, profileDirectory: session.profileDirectory, closeOnDone };
}

/**
 * 轮询检查调试端口是否就绪。
 */
export async function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortReady(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * 检查 Chrome 调试端口是否已就绪。
 * 不只是检查端口能连上，而是校验 /json/version 返回有效 JSON。
 * 这避免了 Chrome 端口已监听但调试接口未完全初始化的误判。
 */
async function isPortReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;

    // 必须校验返回内容是有效 JSON，避免 Chrome 返回警告文本被误认为 ready
    const text = await res.text();
    if (!text || !text.trim()) return false;
    const trimmed = text.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return false;

    // 进一步验证是合法 JSON
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安全关闭 Chrome 子进程。
 */
export function killChrome(child) {
  if (!child) return;
  try {
    child.kill('SIGTERM');
    // 给 2 秒优雅退出，之后强杀
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 2000);
  } catch { /* already dead */ }
}

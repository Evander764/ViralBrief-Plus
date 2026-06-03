import { execFile } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { all } from '../db.js';
import { upsertCapture, markAccountPatrolled, beijingDayStartISO } from '../store.js';
import { loadConfig } from '../config.js';
import { log } from '../lib/log.js';
import { SCREENSHOTS_DIR } from '../lib/paths.js';
import { sortPatrolAccounts } from './patrol.js';

const execFileAsync = promisify(execFile);
const PLATFORM = 'wechat_channels';
export const DEFAULT_WECHAT_VIDEOS_PER_ACCOUNT = 3;
const WECHAT_SCREENSHOT_STANDARD_ATTEMPTS = 3;

export class WechatDesktopPatrolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function runWechatDesktopPatrol({
  onProgress,
  scriptRunner = defaultWechatScriptRunner,
  includePatrolledToday = false,
  shouldStop = () => false,
  now = new Date(),
  maxVideosPerAccount,
} = {}) {
  const cfg = loadConfig();
  const videoCount = normalizeWechatVideoCount(maxVideosPerAccount ?? cfg.rpa?.wechatVideosPerAccount);
  const progress = (msg) => {
    log.info(`[RPA] ${msg}`);
    if (onProgress) onProgress(msg);
  };
  const result = {
    total: 0,
    success: 0,
    failed: 0,
    newItems: 0,
    duplicates: 0,
    discovered: 0,
    skippedToday: 0,
    platformResults: { [PLATFORM]: { total: 0, success: 0, failed: 0, newItems: 0, duplicates: 0 } },
    details: [],
    tabMode: 'desktop-wechat',
    maxTabsPerBatch: 1,
    maxTabsPerPlatform: 1,
    requestedMaxTabsPerBatch: 1,
    maxVideosPerAccount: videoCount,
    windowType: 'desktop_wechat',
    windowStartISO: beijingDayStartISO(now),
    stopped: false,
  };

  const rawAccounts = all('SELECT * FROM accounts WHERE monitor_enabled = 1 AND platform = ?', [PLATFORM]);
  const sortedAccounts = sortPatrolAccounts(rawAccounts);
  const todayStart = beijingDayStartISO(now);
  const accounts = includePatrolledToday ? sortedAccounts : sortedAccounts.filter((acc) => !isPatrolledSince(acc, todayStart));
  result.skippedToday = sortedAccounts.length - accounts.length;
  result.total = accounts.length;
  result.platformResults[PLATFORM].total = accounts.length;

  progress(`开始桌面微信视频号巡检: ${accounts.length} 个账号，每个账号最多读取 ${videoCount} 条视频`);
  if (!accounts.length) return result;

  let prepared = null;
  try {
    prepared = await prepareWechatChannelsFollowing({ scriptRunner, progress });
  } catch (e) {
    const message = friendlyWechatDesktopError(e);
    log.warn(`[RPA] 桌面微信视频号初始化失败: ${message}`);
    for (const acc of accounts) applyOutcome(result, errorOutcome(acc, message));
    return result;
  }

  try {
    for (const [index, acc] of accounts.entries()) {
      if (shouldStop()) {
        result.stopped = true;
        break;
      }
      const outcome = await patrolWechatDesktopAccount(acc, {
        index,
        total: accounts.length,
        progress,
        scriptRunner,
        now,
        shouldStop,
        opened: prepared,
        count: videoCount,
      });
      applyOutcome(result, outcome);
    }
  } finally {
    await cleanupWechatChannelsSession({ scriptRunner, progress });
  }

  result.stopped ||= !!shouldStop();
  progress(`${result.stopped ? '桌面微信视频号巡检已停止' : '桌面微信视频号巡检完成'}: 成功 ${result.success}, 失败 ${result.failed}, 新增 ${result.newItems}, 去重 ${result.duplicates}, 今日已跳过 ${result.skippedToday}`);
  return result;
}

async function patrolWechatDesktopAccount(acc, { index, total, progress, scriptRunner, now, shouldStop, opened, count }) {
  const label = `${PLATFORM}/${acc.nickname || acc.id}`;
  try {
    if (!acc.nickname) return errorOutcome(acc, '缺少视频号博主昵称，无法在桌面微信内匹配');
    progress(`(${index + 1}/${total}) 打开桌面微信视频号博主 ${acc.nickname}`);

    const openCreator = await runStep(scriptRunner, 'open_creator', { nickname: acc.nickname }, progress);
    if (shouldStop()) return stoppedOutcome(acc);

    const videos = await collectWechatDesktopLatestVideos(acc, {
      count,
      progress,
      scriptRunner,
    });
    if (shouldStop()) return stoppedOutcome(acc);
    if (!videos.length) {
      throw new WechatDesktopPatrolError('collect_latest_videos', '未采集到微信视频号最新视频数据');
    }

    const navigation = mergeNavigationEvidence(opened, openCreator);
    const items = videos.map((video, i) => saveWechatDesktopVideoItem(acc, video, { opened: navigation, now, index: i }));
    markAccountPatrolled(acc.id);
    await runStep(scriptRunner, 'close_creator_tabs', { keepTabTitle: '关注' }, progress, { optional: true });
    return okOutcome(acc, items, [{ reason: 'desktop_wechat_latest_videos', detail: `已采集微信视频号最新 ${items.length} 条视频` }]);
  } catch (e) {
    await runStep(scriptRunner, 'close_creator_tabs', { keepTabTitle: '关注' }, progress, { optional: true });
    const message = friendlyWechatDesktopError(e);
    log.warn(`[RPA] 桌面微信视频号巡检失败 ${label}: ${message}`);
    return errorOutcome(acc, message);
  }
}

export async function prepareWechatChannelsFollowing({ scriptRunner = defaultWechatScriptRunner, progress = () => {} } = {}) {
  const evidence = [];
  evidence.push(await runStep(scriptRunner, 'assert_accessibility', {}, progress));

  try {
    for (const [step, payload] of [
      ['activate_wechat_main_window', {}],
      ['open_channels_from_main', {}],
      ['activate_existing_channels', {}],
    ]) {
      evidence.push(await runStep(scriptRunner, step, payload, progress));
    }
  } catch (mainEntryError) {
    progress(`  微信主页面入口不可用，改用视频号独立窗口兜底：${friendlyWechatDesktopError(mainEntryError)}`);
    try {
      for (const [step, payload] of [
        ['activate_channels_dock_icon', {}],
        ['activate_existing_channels', {}],
      ]) {
        evidence.push(await runStep(scriptRunner, step, payload, progress));
      }
    } catch (dockEntryError) {
      throw new WechatDesktopPatrolError(
        dockEntryError.code || 'channels_entry',
        `微信主页面入口失败：${friendlyWechatDesktopError(mainEntryError)}；独立窗口兜底失败：${friendlyWechatDesktopError(dockEntryError)}`,
      );
    }
  }

  for (const [step, payload] of [
    ['open_profile_entry', {}],
    ['open_overview', {}],
    ['open_following_overview', {}],
    ['cleanup_autoplay_tabs', { keepTabTitle: '关注' }],
  ]) {
    evidence.push(await runStep(scriptRunner, step, payload, progress));
  }
  return {
    method: evidence.map((r) => r.method).filter(Boolean).join('+') || 'unknown',
    detail: evidence.map((r) => r.detail).filter(Boolean).join('；'),
    steps: evidence.map((r) => r.code || r.step).filter(Boolean),
  };
}

export async function openWechatDesktopCreator(acc, { scriptRunner = defaultWechatScriptRunner, progress = () => {} } = {}) {
  const opened = await prepareWechatChannelsFollowing({ scriptRunner, progress });
  const creator = await runStep(scriptRunner, 'open_creator', { nickname: acc.nickname }, progress);
  return mergeNavigationEvidence(opened, creator);
}

async function cleanupWechatChannelsSession({ scriptRunner, progress }) {
  await runStep(scriptRunner, 'close_channels_tabs', { returnHome: true, keepTabTitle: '关注' }, progress, { optional: true });
}

async function collectWechatDesktopLatestVideos(acc, { scriptRunner, progress, count }) {
  const items = [];
  for (let index = 0; index < count; index++) {
    if (index === 0) {
      await runStep(scriptRunner, 'open_first_non_pinned_video', { nickname: acc.nickname }, progress);
    } else {
      const next = await runStep(scriptRunner, 'go_next_video', { nickname: acc.nickname, index: index + 1 }, progress, { optional: true });
      if (!next.ok) break;
    }
    const r = await runStep(scriptRunner, 'collect_current_video', { nickname: acc.nickname, index: index + 1 }, progress, { optional: true });
    if (!r.ok) break;
    const item = Array.isArray(r.items) ? r.items[0] : parseCollectedVideos(r.detail)[0];
    if (item && String(item.title || item.bodyExcerpt || item.body_excerpt || '').trim()) {
      items.push(normalizeWechatVideoItem(item, index));
    }
  }
  return items;
}

async function runStep(scriptRunner, step, payload, progress, { optional = false } = {}) {
  const r = await scriptRunner(step, payload);
  if (!r || r.ok !== true) {
    if (optional) {
      const message = r?.message || `桌面微信步骤失败: ${step}`;
      progress(`  ${message}`);
      return { ok: false, code: r?.code || step, method: r?.method || 'optional', detail: message };
    }
    throw new WechatDesktopPatrolError(r?.code || step, r?.message || `桌面微信步骤失败: ${step}`);
  }
  if (r.detail && step !== 'collect_latest_videos') progress(`  ${r.detail}`);
  return { ...r, step, code: r.code || step };
}

function saveWechatDesktopVideoItem(acc, video, { opened, now, index }) {
  const dayKey = beijingDateKey(now);
  const url = video.url || `wechat-desktop://content/${encodeURIComponent(acc.id)}/${dayKey}/${index + 1}`;
  const title = video.title || firstTitleLine(video.bodyExcerpt) || `桌面微信视频号最新视频 ${index + 1} - ${acc.nickname} - ${dayKey}`;
  const metricsEvidence = buildWechatMetricsEvidence(video, opened);
  const res = upsertCapture({
    url,
    platform: PLATFORM,
    content_type: 'video',
    account_id: acc.id,
    author_name: acc.nickname,
    title,
    body_excerpt: video.bodyExcerpt || title,
    metrics_raw: {
      like: video.like,
      share: video.share,
      comment: video.comment,
      favorite: video.favorite,
    },
    metrics_source: 'desktop_agent',
    metrics_confidence: video.metricsConfidence || 'desktop_wechat',
    metrics_evidence: metricsEvidence,
    publish_time: video.publishTime || null,
    screenshot_path: video.screenshotPath || null,
    cover_url: video.coverUrl || null,
    duration_text: video.durationText || null,
  });
  return {
    id: res.id,
    url,
    title,
    duplicate: !!res.duplicate,
    dataStatus: res.status || res.reason || 'needs_review',
    screenshotPath: video.screenshotPath || null,
  };
}

function normalizeWechatVideoItem(item, index) {
  const bodyExcerpt = String(firstPresent(item.bodyExcerpt, item.body_excerpt, item.expandedText, item.expanded_text, item.textDump, item.rawText, '') || '').trim();
  const title = String(firstPresent(item.title, firstTitleLine(bodyExcerpt), '') || '').trim();
  const metricPositions = item.metricPositions || item.metric_positions || {};
  return {
    title,
    bodyExcerpt,
    like: firstPresent(item.like, item.likeCount, item.like_count, item.thumbsUp, item.thumbs_up),
    likeRaw: firstPresent(item.likeRaw, item.like_raw, item.like),
    share: firstPresent(item.share, item.shareCount, item.share_count),
    shareRaw: firstPresent(item.shareRaw, item.share_raw, item.share),
    favorite: firstPresent(item.favorite, item.favoriteCount, item.favorite_count, item.redHeart, item.redHeartCount, item.red_heart_count),
    favoriteRaw: firstPresent(item.favoriteRaw, item.favorite_raw, item.redHeartRaw, item.red_heart_raw, item.favorite),
    comment: firstPresent(item.comment, item.commentCount, item.comment_count),
    commentRaw: firstPresent(item.commentRaw, item.comment_raw, item.comment),
    publishTime: item.publishTime || item.publish_time || null,
    screenshotPath: saveWechatScreenshot(item.screenshotData, item.screenshotPath || item.screenshot_path, index),
    coverUrl: item.coverUrl || item.cover_url || null,
    durationText: item.durationText || item.duration_text || null,
    metricsConfidence: item.metricsConfidence || item.metrics_confidence || 'desktop_wechat',
    url: item.url || null,
    rawText: item.rawText || item.raw_text || item.textDump || item.text_dump || null,
    frames: Array.isArray(item.frames) ? item.frames : [],
    metricPositions,
  };
}

function buildWechatMetricsEvidence(video, opened) {
  const position = (metric) => video.metricPositions?.[metric] || null;
  return {
    navigation: {
      source: 'macos_accessibility',
      method: opened.method,
      detail: opened.detail,
    },
    like: { label: '点赞', raw: video.likeRaw ?? video.like, source: 'desktop_wechat', position: position('like') },
    share: { label: '转发', raw: video.shareRaw ?? video.share, source: 'desktop_wechat', position: position('share') },
    favorite: { label: '收藏/红心', raw: video.favoriteRaw ?? video.favorite, source: 'desktop_wechat', position: position('favorite') },
    comment: { label: '评论', raw: video.commentRaw ?? video.comment, source: 'desktop_wechat', position: position('comment') },
    rawText: video.rawText || null,
    frames: video.frames || [],
  };
}

function mergeNavigationEvidence(...parts) {
  return {
    method: parts.map((p) => p?.method).filter(Boolean).join('+') || 'unknown',
    detail: parts.map((p) => p?.detail).filter(Boolean).join('；'),
  };
}

function firstTitleLine(text) {
  const lines = String(text || '')
    .split(/\r?\n| {2,}/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+(\.\d+)?\s*[万wWkK]?$/.test(line));
  return lines[0] || null;
}

function firstPresent(...values) {
  return values.find((v) => v !== undefined && v !== null && String(v).trim?.() !== '') ?? null;
}

function parseCollectedVideos(detail) {
  const text = String(detail || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch {
    return [];
  }
}

function saveWechatScreenshot(dataUrl, existingPath, index) {
  if (existingPath) return existingPath;
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!m) return null;
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const filename = `rpa_wechat_channels_${Date.now()}_${index + 1}.${ext}`;
    writeFileSync(join(SCREENSHOTS_DIR, filename), Buffer.from(m[2], 'base64'));
    return `screenshots/${filename}`;
  } catch (e) {
    log.warn(`[RPA] 微信视频号截图保存失败: ${e.message}`);
    return null;
  }
}

function okOutcome(acc, items = [], skipReasons = []) {
  return {
    accountId: acc.id,
    nickname: acc.nickname,
    platform: PLATFORM,
    status: 'ok',
    item: items[0] || null,
    items,
    skipReasons,
  };
}

function errorOutcome(acc, error) {
  return {
    accountId: acc?.id || null,
    nickname: acc?.nickname || null,
    platform: PLATFORM,
    status: 'error',
    error,
    item: null,
    items: [],
    skipReasons: [],
  };
}

function stoppedOutcome(acc) {
  return {
    accountId: acc?.id || null,
    nickname: acc?.nickname || null,
    platform: PLATFORM,
    status: 'stopped',
    error: '用户已请求停止巡检',
    item: null,
    items: [],
    skipReasons: [],
  };
}

function applyOutcome(result, outcome) {
  const platformResult = result.platformResults[PLATFORM];
  if (outcome.status === 'ok' || outcome.status === 'stopped') {
    if (outcome.status === 'ok') {
      result.success++;
      platformResult.success++;
    } else {
      result.stopped = true;
    }
    for (const item of outcome.items || []) {
      if (item?.duplicate) {
        result.duplicates++;
        platformResult.duplicates++;
      } else if (item) {
        result.newItems++;
        platformResult.newItems++;
      }
    }
  } else {
    result.failed++;
    platformResult.failed++;
  }
  result.details.push(outcome);
}

function normalizeWechatVideoCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : DEFAULT_WECHAT_VIDEOS_PER_ACCOUNT;
}

function isPatrolledSince(acc, startISO) {
  const t = Date.parse(acc?.last_patrolled_at || '');
  const start = Date.parse(startISO || '');
  return Number.isFinite(t) && Number.isFinite(start) && t >= start;
}

function beijingDateKey(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function friendlyWechatDesktopError(e) {
  const message = String(e?.message || e || '');
  if (e?.code === 'accessibility' || /辅助功能|not allowed|not authorized|assistive access|accessibility/i.test(message)) {
    return '无法控制桌面微信：请在系统设置 > 隐私与安全性 > 辅助功能 中允许 Viral Brief Plus、node 或当前终端控制电脑';
  }
  if (e?.code === 'not_logged_in' || /登录|login/i.test(message)) {
    return '桌面微信未登录或视频号窗口不可用，请先手动登录微信';
  }
  if (e?.code === 'wechat_main_window') {
    return appendWechatDiagnostics('无法从微信主页面开始巡检：请确认微信主窗口已打开且不在设置页', message);
  }
  if (e?.code === 'main_channels_entry') {
    return appendWechatDiagnostics('没有从微信主页面进入视频号：请确认微信主窗口左侧有“视频号”入口；系统会继续尝试绿色视频号独立窗口兜底', message);
  }
  if (e?.code === 'channels_window_required' || /当前窗口不是视频号/.test(message)) {
    return appendWechatDiagnostics('请确认微信主页面能进入视频号，或程序坞里已有绿色的视频号独立窗口图标可作兜底', message);
  }
  if (e?.code === 'channels_dock_icon' || /未找到微信视频号程序坞图标/.test(message)) {
    return appendWechatDiagnostics('主页面入口失败后，也没有找到微信视频号的程序坞兜底图标：请先确认微信主窗口左侧视频号入口可见，或手动打开一次微信视频号让底部程序坞出现绿色的视频号独立窗口图标', message);
  }
  if (e?.code === 'profile_entry' || /未找到视频号右上角人物头像/.test(message)) {
    return appendWechatDiagnostics('没有确认打开视频号右上角的小人入口：请确认当前已进入视频号界面，且窗口右上角能看到小人图标', message);
  }
  if (e?.code === 'open_following_overview' || /未找到左侧关注/.test(message)) {
    return appendWechatDiagnostics('没有找到右上角小人入口后的左侧“关注”：请确认已进入赞和收藏/个人总览页，而不是顶部视频流“关注”页', message);
  }
  if (e?.code === 'open_overview' || /总览入口/.test(message)) {
    return appendWechatDiagnostics('没有确认进入视频号个人总览页：请确认右上角小人入口打开后能看到“赞和收藏”或“我的视频号”等入口', message);
  }
  if (e?.code === 'wechat_window_empty' || /微信主窗口是空白窗口|没有暴露可操作控件/.test(message)) {
    return appendWechatDiagnostics('桌面微信当前没有暴露可操作控件；请确认微信主窗口已登录、可见，并允许本应用使用辅助功能', message);
  }
  return message || '桌面微信视频号自动化失败';
}

function appendWechatDiagnostics(base, message) {
  const diagnostics = String(message || '')
    .split('；')
    .map((part) => part.trim())
    .filter((part) => /Dock候选|窗口诊断|关注候选/.test(part));
  return diagnostics.length ? `${base}；${diagnostics.join('；')}` : base;
}

async function defaultWechatScriptRunner(step, payload = {}) {
  const script = appleScriptForStep(step, payload);
  try {
    const { stdout, stderr } = await execFileAsync('osascript', ['-e', script], { timeout: 60_000 });
    const parsed = parseScriptResult(stdout, stderr);
    if (step === 'activate_wechat_main_window' && parsed.ok) {
      const screenshotPath = await captureWechatDesktopScreenshot('wechat_main', {
        preferredBundleIds: ['com.tencent.xinWeChat', 'com.tencent.flue.WeChatAppEx'],
      });
      parsed.screenshotPath = screenshotPath;
      if (screenshotPath) parsed.detail = `${parsed.detail || '已激活微信主窗口'}；主页面截图=${screenshotPath}`;
    }
    if (step === 'collect_current_video' && parsed.ok) {
      const screenshotPath = await captureWechatDesktopScreenshot(`${payload.nickname || 'wechat'}_${payload.index || 'video'}`);
      const items = Array.isArray(parsed.items) ? parsed.items : parseCollectedVideos(parsed.detail);
      parsed.items = items.map((item) => ({ ...item, screenshotPath: item.screenshotPath || screenshotPath }));
    }
    if (step === 'collect_latest_videos' && parsed.ok) {
      const items = Array.isArray(parsed.items) ? parsed.items : parseCollectedVideos(parsed.detail);
      if (items.length) {
        const screenshotPath = await captureWechatDesktopScreenshot(payload.nickname || 'wechat');
        parsed.items = items.map((item) => ({ ...item, screenshotPath: item.screenshotPath || screenshotPath }));
      }
    }
    return parsed;
  } catch (e) {
    return {
      ok: false,
      code: /not authorized|not allowed|assistive access|辅助功能|accessibility/i.test(String(e.stderr || e.message || ''))
        ? 'accessibility'
        : 'osascript',
      message: String(e.stderr || e.stdout || e.message || 'osascript 执行失败').trim(),
    };
  }
}

async function captureWechatDesktopScreenshot(label, options = {}) {
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const safe = String(label || 'wechat').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 50) || 'wechat';
    const filename = `rpa_wechat_channels_home_${safe}_${Date.now()}.png`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    if (await captureWechatStandardScreenshot(filepath, options)) return `screenshots/${filename}`;
    if (await captureWechatShortcutScreenshot(filepath, options)) return `screenshots/${filename}`;
    return null;
  } catch (e) {
    log.warn(`[RPA] 微信视频号首页截图失败: ${screenshotErrorMessage(e)}`);
    return null;
  }
}

async function captureWechatStandardScreenshot(filepath, options = {}) {
  let lastError = null;
  for (let attemptNo = 1; attemptNo <= WECHAT_SCREENSHOT_STANDARD_ATTEMPTS; attemptNo++) {
    const state = await getWechatScreenshotState(options);
    const attempts = [];
    if (state?.region) attempts.push({ method: 'screen_region', args: ['-x', '-R', `${state.region.x},${state.region.y},${state.region.width},${state.region.height}`, filepath] });
    attempts.push({ method: 'full_screen', args: ['-x', filepath] });
    for (const attempt of attempts) {
      try {
        await execFileAsync('screencapture', attempt.args, { timeout: 10_000 });
        if (hasUsableScreenshotFile(filepath) && wechatScreenshotStateLooksVisible(state)) return true;
        log.warn(`[RPA] 微信视频号第 ${attemptNo}/${WECHAT_SCREENSHOT_STANDARD_ATTEMPTS} 次截图未确认显示微信主界面: ${state?.detail || '未知窗口状态'}`);
        break;
      } catch (e) {
        lastError = e;
        log.warn(`[RPA] 微信视频号${attempt.method === 'screen_region' ? '区域' : '整屏'}截图失败: ${screenshotErrorMessage(e)}`);
      }
    }
    await sleep(350);
  }
  if (lastError) log.warn(`[RPA] 微信视频号标准截图 3 次后仍失败: ${screenshotErrorMessage(lastError)}`);
  return false;
}

async function captureWechatShortcutScreenshot(filepath, options = {}) {
  try {
    const state = await getWechatScreenshotState(options);
    await execFileAsync('osascript', ['-e', wechatScreenshotShortcutStartScript()], { timeout: 8_000 });
    if (state?.region) {
      try {
        const points = wechatScreenshotSelectionPoints(state.region);
        await execFileAsync('swift', ['-e', wechatScreenshotSelectionSwiftScript(), '--', points.x1, points.y1, points.x2, points.y2].map(String), { timeout: 8_000 });
      } catch (e) {
        log.warn(`[RPA] 微信视频号快捷键截图选区失败: ${screenshotErrorMessage(e)}`);
      }
    } else {
      await sleep(1200);
    }
    const { stdout, stderr } = await execFileAsync('osascript', ['-e', wechatScreenshotClipboardSaveScript(filepath)], { timeout: 8_000 });
    const text = String(stdout || stderr || '').trim();
    if (/^OK\|/.test(text) && hasUsableScreenshotFile(filepath)) {
      log.info('[RPA] 微信视频号已使用微信快捷键 Ctrl+Command+A 截图兜底');
      return true;
    }
    log.warn(`[RPA] 微信视频号快捷键截图兜底失败: ${text || '未返回截图数据'}`);
  } catch (e) {
    log.warn(`[RPA] 微信视频号快捷键截图兜底失败: ${screenshotErrorMessage(e)}`);
  }
  return false;
}

function wechatScreenshotShortcutScript(filepath) {
  const targetPath = appleString(filepath);
  return `
on run
  my vbp_start_wechat_screenshot()
  delay 1.5
  return my vbp_save_screenshot_clipboard()
end run

on vbp_start_wechat_screenshot()
  try
    set the clipboard to ""
  end try
  tell application id "com.tencent.xinWeChat"
    activate
    reopen
  end tell
  delay 0.4
  tell application "System Events"
    keystroke "a" using {control down, command down}
  end tell
end vbp_start_wechat_screenshot

on vbp_save_screenshot_clipboard()
  try
    set pngData to the clipboard as «class PNGf»
    set outFile to open for access POSIX file ${targetPath} with write permission
    set eof of outFile to 0
    write pngData to outFile
    close access outFile
    return "OK|wechat_shortcut|saved"
  on error errMsg
    try
      close access POSIX file ${targetPath}
    end try
    return "ERR|wechat_shortcut|" & errMsg
  end try
end vbp_save_screenshot_clipboard
`;
}

function wechatScreenshotShortcutStartScript() {
  return `
on run
  try
    set the clipboard to ""
  end try
  tell application id "com.tencent.xinWeChat"
    activate
    reopen
  end tell
  delay 0.4
  tell application "System Events"
    keystroke "a" using {control down, command down}
  end tell
  return "OK|wechat_shortcut|started"
end run
`;
}

function wechatScreenshotClipboardSaveScript(filepath) {
  const targetPath = appleString(filepath);
  return `
on run
  try
    set pngData to the clipboard as «class PNGf»
    set outFile to open for access POSIX file ${targetPath} with write permission
    set eof of outFile to 0
    write pngData to outFile
    close access outFile
    return "OK|wechat_shortcut|saved"
  on error errMsg
    try
      close access POSIX file ${targetPath}
    end try
    return "ERR|wechat_shortcut|" & errMsg
  end try
end run
`;
}

function wechatScreenshotSelectionPoints(region) {
  const inset = 18;
  return {
    x1: Math.round(region.x + inset),
    y1: Math.round(region.y + inset),
    x2: Math.round(region.x + region.width - inset),
    y2: Math.round(region.y + region.height - inset),
  };
}

function wechatScreenshotSelectionSwiftScript() {
  return `
import CoreGraphics
import Darwin
import Foundation

let args = CommandLine.arguments
guard args.count >= 5,
      let x1 = Double(args[1]),
      let y1 = Double(args[2]),
      let x2 = Double(args[3]),
      let y2 = Double(args[4]) else {
  exit(2)
}

let source = CGEventSource(stateID: .hidSystemState)
func postMouse(_ type: CGEventType, _ x: Double, _ y: Double) {
  let point = CGPoint(x: x, y: y)
  guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
  event.post(tap: .cghidEventTap)
}

postMouse(.mouseMoved, x1, y1)
usleep(120_000)
postMouse(.leftMouseDown, x1, y1)
for step in 1...18 {
  let t = Double(step) / 18.0
  postMouse(.leftMouseDragged, x1 + ((x2 - x1) * t), y1 + ((y2 - y1) * t))
  usleep(18_000)
}
postMouse(.leftMouseUp, x2, y2)
usleep(240_000)
if let down = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true) {
  down.post(tap: .cghidEventTap)
}
usleep(40_000)
if let up = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) {
  up.post(tap: .cghidEventTap)
}
`;
}

function hasUsableScreenshotFile(filepath) {
  try {
    return statSync(filepath).size > 1024;
  } catch {
    return false;
  }
}

function wechatScreenshotStateLooksVisible(state) {
  if (!state) return false;
  if (!state.region) return false;
  if (state.preferencesWindow) return false;
  if (state.protectedLargeWindow) return false;
  return !!state.uiReady;
}

async function getWechatScreenshotState(options = {}) {
  const axState = await getWechatAccessibilityScreenshotState(options);
  const cgState = await getWechatCoreGraphicsScreenshotState();
  return {
    ...axState,
    ...cgState,
    detail: [
      axState?.detail,
      cgState?.protectedLargeWindow ? '存在不可捕捉的微信主窗口' : '',
      cgState?.sharedLargeWindow ? '存在可捕捉的微信窗口' : '',
    ].filter(Boolean).join('；'),
  };
}

async function getWechatAccessibilityScreenshotState(options = {}) {
  const preferredBundleIds = Array.isArray(options.preferredBundleIds) && options.preferredBundleIds.length
    ? options.preferredBundleIds
    : ['com.tencent.flue.WeChatAppEx', 'com.tencent.xinWeChat'];
  const script = `
on run
  tell application "System Events"
    set preferredBids to {${preferredBundleIds.map((bid) => appleString(bid)).join(', ')}}
    repeat with bid in preferredBids
      try
        set p to first process whose bundle identifier is bid
        if (count of windows of p) > 0 then
          set w to window 1 of p
          set posValue to position of w
          set sizeValue to size of w
          set xValue to (item 1 of posValue) as integer
          set yValue to (item 2 of posValue) as integer
          set widthValue to (item 1 of sizeValue) as integer
          set heightValue to (item 2 of sizeValue) as integer
          if widthValue > 100 and heightValue > 100 then
            set dumpText to my vbp_visible_text_dump(p)
            set uiReady to "0"
            set preferencesWindow to "0"
            if dumpText contains "视频号" or dumpText contains "关注" or dumpText contains "点赞" or dumpText contains "评论" or dumpText contains "收藏" or dumpText contains "展开" or dumpText contains "赞和收藏" then set uiReady to "1"
            if (dumpText contains "账号与存储" and dumpText contains "快捷键") or (dumpText contains "恢复默认设置" and dumpText contains "截图") then set preferencesWindow to "1"
            return (xValue as text) & "|" & (yValue as text) & "|" & (widthValue as text) & "|" & (heightValue as text) & "|" & uiReady & "|" & preferencesWindow
          end if
        end if
      end try
    end repeat
  end tell
  return ""
end run

on vbp_visible_text_dump(targetProcessRef)
  tell application "System Events"
    set out to ""
    try
      repeat with el in entire contents of targetProcessRef
        set label to my vbp_text(el)
        if label is not "" then
          if out does not contain label then set out to out & label & linefeed
        end if
        if length of out > 5000 then exit repeat
      end repeat
    end try
    return out
  end tell
end vbp_visible_text_dump

on vbp_text(el)
  tell application "System Events"
    set parts to {}
    try
      set end of parts to name of el
    end try
    try
      set end of parts to description of el
    end try
    try
      set v to value of el
      if v is not missing value then set end of parts to v as text
    end try
    return parts as text
  end tell
end vbp_text
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 8_000 });
    const [xRaw, yRaw, widthRaw, heightRaw, uiReadyRaw, preferencesRaw] = String(stdout || '').trim().split('|');
    const parts = [xRaw, yRaw, widthRaw, heightRaw].map((part) => Number(part));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return {};
    const [x, y, width, height] = parts.map((n) => Math.round(n));
    if (width <= 100 || height <= 100) return {};
    return {
      region: { x, y, width, height },
      uiReady: uiReadyRaw === '1',
      preferencesWindow: preferencesRaw === '1',
      detail: `AX窗口 ${x},${y},${width},${height} uiReady=${uiReadyRaw === '1'} preferences=${preferencesRaw === '1'}`,
    };
  } catch (e) {
    log.warn(`[RPA] 微信视频号截图区域读取失败: ${screenshotErrorMessage(e)}`);
    return {};
  }
}

async function getWechatCoreGraphicsScreenshotState() {
  const script = `
import CoreGraphics
let list = (CGWindowListCopyWindowInfo(CGWindowListOption(arrayLiteral: .optionAll), kCGNullWindowID) as? [[String: Any]]) ?? []
var protectedLarge = false
var sharedLarge = false
for window in list {
  let owner = (window[kCGWindowOwnerName as String] as? String) ?? ""
  if !(owner.localizedCaseInsensitiveContains("wechat") || owner.contains("微信")) { continue }
  let layer = (window[kCGWindowLayer as String] as? Int) ?? 0
  if layer != 0 { continue }
  let sharing = (window[kCGWindowSharingState as String] as? Int) ?? -1
  let bounds = (window[kCGWindowBounds as String] as? [String: Any]) ?? [:]
  let x = (bounds["X"] as? Double) ?? 0
  let y = (bounds["Y"] as? Double) ?? 0
  let width = (bounds["Width"] as? Double) ?? 0
  let height = (bounds["Height"] as? Double) ?? 0
  if x >= 0 && y >= 0 && width >= 500 && height >= 350 {
    if sharing == 0 { protectedLarge = true }
    if sharing == 1 { sharedLarge = true }
  }
}
print("\\(protectedLarge ? 1 : 0)|\\(sharedLarge ? 1 : 0)")
`;
  try {
    const { stdout } = await execFileAsync('swift', ['-e', script], { timeout: 8_000 });
    const [protectedRaw, sharedRaw] = String(stdout || '').trim().split('|');
    return {
      protectedLargeWindow: protectedRaw === '1',
      sharedLargeWindow: sharedRaw === '1',
    };
  } catch {
    return {};
  }
}

function screenshotErrorMessage(e) {
  const message = String(e?.stderr || e?.stdout || e?.message || e || '').trim();
  if (/could not create image from window|无法捕捉窗口图像/i.test(message)) {
    return `${message}；已禁用窗口 ID 截图，请使用屏幕区域截图兜底`;
  }
  if (/not authorized|not allowed|screen|capture|permission|TCC|录制|权限/i.test(message)) {
    return `${message || '截图权限不足'}；请在系统设置 > 隐私与安全性 > 屏幕与系统音频录制 中允许 Viral Brief Plus 后重启应用`;
  }
  return message || '未知错误';
}

function parseScriptResult(stdout, stderr) {
  const text = String(stdout || '').trim() || String(stderr || '').trim();
  if (!text) return { ok: false, code: 'osascript', message: 'osascript 未返回结果' };
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return {
          ok: parsed.ok === true,
          code: parsed.code || parsed.step || 'osascript',
          method: parsed.method || '',
          detail: parsed.detail || '',
          message: parsed.message || parsed.detail || '',
          items: Array.isArray(parsed.items) ? parsed.items : undefined,
        };
      }
    } catch {
      // fall through to legacy pipe parser
    }
  }
  const [status, code = '', method = '', ...rest] = text.split('|');
  if (status === 'OK') return { ok: true, code, method, detail: rest.join('|') };
  return { ok: false, code: code || 'osascript', message: rest.join('|') || text || 'osascript 未返回结果' };
}

function appleScriptForStep(step, payload = {}) {
  const nickname = appleString(payload.nickname || '');
  const count = normalizeWechatVideoCount(payload.count);
  const ordinal = Number.isFinite(Number(payload.index)) ? Math.max(1, Math.floor(Number(payload.index))) : 1;
  const keepTabTitle = appleString(payload.keepTabTitle || '关注');
  const knownSteps = new Set([
    'assert_accessibility',
    'activate_wechat_main_window',
    'open_channels_from_main',
    'activate_channels_dock_icon',
    'activate_existing_channels',
    'open_profile_entry',
    'open_overview',
    'open_following_overview',
    'cleanup_autoplay_tabs',
    'open_creator',
    'open_first_non_pinned_video',
    'collect_current_video',
    'go_next_video',
    'collect_latest_videos',
    'close_creator_tabs',
    'close_channels_tabs',
  ]);
  if (!knownSteps.has(step)) throw new Error(`unknown desktop wechat step: ${step}`);

  return `
on run
  tell application "System Events"
    if UI elements enabled is false then return my vbp_result(false, "accessibility", "ax", "辅助功能权限未开启")
  end tell
  if "${step}" is "assert_accessibility" then
    tell application id "com.tencent.xinWeChat"
      activate
      reopen
    end tell
    delay 0.6
  end if
  tell application "System Events"
    set targetProcess to my vbp_process("${step}")
    if targetProcess is missing value then return my vbp_result(false, "not_logged_in", "ax", "未找到桌面微信进程")
    set visible of targetProcess to true
    set frontmost of targetProcess to true
    my vbp_raise_window(targetProcess)
    if "${step}" is "assert_accessibility" then
      try
        set windowCount to count of windows of targetProcess
        if windowCount < 1 then return my vbp_result(false, "not_logged_in", "ax", "桌面微信没有可用窗口；请先登录微信并打开主窗口")
        set ignored to name of window 1 of targetProcess
      on error errMsg
        return my vbp_result(false, "accessibility", "ax", errMsg)
      end try
      return my vbp_result(true, "assert_accessibility", "ax", "辅助功能权限可用，已验证可读取微信窗口")
    else if "${step}" is "activate_wechat_main_window" then
      tell application id "com.tencent.xinWeChat"
        activate
        reopen
      end tell
      delay 0.8
      set targetProcess to my vbp_process("${step}")
      if targetProcess is missing value then return my vbp_result(false, "not_logged_in", "wechat_main", "未找到桌面微信主进程")
      set visible of targetProcess to true
      set frontmost of targetProcess to true
      my vbp_raise_window(targetProcess)
      if my vbp_window_looks_preferences(targetProcess) then return my vbp_result(false, "wechat_main_window", "wechat_main", "当前窗口是微信设置页，请切回微信主页面；" & my vbp_context_diagnostics(targetProcess))
      if (my vbp_accessible_content_count(targetProcess)) < 1 then return my vbp_result(false, "wechat_window_empty", "wechat_main", "微信主窗口没有暴露可操作控件；" & my vbp_context_diagnostics(targetProcess))
      return my vbp_result(true, "activate_wechat_main_window", "wechat_main", "已激活微信主窗口并确认主页面可读取")
    else if "${step}" is "open_channels_from_main" then
      if my vbp_window_looks_channels(targetProcess) then return my vbp_result(true, "open_channels_from_main", "already_channels", "当前窗口已在视频号界面")
      if my vbp_window_looks_preferences(targetProcess) then return my vbp_result(false, "main_channels_entry", "wechat_main_sidebar", "当前窗口是微信设置页，无法从主页面进入视频号；" & my vbp_context_diagnostics(targetProcess))
      if my vbp_click_main_channels_entry(targetProcess) then
        delay 1.0
        set targetProcess to my vbp_process("activate_existing_channels")
        if targetProcess is not missing value then
          set visible of targetProcess to true
          set frontmost of targetProcess to true
          my vbp_raise_window(targetProcess)
          if my vbp_window_looks_channels(targetProcess) then return my vbp_result(true, "open_channels_from_main", "wechat_main_sidebar", "已从微信主页面进入视频号")
          return my vbp_result(false, "main_channels_entry", "wechat_main_sidebar", "已点击微信主页面视频号入口，但没有验证为视频号界面；" & my vbp_context_diagnostics(targetProcess))
        end if
      end if
      return my vbp_result(false, "main_channels_entry", "wechat_main_sidebar", "未在微信主页面找到视频号入口；" & my vbp_context_diagnostics(targetProcess))
    else if "${step}" is "activate_channels_dock_icon" then
      set dockResult to my vbp_click_channels_dock_icon()
      if dockResult does not contain "CLICKED|" then
        if my vbp_window_looks_channels(targetProcess) then return my vbp_result(true, "activate_channels_dock_icon", "already_visible", "当前微信窗口已验证为视频号界面")
        return my vbp_result(false, "channels_dock_icon", "dock_icon", "未找到微信视频号程序坞图标；" & my vbp_dock_diagnostics() & "；" & my vbp_context_diagnostics(targetProcess))
      end if
      delay 1.0
      set targetProcess to my vbp_process("${step}")
      if targetProcess is not missing value then
        set visible of targetProcess to true
        set frontmost of targetProcess to true
        my vbp_raise_window(targetProcess)
        if my vbp_window_looks_channels(targetProcess) then return my vbp_result(true, "activate_channels_dock_icon", "dock_icon", "已点击程序坞微信视频号图标并接管窗口")
        return my vbp_result(false, "channels_window_required", "dock_icon", "已点击程序坞微信视频号图标，但当前窗口仍未验证为视频号；" & my vbp_context_diagnostics(targetProcess))
      end if
      return my vbp_result(false, "channels_window_required", "dock_icon", "已点击程序坞微信视频号图标，但没有找到可接管的微信窗口；" & my vbp_dock_diagnostics())
    else if "${step}" is "activate_existing_channels" then
      if my vbp_window_looks_preferences(targetProcess) then
        return my vbp_result(false, "channels_window_required", "channels_dock_window", "当前窗口是微信设置页；请确认微信主页面可进入视频号，或使用绿色视频号独立窗口兜底；" & my vbp_context_diagnostics(targetProcess))
      end if
      if (my vbp_accessible_content_count(targetProcess)) < 1 then
        return my vbp_result(false, "wechat_window_empty", "channels_dock_window", "当前微信窗口没有暴露可操作控件；请确认微信主窗口或视频号窗口可见；" & my vbp_context_diagnostics(targetProcess))
      end if
      if my vbp_window_looks_channels(targetProcess) then return my vbp_result(true, "activate_existing_channels", "channels_dock_window", "已接管并验证微信视频号窗口")
      return my vbp_result(false, "channels_window_required", "channels_dock_window", "当前窗口不是视频号；请先点击程序坞里的绿色视频号独立窗口图标；" & my vbp_context_diagnostics(targetProcess))
    else if "${step}" is "open_profile_entry" then
      if my vbp_click_profile_entry(targetProcess) then
        if my vbp_profile_entry_opened(targetProcess) then return my vbp_result(true, "open_profile_entry", "profile_icon", "已点击右上角小人入口，并确认出现个人总览入口")
        return my vbp_result(false, "profile_entry", "profile_icon", "已点击右上角小人入口，但没有看到赞和收藏/个人总览入口；" & my vbp_context_diagnostics(targetProcess))
      end if
      return my vbp_result(false, "profile_entry", "profile_icon", "未找到视频号右上角人物头像；" & my vbp_context_diagnostics(targetProcess))
    else if "${step}" is "open_overview" then
      if my vbp_window_looks_profile_overview(targetProcess) or (my vbp_left_following_candidate_count(targetProcess)) > 0 then return my vbp_result(true, "open_overview", "already_on_overview", "已确认当前在个人总览/关注入口页")
      if my vbp_click_named(targetProcess, {"赞和收藏", "我的视频号", "个人中心", "个人主页"}, false) then
        if my vbp_window_looks_profile_overview(targetProcess) or (my vbp_left_following_candidate_count(targetProcess)) > 0 then return my vbp_result(true, "open_overview", "ax", "已进入赞和收藏/个人总览页")
        return my vbp_result(false, "open_overview", "ax", "已点击总览入口，但没有确认进入个人总览；" & my vbp_context_diagnostics(targetProcess))
      end if
      return my vbp_result(false, "open_overview", "ax", "未找到赞和收藏/个人总览入口；" & my vbp_context_diagnostics(targetProcess))
    else if "${step}" is "open_following_overview" then
      if my vbp_click_left_following(targetProcess) then return my vbp_result(true, "open_following_overview", "left_sidebar_only", "已点击个人总览左侧关注；" & my vbp_following_diagnostics(targetProcess))
      return my vbp_result(false, "open_following_overview", "left_sidebar_only", "未找到左侧关注，避免误点顶部关注；" & my vbp_following_diagnostics(targetProcess) & "；" & my vbp_context_diagnostics(targetProcess))
    else if "${step}" is "cleanup_autoplay_tabs" then
      return my vbp_result(true, "cleanup_autoplay_tabs", "protect_following_tab", my vbp_cleanup_autoplay_tabs(targetProcess, ${keepTabTitle}))
    else if "${step}" is "open_creator" then
      if my vbp_click_creator_in_following(targetProcess, ${nickname}) then return my vbp_result(true, "open_creator", "following_list", "已从关注总览打开匹配博主")
      if my vbp_search_and_click_creator(targetProcess, ${nickname}) then return my vbp_result(true, "open_creator", "search", "已搜索并打开匹配博主")
      return my vbp_result(false, "creator_not_found", "following_list", "未在桌面微信视频号里找到匹配博主")
    else if "${step}" is "open_first_non_pinned_video" then
      if my vbp_open_first_non_pinned_video(targetProcess) then return my vbp_result(true, "open_first_non_pinned_video", "creator_grid", "已打开第一条非置顶视频")
      return my vbp_result(false, "open_first_non_pinned_video", "creator_grid", "未找到可打开的非置顶视频；" & my vbp_context_diagnostics(targetProcess))
    else if "${step}" is "collect_current_video" then
      delay 0.9
      my vbp_pause_video_if_possible(targetProcess)
      my vbp_click_expand_if_present(targetProcess)
      set itemJson to my vbp_collect_current_video_json(targetProcess, ${ordinal})
      if itemJson is "" then return my vbp_result(false, "collect_current_video", "current_video", "当前视频没有可采集文本或指标；" & my vbp_context_diagnostics(targetProcess))
      return "{\\"ok\\":true,\\"code\\":\\"collect_current_video\\",\\"method\\":\\"current_video\\",\\"detail\\":\\"collected current\\",\\"items\\":[" & itemJson & "]}"
    else if "${step}" is "go_next_video" then
      if my vbp_click_next_video_arrow(targetProcess) then return my vbp_result(true, "go_next_video", "fixed_right_next", "已点击右侧下一个视频箭头")
      return my vbp_result(false, "go_next_video", "fixed_right_next", "未找到或无法点击右侧下一个视频箭头")
    else if "${step}" is "collect_latest_videos" then
      return my vbp_collect_latest_videos(targetProcess, ${count})
    else if "${step}" is "close_creator_tabs" then
      return my vbp_result(true, "close_creator_tabs", "protect_following_tab", my vbp_close_non_following_tabs(targetProcess, ${keepTabTitle}))
    else if "${step}" is "close_channels_tabs" then
      set closeDetail to my vbp_close_non_following_tabs(targetProcess, ${keepTabTitle})
      my vbp_return_wechat_home(targetProcess)
      return my vbp_result(true, "close_channels_tabs", "cleanup", closeDetail & "；已回到微信首页")
    end if
  end tell
end run

on vbp_process(stepName)
  tell application "System Events"
    if stepName is "activate_wechat_main_window" or stepName is "open_channels_from_main" then
      set preferredBids to {"com.tencent.xinWeChat"}
    else
      set preferredBids to {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
    end if
    repeat with bid in preferredBids
      try
        set p to first process whose bundle identifier is bid
        if (count of windows of p) > 0 then return p
      end try
    end repeat
    repeat with bid in preferredBids
      try
        return first process whose bundle identifier is bid
      end try
    end repeat
  end tell
  return missing value
end vbp_process

on vbp_raise_window(targetProcessRef)
  tell application "System Events"
    try
      set value of attribute "AXMinimized" of window 1 of targetProcessRef to false
    end try
    try
      perform action "AXRaise" of window 1 of targetProcessRef
    end try
    delay 0.4
  end tell
end vbp_raise_window

on vbp_click_channels_dock_icon()
  tell application "System Events"
    try
      tell process "Dock"
        set exactCandidate to missing value
        set exactLabel to ""
        set wechatCount to 0
        set rightmostWechat to missing value
        set rightmostWechatX to -1
        repeat with dockItem in UI elements of list 1
          set labelText to my vbp_dock_label(dockItem)
          set xValue to -1
          try
            set p to position of dockItem
            set xValue to item 1 of p
          end try
          if labelText contains "视频号" or labelText contains "Channels" or labelText contains "WeChatAppEx" then
            set exactCandidate to dockItem
            set exactLabel to labelText
          else if labelText is "微信" or labelText is "WeChat" then
            set wechatCount to wechatCount + 1
            if xValue > rightmostWechatX then
              set rightmostWechatX to xValue
              set rightmostWechat to dockItem
            end if
          end if
        end repeat
        if exactCandidate is not missing value then return my vbp_click_dock_item_center(exactCandidate, exactLabel)
        if wechatCount > 1 and rightmostWechat is not missing value then return my vbp_click_dock_item_center(rightmostWechat, "微信")
      end tell
    end try
  end tell
  return "NO_MATCH"
end vbp_click_channels_dock_icon

on vbp_dock_label(dockItem)
  set parts to {}
  try
    set end of parts to name of dockItem as text
  end try
  try
    set end of parts to description of dockItem as text
  end try
  return parts as text
end vbp_dock_label

on vbp_dock_diagnostics()
  tell application "System Events"
    try
      tell process "Dock"
        set labels to {}
        repeat with dockItem in UI elements of list 1
          set labelText to my vbp_dock_label(dockItem)
          if labelText is not "" then set end of labels to labelText
          if (count of labels) >= 24 then exit repeat
        end repeat
        return "Dock候选=" & my vbp_join_list(labels, " / ")
      end tell
    end try
  end tell
  return "Dock候选=无法读取"
end vbp_dock_diagnostics

on vbp_click_dock_item_center(dockItem, labelText)
  try
    set p to position of dockItem
    set s to size of dockItem
    set centerX to (item 1 of p) + ((item 1 of s) / 2)
    set centerY to (item 2 of p) + ((item 2 of s) / 2)
    click at {centerX, centerY}
    delay 0.8
    return "CLICKED|" & labelText
  end try
  return "NO_CLICK|" & labelText
end vbp_click_dock_item_center

on vbp_click_main_channels_entry(targetProcessRef)
  tell application "System Events"
    if my vbp_click_named_left_sidebar(targetProcessRef, {"视频号", "Channels"}) then return true
    try
      set w to window 1 of targetProcessRef
      set wp to position of w
      set ws to size of w
      repeat with yOffset in {210, 250, 290, 330}
        click at {(item 1 of wp) + 34, (item 2 of wp) + yOffset}
        delay 0.7
        set channelsProcess to my vbp_process("activate_existing_channels")
        if channelsProcess is not missing value then
          set visible of channelsProcess to true
          set frontmost of channelsProcess to true
          my vbp_raise_window(channelsProcess)
          if my vbp_window_looks_channels(channelsProcess) then return true
        end if
        set visible of targetProcessRef to true
        set frontmost of targetProcessRef to true
        my vbp_raise_window(targetProcessRef)
      end repeat
    end try
  end tell
  return false
end vbp_click_main_channels_entry

on vbp_click_named_left_sidebar(targetProcessRef, terms)
  tell application "System Events"
    try
      set w to window 1 of targetProcessRef
      set wp to position of w
      set ws to size of w
      repeat with el in entire contents of targetProcessRef
        set label to my vbp_text(el)
        repeat with term in terms
          if label contains (term as text) then
            try
              set p to position of el
              set s to size of el
              if (item 1 of p) < (item 1 of wp) + ((item 1 of ws) * 0.42) and (item 2 of p) > (item 2 of wp) + 70 and (item 2 of p) < (item 2 of wp) + (item 2 of ws) - 40 then
                if (item 1 of s) < ((item 1 of ws) * 0.55) then
                  click el
                  delay 1.0
                  return true
                end if
              end if
            end try
          end if
        end repeat
      end repeat
    end try
  end tell
  return false
end vbp_click_named_left_sidebar

on vbp_window_looks_preferences(targetProcessRef)
  try
    set dumpText to my vbp_visible_text_dump(targetProcessRef)
    if dumpText contains "账号与存储" and dumpText contains "快捷键" then return true
    if dumpText contains "关于微信" and dumpText contains "控制范围" then return true
    if dumpText contains "恢复默认设置" and dumpText contains "截图" then return true
  end try
  return false
end vbp_window_looks_preferences

on vbp_accessible_content_count(targetProcessRef)
  tell application "System Events"
    try
      return count of entire contents of targetProcessRef
    end try
  end tell
  return 0
end vbp_accessible_content_count

on vbp_window_looks_channels(targetProcessRef)
  try
    set bidText to bundle identifier of targetProcessRef as text
    if bidText is "com.tencent.flue.WeChatAppEx" then return true
  end try
  try
    set dumpText to my vbp_visible_text_dump(targetProcessRef)
    if dumpText contains "视频号" then return true
    if dumpText contains "赞和收藏" or dumpText contains "浏览记录" or dumpText contains "我的视频号" then return true
    if dumpText contains "直播" and dumpText contains "朋友" and dumpText contains "推荐" then return true
    if dumpText contains "展开" and (dumpText contains "评论" or dumpText contains "收藏" or dumpText contains "点赞") then return true
  end try
  return false
end vbp_window_looks_channels

on vbp_window_looks_profile_overview(targetProcessRef)
  try
    set dumpText to my vbp_visible_text_dump(targetProcessRef)
    if dumpText contains "赞和收藏" then return true
    if dumpText contains "我的视频号" then return true
    if dumpText contains "浏览记录" then return true
    if dumpText contains "个人主页" then return true
    if dumpText contains "关注" and dumpText contains "粉丝" then return true
  end try
  return false
end vbp_window_looks_profile_overview

on vbp_profile_entry_opened(targetProcessRef)
  if my vbp_window_looks_profile_overview(targetProcessRef) then return true
  try
    set dumpText to my vbp_visible_text_dump(targetProcessRef)
    if dumpText contains "赞和收藏" or dumpText contains "我的视频号" or dumpText contains "个人中心" or dumpText contains "个人主页" then return true
  end try
  return false
end vbp_profile_entry_opened

on vbp_left_following_candidate_count(targetProcessRef)
  tell application "System Events"
    set countValue to 0
    try
      set w to window 1 of targetProcessRef
      set wp to position of w
      set ws to size of w
      repeat with el in entire contents of targetProcessRef
        set label to my vbp_text(el)
        if label contains "关注" then
          try
            set p to position of el
            if (item 1 of p) < (item 1 of wp) + ((item 1 of ws) * 0.42) and (item 2 of p) > (item 2 of wp) + 80 then set countValue to countValue + 1
          end try
        end if
      end repeat
    end try
    return countValue
  end tell
end vbp_left_following_candidate_count

on vbp_context_diagnostics(targetProcessRef)
  tell application "System Events"
    try
      set bidText to ""
      set procName to ""
      set windowName to ""
      set contentCount to 0
      try
        set bidText to bundle identifier of targetProcessRef as text
      end try
      try
        set procName to name of targetProcessRef as text
      end try
      try
        set windowName to name of window 1 of targetProcessRef as text
      end try
      try
        set contentCount to count of entire contents of targetProcessRef
      end try
      set dumpText to my vbp_visible_text_dump(targetProcessRef)
      set signals to {}
      if dumpText contains "视频号" then set end of signals to "视频号"
      if dumpText contains "关注" then set end of signals to "关注"
      if dumpText contains "赞和收藏" then set end of signals to "赞和收藏"
      if dumpText contains "我的视频号" then set end of signals to "我的视频号"
      if dumpText contains "展开" then set end of signals to "展开"
      if dumpText contains "评论" then set end of signals to "评论"
      if dumpText contains "收藏" then set end of signals to "收藏"
      return "窗口诊断=bundle " & bidText & "，进程 " & procName & "，窗口 " & windowName & "，控件 " & (contentCount as text) & "，信号 " & my vbp_join_list(signals, "/") & "，文本片段 " & my vbp_compact_text(dumpText, 260)
    end try
  end tell
  return "窗口诊断=无法读取"
end vbp_context_diagnostics

on vbp_text(el)
  tell application "System Events"
    set parts to {}
    try
      set end of parts to name of el
    end try
    try
      set end of parts to description of el
    end try
    try
      set v to value of el
      if v is not missing value then set end of parts to v as text
    end try
    return parts as text
  end tell
end vbp_text

on vbp_click_named(targetProcessRef, terms, rightSideOnly)
  tell application "System Events"
    set elems to entire contents of targetProcessRef
    repeat with el in elems
      set label to my vbp_text(el)
      repeat with term in terms
        if label contains (term as text) then
          if rightSideOnly then
            try
              set p to position of el
              set w to window 1 of targetProcessRef
              set wp to position of w
              set ws to size of w
              if item 1 of p < (item 1 of wp) + ((item 1 of ws) * 0.55) then exit repeat
            end try
          end if
          try
            click el
            delay 1.0
            return true
          end try
        end if
      end repeat
    end repeat
  end tell
  return false
end vbp_click_named

on vbp_click_profile_entry(targetProcessRef)
  tell application "System Events"
    if my vbp_click_named(targetProcessRef, {"头像", "个人", "我的", "我", "Profile"}, true) then return true
    try
      set w to window 1 of targetProcessRef
      set p to position of w
      set s to size of w
      click at {(item 1 of p) + (item 1 of s) - 54, (item 2 of p) + 108}
      delay 1.1
      return true
    end try
  end tell
  return false
end vbp_click_profile_entry

on vbp_click_left_following(targetProcessRef)
  tell application "System Events"
    set w to window 1 of targetProcessRef
    set wp to position of w
    set ws to size of w
    repeat with cutoffFactor in {0.34, 0.42}
      repeat with el in entire contents of targetProcessRef
        set label to my vbp_text(el)
        if label contains "关注" then
          try
            set p to position of el
            set s to size of el
            if (item 1 of p) < (item 1 of wp) + ((item 1 of ws) * cutoffFactor) and (item 2 of p) > (item 2 of wp) + 80 and (item 2 of p) < (item 2 of wp) + (item 2 of ws) - 40 then
              if (item 1 of s) < ((item 1 of ws) * 0.5) then
                click el
                delay 1.1
                return true
              end if
            end if
          end try
        end if
      end repeat
    end repeat
  end tell
  return false
end vbp_click_left_following

on vbp_following_diagnostics(targetProcessRef)
  tell application "System Events"
    try
      set w to window 1 of targetProcessRef
      set wp to position of w
      set ws to size of w
      set allCount to 0
      set leftCount to 0
      set samples to {}
      repeat with el in entire contents of targetProcessRef
        set label to my vbp_text(el)
        if label contains "关注" then
          set allCount to allCount + 1
          try
            set p to position of el
            if (item 1 of p) < (item 1 of wp) + ((item 1 of ws) * 0.42) and (item 2 of p) > (item 2 of wp) + 80 then set leftCount to leftCount + 1
            if (count of samples) < 6 then set end of samples to my vbp_compact_text(label, 28) & "@(" & ((item 1 of p) as text) & "," & ((item 2 of p) as text) & ")"
          end try
        end if
      end repeat
      return "关注候选=全部 " & (allCount as text) & "，左侧 " & (leftCount as text) & "，样本 " & my vbp_join_list(samples, " / ")
    end try
  end tell
  return "关注候选=无法读取"
end vbp_following_diagnostics

on vbp_cleanup_autoplay_tabs(targetProcessRef, keepTitle)
  set closedText to my vbp_close_non_following_tabs(targetProcessRef, keepTitle)
  return closedText & "；已保护标题含“" & keepTitle & "”的关注总览标签"
end vbp_cleanup_autoplay_tabs

on vbp_close_non_following_tabs(targetProcessRef, keepTitle)
  tell application "System Events"
    set closedCount to 0
    try
      set w to window 1 of targetProcessRef
      set wp to position of w
      set ws to size of w
      repeat with el in entire contents of targetProcessRef
        set label to my vbp_text(el)
        if label contains "关闭" then
          try
            set p to position of el
            if (item 2 of p) < (item 2 of wp) + 85 then
              if label does not contain keepTitle and label is not "关闭" then
                click el
                delay 0.3
                set closedCount to closedCount + 1
              end if
            end if
          end try
        end if
      end repeat
    end try
    return "已关闭非关注标签 " & closedCount & " 个"
  end tell
end vbp_close_non_following_tabs

on vbp_click_creator_in_following(targetProcessRef, term)
  tell application "System Events"
    repeat with el in entire contents of targetProcessRef
      set label to my vbp_text(el)
      if label contains term then
        try
          click el
          delay 1.3
          return true
        end try
      end if
    end repeat
  end tell
  return false
end vbp_click_creator_in_following

on vbp_search_and_click_creator(targetProcessRef, term)
  tell application "System Events"
    if my vbp_click_named(targetProcessRef, {"搜索", "Search"}, false) then
      keystroke term
      key code 36
      delay 1.6
      return my vbp_click_creator_in_following(targetProcessRef, term)
    end if
  end tell
  return false
end vbp_search_and_click_creator

on vbp_collect_latest_videos(targetProcessRef, maxCount)
  tell application "System Events"
    set jsonItems to ""
    set collectedCount to 0
    repeat with i from 1 to maxCount
      if i is 1 then
        if not my vbp_open_first_non_pinned_video(targetProcessRef) then exit repeat
      end if
      delay 0.9
      my vbp_pause_video_if_possible(targetProcessRef)
      my vbp_click_expand_if_present(targetProcessRef)
      set itemJson to my vbp_collect_current_video_json(targetProcessRef, i)
      if itemJson is not "" then
        if collectedCount > 0 then set jsonItems to jsonItems & ","
        set jsonItems to jsonItems & itemJson
        set collectedCount to collectedCount + 1
      end if
      if i < maxCount then
        if not my vbp_click_next_video_arrow(targetProcessRef) then exit repeat
      end if
    end repeat
    return "{\\"ok\\":true,\\"code\\":\\"collect_latest_videos\\",\\"method\\":\\"video_detail_sequence\\",\\"detail\\":\\"collected " & collectedCount & "\\",\\"items\\":[" & jsonItems & "]}"
  end tell
end vbp_collect_latest_videos

on vbp_open_first_non_pinned_video(targetProcessRef)
  tell application "System Events"
    set w to window 1 of targetProcessRef
    set wp to position of w
    set ws to size of w
    set minY to (item 2 of wp) + 360
    set bestEl to missing value
    set bestY to 99999
    repeat with el in entire contents of targetProcessRef
      set label to my vbp_text(el)
      if label is not "" and label does not contain "置顶" and label does not contain "预约" and label does not contain "直播" then
        try
          set p to position of el
          set s to size of el
          if (item 2 of p) > minY and (item 1 of s) > 60 and (item 2 of s) > 60 then
            if (item 2 of p) < bestY then
              set bestY to item 2 of p
              set bestEl to el
            end if
          end if
        end try
      end if
    end repeat
    if bestEl is not missing value then
      try
        click bestEl
        delay 1.2
        return true
      end try
    end if
    try
      click at {(item 1 of wp) + 165, (item 2 of wp) + 555}
      delay 1.2
      return true
    end try
  end tell
  return false
end vbp_open_first_non_pinned_video

on vbp_pause_video_if_possible(targetProcessRef)
  tell application "System Events"
    try
      key code 49
      delay 0.15
    end try
  end tell
end vbp_pause_video_if_possible

on vbp_click_expand_if_present(targetProcessRef)
  tell application "System Events"
    repeat with el in entire contents of targetProcessRef
      set label to my vbp_text(el)
      if label contains "展开" then
        try
          click el
          delay 0.35
          return true
        end try
      end if
    end repeat
  end tell
  return false
end vbp_click_expand_if_present

on vbp_click_next_video_arrow(targetProcessRef)
  tell application "System Events"
    try
      set w to window 1 of targetProcessRef
      set p to position of w
      set s to size of w
      click at {(item 1 of p) + (item 1 of s) - 70, (item 2 of p) + ((item 2 of s) * 0.54)}
      delay 0.9
      return true
    end try
  end tell
  return false
end vbp_click_next_video_arrow

on vbp_collect_current_video_json(targetProcessRef, ordinal)
  tell application "System Events"
    set allText to my vbp_visible_text_dump(targetProcessRef)
    set likeMetric to my vbp_metric_at_bucket(targetProcessRef, "like")
    set shareMetric to my vbp_metric_at_bucket(targetProcessRef, "share")
    set favoriteMetric to my vbp_metric_at_bucket(targetProcessRef, "favorite")
    set commentMetric to my vbp_metric_at_bucket(targetProcessRef, "comment")
    set titleText to my vbp_title_from_dump(allText, ordinal)
    return "{\\"title\\":\\"" & my vbp_json_escape(titleText) & "\\",\\"bodyExcerpt\\":\\"" & my vbp_json_escape(allText) & "\\",\\"like\\":\\"" & my vbp_json_escape(likeMetric) & "\\",\\"share\\":\\"" & my vbp_json_escape(shareMetric) & "\\",\\"favorite\\":\\"" & my vbp_json_escape(favoriteMetric) & "\\",\\"comment\\":\\"" & my vbp_json_escape(commentMetric) & "\\",\\"rawText\\":\\"" & my vbp_json_escape(allText) & "\\",\\"metricPositions\\":{\\"like\\":\\"right-bottom-like\\",\\"share\\":\\"right-bottom-share\\",\\"favorite\\":\\"right-bottom-favorite\\",\\"comment\\":\\"right-bottom-comment\\"}}"
  end tell
end vbp_collect_current_video_json

on vbp_visible_text_dump(targetProcessRef)
  tell application "System Events"
    set out to ""
    repeat with el in entire contents of targetProcessRef
      set label to my vbp_text(el)
      if label is not "" then
        if out does not contain label then set out to out & label & linefeed
      end if
    end repeat
    return out
  end tell
end vbp_visible_text_dump

on vbp_title_from_dump(dumpText, ordinal)
  set AppleScript's text item delimiters to linefeed
  set linesList to text items of dumpText
  set AppleScript's text item delimiters to ""
  repeat with lineText in linesList
    set t to lineText as text
    if length of t > 4 and t does not contain "视频号" and t does not contain "关注" and t does not contain "评论" and t does not contain "收藏" and t does not contain "转发" and t does not contain "点赞" then return t
  end repeat
  return "桌面微信视频号视频 " & ordinal
end vbp_title_from_dump

on vbp_metric_at_bucket(targetProcessRef, bucketName)
  tell application "System Events"
    set w to window 1 of targetProcessRef
    set wp to position of w
    set ws to size of w
    set bottomMin to (item 2 of wp) + (item 2 of ws) - 260
    set rightMin to (item 1 of wp) + (item 1 of ws) - 520
    set bucketIndex to 1
    if bucketName is "share" then set bucketIndex to 2
    if bucketName is "favorite" then set bucketIndex to 3
    if bucketName is "comment" then set bucketIndex to 4
    set candidates to {}
    repeat with el in entire contents of targetProcessRef
      set label to my vbp_text(el)
      if my vbp_looks_metric(label) then
        try
          set p to position of el
          if (item 2 of p) > bottomMin and (item 1 of p) > rightMin then
            set end of candidates to label
          end if
        end try
      end if
    end repeat
    if (count of candidates) >= bucketIndex then return item bucketIndex of candidates as text
  end tell
  return ""
end vbp_metric_at_bucket

on vbp_looks_metric(valueText)
  set s to valueText as text
  if s is "" then return false
  if length of s > 12 then return false
  set allowedChars to "0123456789０１２３４５６７８９.,，.万wWkK+＋"
  repeat with i from 1 to length of s
    if allowedChars does not contain character i of s then return false
  end repeat
  return true
end vbp_looks_metric

on vbp_join_list(valueList, delimiterText)
  if (count of valueList) is 0 then return "无"
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to delimiterText
  set joinedText to valueList as text
  set AppleScript's text item delimiters to oldDelimiters
  return joinedText
end vbp_join_list

on vbp_compact_text(valueText, maxLen)
  set s to valueText as text
  set s to my vbp_replace(s, return, " ")
  set s to my vbp_replace(s, linefeed, " ")
  if length of s > maxLen then return (text 1 thru maxLen of s) & "..."
  return s
end vbp_compact_text

on vbp_return_wechat_home(targetProcessRef)
  tell application "System Events"
    try
      tell application id "com.tencent.xinWeChat" to activate
      delay 0.3
      set p to first process whose bundle identifier is "com.tencent.xinWeChat"
      set frontmost of p to true
      my vbp_raise_window(p)
    end try
  end tell
end vbp_return_wechat_home

on vbp_result(okFlag, codeText, methodText, detailText)
  if okFlag then
    set okValue to "true"
  else
    set okValue to "false"
  end if
  return "{\\"ok\\":" & okValue & ",\\"code\\":\\"" & my vbp_json_escape(codeText) & "\\",\\"method\\":\\"" & my vbp_json_escape(methodText) & "\\",\\"detail\\":\\"" & my vbp_json_escape(detailText) & "\\",\\"message\\":\\"" & my vbp_json_escape(detailText) & "\\"}"
end vbp_result

on vbp_json_escape(valueText)
  set s to valueText as text
  set s to my vbp_replace(s, "\\\\", "\\\\\\\\")
  set s to my vbp_replace(s, quote, "\\\\\\"")
  set s to my vbp_replace(s, return, "\\\\n")
  set s to my vbp_replace(s, linefeed, "\\\\n")
  return s
end vbp_json_escape

on vbp_replace(sourceText, searchText, replacementText)
  set AppleScript's text item delimiters to searchText
  set parts to text items of sourceText
  set AppleScript's text item delimiters to replacementText
  set joinedText to parts as text
  set AppleScript's text item delimiters to ""
  return joinedText
end vbp_replace
`;
}

function appleString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const __wechatDesktopInternals = {
  appleScriptForStep,
  friendlyWechatDesktopError,
  parseScriptResult,
  normalizeWechatVideoCount,
  wechatScreenshotShortcutScript,
  wechatScreenshotSelectionSwiftScript,
  WECHAT_SCREENSHOT_STANDARD_ATTEMPTS,
};

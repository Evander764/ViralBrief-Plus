import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { all } from '../db.js';
import { upsertCapture, markAccountPatrolled, beijingDayStartISO } from '../store.js';
import { log } from '../lib/log.js';
import { SCREENSHOTS_DIR } from '../lib/paths.js';
import { sortPatrolAccounts } from './patrol.js';

const execFileAsync = promisify(execFile);
const PLATFORM = 'wechat_channels';
const DEFAULT_LATEST_VIDEO_COUNT = 3;

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
} = {}) {
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
    windowType: 'desktop_wechat',
    windowStartISO: beijingDayStartISO(),
    stopped: false,
  };

  const rawAccounts = all('SELECT * FROM accounts WHERE monitor_enabled = 1 AND platform = ?', [PLATFORM]);
  const sortedAccounts = sortPatrolAccounts(rawAccounts);
  const todayStart = beijingDayStartISO();
  const accounts = includePatrolledToday ? sortedAccounts : sortedAccounts.filter((acc) => !isPatrolledSince(acc, todayStart));
  result.skippedToday = sortedAccounts.length - accounts.length;
  result.total = accounts.length;
  result.platformResults[PLATFORM].total = accounts.length;

  progress(`开始桌面微信视频号巡检: ${accounts.length} 个账号`);
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
    });
    applyOutcome(result, outcome);
  }

  result.stopped ||= !!shouldStop();
  progress(`${result.stopped ? '桌面微信视频号巡检已停止' : '桌面微信视频号巡检完成'}: 成功 ${result.success}, 失败 ${result.failed}, 新增 ${result.newItems}, 去重 ${result.duplicates}, 今日已跳过 ${result.skippedToday}`);
  return result;
}

async function patrolWechatDesktopAccount(acc, { index, total, progress, scriptRunner, now, shouldStop }) {
  const label = `${PLATFORM}/${acc.nickname || acc.id}`;
  try {
    if (!acc.nickname) return errorOutcome(acc, '缺少视频号博主昵称，无法在桌面微信内匹配');
    progress(`(${index + 1}/${total}) 打开桌面微信视频号博主 ${acc.nickname}`);

    const opened = await openWechatDesktopCreator(acc, { scriptRunner, progress });
    if (shouldStop()) return stoppedOutcome(acc);

    const videos = await collectWechatDesktopLatestVideos(acc, {
      count: DEFAULT_LATEST_VIDEO_COUNT,
      progress,
      scriptRunner,
    });
    if (shouldStop()) return stoppedOutcome(acc);
    if (!videos.length) {
      throw new WechatDesktopPatrolError('collect_latest_videos', '未采集到微信视频号最新视频数据');
    }

    const items = videos.map((video, i) => saveWechatDesktopVideoItem(acc, video, { opened, now, index: i }));
    markAccountPatrolled(acc.id);
    return okOutcome(acc, items, [{ reason: 'desktop_wechat_latest_videos', detail: `已采集微信视频号最新 ${items.length} 条视频` }]);
  } catch (e) {
    const message = friendlyWechatDesktopError(e);
    log.warn(`[RPA] 桌面微信视频号巡检失败 ${label}: ${message}`);
    return errorOutcome(acc, message);
  }
}

export async function openWechatDesktopCreator(acc, { scriptRunner = defaultWechatScriptRunner, progress = () => {} } = {}) {
  await runStep(scriptRunner, 'assert_accessibility', {}, progress);
  await runStep(scriptRunner, 'activate_wechat', {}, progress);
  const openChannels = await runStep(scriptRunner, 'open_channels_home', {}, progress);
  const openProfile = await runStep(scriptRunner, 'open_profile_entry', {}, progress);
  const openOverview = await runStep(scriptRunner, 'open_overview', {}, progress);
  const openCreator = await runStep(scriptRunner, 'open_creator', { nickname: acc.nickname }, progress);
  return {
    method: [openChannels.method, openProfile.method, openOverview.method, openCreator.method].filter(Boolean).join('+') || 'unknown',
    detail: openCreator.detail || openOverview.detail || openProfile.detail || openChannels.detail || '',
  };
}

async function collectWechatDesktopLatestVideos(acc, { scriptRunner, progress, count }) {
  const r = await runStep(scriptRunner, 'collect_latest_videos', { nickname: acc.nickname, count }, progress);
  const items = Array.isArray(r.items) ? r.items : parseCollectedVideos(r.detail);
  return items
    .filter((item) => item && String(item.title || '').trim())
    .slice(0, count)
    .map((item, index) => normalizeWechatVideoItem(item, index));
}

async function runStep(scriptRunner, step, payload, progress) {
  const r = await scriptRunner(step, payload);
  if (!r || r.ok !== true) {
    throw new WechatDesktopPatrolError(r?.code || step, r?.message || `桌面微信步骤失败: ${step}`);
  }
  if (r.detail && step !== 'collect_latest_videos') progress(`  ${r.detail}`);
  return r;
}

function saveWechatDesktopVideoItem(acc, video, { opened, now, index }) {
  const dayKey = beijingDateKey(now);
  const url = video.url || `wechat-desktop://content/${encodeURIComponent(acc.id)}/${dayKey}/${index + 1}`;
  const title = video.title || `桌面微信视频号最新视频 ${index + 1} - ${acc.nickname} - ${dayKey}`;
  const res = upsertCapture({
    url,
    platform: PLATFORM,
    content_type: 'video',
    account_id: acc.id,
    author_name: acc.nickname,
    title,
    body_excerpt: video.bodyExcerpt || `桌面微信视频号「${acc.nickname}」最新视频第 ${index + 1} 条。`,
    metrics_raw: {
      like: video.like,
      share: video.redHeart,
      comment: video.comment,
      favorite: video.favorite,
    },
    metrics_source: 'desktop_agent',
    metrics_confidence: video.metricsConfidence || 'desktop_wechat',
    metrics_evidence: {
      navigation: {
        source: 'macos_accessibility',
        method: opened.method,
        detail: opened.detail,
      },
      metrics: {
        like: { label: '点赞', raw: video.likeRaw ?? video.like },
        share: { label: '红心', raw: video.redHeartRaw ?? video.redHeart },
        favorite: { label: '收藏', raw: video.favoriteRaw ?? video.favorite },
        comment: { label: '评论', raw: video.commentRaw ?? video.comment },
      },
    },
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
  return {
    title: String(item.title || '').trim(),
    bodyExcerpt: item.bodyExcerpt || item.body_excerpt || null,
    like: firstPresent(item.like, item.likeCount, item.like_count, item.thumbsUp),
    likeRaw: firstPresent(item.likeRaw, item.like_raw),
    redHeart: firstPresent(item.redHeart, item.redHeartCount, item.red_heart, item.red_heart_count, item.share, item.share_count),
    redHeartRaw: firstPresent(item.redHeartRaw, item.red_heart_raw, item.shareRaw, item.share_raw),
    favorite: firstPresent(item.favorite, item.favoriteCount, item.favorite_count),
    favoriteRaw: firstPresent(item.favoriteRaw, item.favorite_raw),
    comment: firstPresent(item.comment, item.commentCount, item.comment_count),
    commentRaw: firstPresent(item.commentRaw, item.comment_raw),
    publishTime: item.publishTime || item.publish_time || null,
    screenshotPath: saveWechatScreenshot(item.screenshotData, item.screenshotPath || item.screenshot_path, index),
    coverUrl: item.coverUrl || item.cover_url || null,
    durationText: item.durationText || item.duration_text || null,
    metricsConfidence: item.metricsConfidence || item.metrics_confidence || 'desktop_wechat',
    url: item.url || null,
  };
}

function firstPresent(...values) {
  return values.find((v) => v !== undefined && v !== null && String(v).trim?.() !== '') ?? null;
}

function parseCollectedVideos(detail) {
  const text = String(detail || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
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
  if (e?.code === 'open_channels_home' || /未找到桌面微信视频号入口|未找到视频号入口/.test(message)) {
    return '没有找到桌面微信的视频号入口：请先把微信主窗口从台前调度/左侧缩略图展开到屏幕中央，确认左侧栏能看到“视频号”后再重试';
  }
  if (e?.code === 'wechat_window_empty' || /微信主窗口是空白窗口|没有暴露可操作控件/.test(message)) {
    return '桌面微信主窗口当前是空白窗口，没有暴露聊天列表或左侧栏控件；请先重启微信或重新登录微信，确认能看到左侧栏“视频号”后再重试';
  }
  return message || '桌面微信视频号自动化失败';
}

async function defaultWechatScriptRunner(step, payload = {}) {
  const script = appleScriptForStep(step, payload);
  try {
    const { stdout, stderr } = await execFileAsync('osascript', ['-e', script], { timeout: 45_000 });
    const parsed = parseScriptResult(stdout, stderr);
    if (step === 'collect_latest_videos' && parsed.ok) {
      const items = parseCollectedVideos(parsed.detail);
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

async function captureWechatDesktopScreenshot(label) {
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const safe = String(label || 'wechat').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 50) || 'wechat';
    const filename = `rpa_wechat_channels_home_${safe}_${Date.now()}.png`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    await execFileAsync('screencapture', ['-x', filepath], { timeout: 10_000 });
    return `screenshots/${filename}`;
  } catch (e) {
    log.warn(`[RPA] 微信视频号首页截图失败: ${e.message}`);
    return null;
  }
}

function parseScriptResult(stdout, stderr) {
  const text = String(stdout || '').trim() || String(stderr || '').trim();
  const [status, code = '', method = '', ...rest] = text.split('|');
  if (status === 'OK') return { ok: true, method, detail: rest.join('|') };
  return { ok: false, code: code || 'osascript', message: rest.join('|') || text || 'osascript 未返回结果' };
}

function appleScriptForStep(step, payload = {}) {
  const nickname = appleString(payload.nickname || '');
  const terms = {
    assert_accessibility: '{}',
    activate_wechat: '{}',
    open_channels_home: '{"视频号", "Channels"}',
    open_profile_entry: '{"头像", "个人", "我的", "我", "Profile"}',
    open_overview: '{"我的关注", "关注", "博主", "创作者", "账号", "总览"}',
    open_creator: `{${nickname}}`,
    collect_latest_videos: '{}',
  }[step];
  if (!terms) throw new Error(`unknown desktop wechat step: ${step}`);

  return `
on run
  tell application "System Events"
    if UI elements enabled is false then return "ERROR|accessibility||辅助功能权限未开启"
  end tell
  tell application id "com.tencent.xinWeChat"
    activate
    reopen
  end tell
  delay 0.8
  tell application "System Events"
    set targetProcess to my vbp_process("${step}")
    if targetProcess is missing value then return "ERROR|not_logged_in||未找到桌面微信进程"
    set visible of targetProcess to true
    set frontmost of targetProcess to true
    my vbp_raise_window(targetProcess)
    if "${step}" is "assert_accessibility" then
      try
        set windowCount to count of windows of targetProcess
        if windowCount < 1 then return "ERROR|not_logged_in||桌面微信没有可用窗口"
        set ignored to name of window 1 of targetProcess
      on error errMsg
        return "ERROR|accessibility||" & errMsg
      end try
      return "OK|accessibility|ax|辅助功能权限可用，已验证可读取微信窗口"
    end if
    if "${step}" is "activate_wechat" then return "OK|activate|ax|已激活并置前桌面微信"
    my vbp_raise_window(targetProcess)
    if "${step}" is "open_channels_home" then
      if (my vbp_accessible_content_count(targetProcess)) < 1 then
        my vbp_restore_wechat_window(targetProcess)
        delay 0.8
      end if
      if (my vbp_accessible_content_count(targetProcess)) < 1 then
        return "ERROR|wechat_window_empty||桌面微信主窗口是空白窗口，没有暴露可操作控件"
      end if
    end if
    if "${step}" is "open_profile_entry" then
      if my vbp_click_named(targetProcess, ${terms}, true) then return "OK|open_profile_entry|ax|已点击右上角人物头像"
      if my vbp_click_top_right(targetProcess) then return "OK|open_profile_entry|coordinate|未找到头像元素，已使用右上角坐标兜底"
      return "ERROR|profile_entry||未找到视频号右上角人物头像"
    else if "${step}" is "open_creator" then
      if my vbp_click_text(targetProcess, ${nickname}) then return "OK|open_creator|ax|已打开匹配博主"
      if my vbp_search_and_click(targetProcess, ${nickname}) then return "OK|open_creator|ax_search|已搜索并打开匹配博主"
      return "ERROR|creator_not_found||未在桌面微信视频号里找到匹配博主"
    else if "${step}" is "open_channels_home" then
      if my vbp_click_named(targetProcess, ${terms}, false) then return "OK|open_channels_home|ax|已点击视频号入口"
      if my vbp_click_channels_sidebar(targetProcess) then return "OK|open_channels_home|coordinate|未找到视频号文字控件，已使用左侧栏坐标兜底"
      return "ERROR|open_channels_home||未找到桌面微信视频号入口"
    else if "${step}" is "collect_latest_videos" then
      return "OK|collect_latest_videos|ax|" & my vbp_collect_latest_videos(targetProcess)
    else
      if my vbp_click_named(targetProcess, ${terms}, false) then return "OK|${step}|ax|已完成桌面微信步骤 ${step}"
      return "ERROR|${step}||未找到桌面微信控件 ${step}"
    end if
  end tell
end run

on vbp_process(stepName)
  tell application "System Events"
    set preferredBids to {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
    if stepName is "assert_accessibility" or stepName is "activate_wechat" or stepName is "open_channels_home" then
      set preferredBids to {"com.tencent.xinWeChat", "com.tencent.flue.WeChatAppEx"}
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
      tell process "WeChat"
        try
          click menu item "微信" of menu 1 of menu bar item "窗口" of menu bar 1
        end try
        try
          click menu item "聊天" of menu 1 of menu bar item "窗口" of menu bar 1
        end try
        try
          click menu item "前置全部窗口" of menu 1 of menu bar item "窗口" of menu bar 1
        end try
      end tell
    end try
    try
      set value of attribute "AXMinimized" of window 1 of targetProcessRef to false
    end try
    try
      perform action "AXRaise" of window 1 of targetProcessRef
    end try
    delay 0.5
  end tell
end vbp_raise_window

on vbp_restore_wechat_window(targetProcessRef)
  tell application "System Events"
    try
      tell process "WeChat"
        try
          click menu item "从组中移除窗口" of menu 1 of menu bar item "窗口" of menu bar 1
          delay 0.5
        end try
        try
          click menu item "聊天" of menu 1 of menu bar item "窗口" of menu bar 1
          delay 0.5
        end try
        try
          click menu item "微信" of menu 1 of menu bar item "窗口" of menu bar 1
          delay 0.5
        end try
        try
          click menu item "前置全部窗口" of menu 1 of menu bar item "窗口" of menu bar 1
        end try
      end tell
    end try
    try
      set value of attribute "AXMinimized" of window 1 of targetProcessRef to false
    end try
    try
      perform action "AXRaise" of window 1 of targetProcessRef
    end try
  end tell
end vbp_restore_wechat_window

on vbp_accessible_content_count(targetProcessRef)
  tell application "System Events"
    try
      return count of entire contents of targetProcessRef
    end try
  end tell
  return 0
end vbp_accessible_content_count

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
      set end of parts to value of el as text
    end try
    return parts as text
  end tell
end vbp_text

on vbp_click_named(targetProcessRef, terms, topRightOnly)
  tell application "System Events"
    set elems to entire contents of targetProcessRef
    repeat with el in elems
      set label to my vbp_text(el)
      repeat with term in terms
        if label contains (term as text) then
          if topRightOnly then
            try
              set p to position of el
              set s to size of el
              set w to window 1 of targetProcessRef
              set wp to position of w
              set ws to size of w
              if item 1 of p < (item 1 of wp) + ((item 1 of ws) * 0.55) then exit repeat
            end try
          end if
          try
            click el
            delay 1.2
            return true
          end try
        end if
      end repeat
    end repeat
  end tell
  return false
end vbp_click_named

on vbp_click_text(targetProcessRef, term)
  tell application "System Events"
    repeat with el in entire contents of targetProcessRef
      if (my vbp_text(el)) contains term then
        try
          click el
          delay 1.4
          return true
        end try
      end if
    end repeat
  end tell
  return false
end vbp_click_text

on vbp_search_and_click(targetProcessRef, term)
  tell application "System Events"
    if my vbp_click_named(targetProcessRef, {"搜索", "Search"}, false) then
      keystroke term
      key code 36
      delay 1.8
      return my vbp_click_text(targetProcessRef, term)
    end if
  end tell
  return false
end vbp_search_and_click

on vbp_click_top_right(targetProcessRef)
  tell application "System Events"
    try
      set w to window 1 of targetProcessRef
      set p to position of w
      set s to size of w
      click at {(item 1 of p) + (item 1 of s) - 54, (item 2 of p) + 54}
      delay 1.2
      return true
    end try
  end tell
  return false
end vbp_click_top_right

on vbp_click_channels_sidebar(targetProcessRef)
  tell application "System Events"
    try
      set w to window 1 of targetProcessRef
      set p to position of w
      set s to size of w
      set leftX to (item 1 of p) + 35
      set topY to item 2 of p
      set heightLimit to (item 2 of p) + (item 2 of s) - 48
      repeat with offsetY in {172, 212, 252, 292}
        set targetY to topY + offsetY
        if targetY < heightLimit then
          click at {leftX, targetY}
          delay 1.2
          return true
        end if
      end repeat
    end try
  end tell
  return false
end vbp_click_channels_sidebar

on vbp_collect_latest_videos(targetProcessRef)
  tell application "System Events"
    set texts to {}
    try
      repeat with el in entire contents of targetProcessRef
        set label to my vbp_text(el)
        if label is not "" then
          if label does not contain "点赞" and label does not contain "评论" and label does not contain "收藏" and label does not contain "转发" and length of label > 5 then
            set end of texts to label
          end if
        end if
        if (count of texts) >= 3 then exit repeat
      end repeat
    end try
    set out to "["
    set i to 0
    repeat with t in texts
      set i to i + 1
      if i > 1 then set out to out & ","
      set out to out & "{\\"title\\":\\"" & my vbp_json_escape(t as text) & "\\",\\"like\\":null,\\"redHeart\\":null,\\"favorite\\":null,\\"comment\\":null}"
    end repeat
    return out & "]"
  end tell
end vbp_collect_latest_videos

on vbp_json_escape(valueText)
  set s to valueText as text
  set s to my vbp_replace(s, quote, "'")
  set s to my vbp_replace(s, return, " ")
  set s to my vbp_replace(s, linefeed, " ")
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
};

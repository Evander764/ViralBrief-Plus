import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all } from '../db.js';
import { upsertCapture, markAccountPatrolled, beijingDayStartISO } from '../store.js';
import { log } from '../lib/log.js';
import { sortPatrolAccounts } from './patrol.js';

const execFileAsync = promisify(execFile);
const PLATFORM = 'wechat_channels';

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

    const item = saveWechatDesktopPlaceholder(acc, opened, now);
    markAccountPatrolled(acc.id);
    return okOutcome(acc, [item], [{ reason: 'desktop_wechat_manual_review', detail: '桌面微信视频号已打开，互动指标需人工复核或后续桌面视觉补录' }]);
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

async function runStep(scriptRunner, step, payload, progress) {
  const r = await scriptRunner(step, payload);
  if (!r || r.ok !== true) {
    throw new WechatDesktopPatrolError(r?.code || step, r?.message || `桌面微信步骤失败: ${step}`);
  }
  if (r.detail) progress(`  ${r.detail}`);
  return r;
}

function saveWechatDesktopPlaceholder(acc, opened, now) {
  const dayKey = beijingDateKey(now);
  const url = `wechat-desktop://content/${encodeURIComponent(acc.id)}/${dayKey}`;
  const title = `桌面微信视频号巡检待复核 - ${acc.nickname} - ${dayKey}`;
  const res = upsertCapture({
    url,
    platform: PLATFORM,
    content_type: 'video',
    account_id: acc.id,
    author_name: acc.nickname,
    title,
    body_excerpt: `桌面微信视频号已打开到账号「${acc.nickname}」。本记录不含网页链接，互动指标需人工复核或后续桌面视觉补录。`,
    metrics_raw: { like: null, share: null, comment: null, favorite: null },
    metrics_source: 'desktop_agent',
    metrics_confidence: 'desktop_navigation',
    metrics_evidence: {
      navigation: {
        source: 'macos_accessibility',
        method: opened.method,
        detail: opened.detail,
      },
    },
    publish_time: null,
  });
  return {
    id: res.id,
    url,
    title,
    duplicate: !!res.duplicate,
    dataStatus: res.status || res.reason || 'needs_review',
  };
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
  if (e?.code === 'accessibility' || /辅助功能|System Events|not allowed|not authorized/i.test(message)) {
    return '无法控制桌面微信：请在系统设置 > 隐私与安全性 > 辅助功能 中允许 Viral Brief Plus 或当前终端控制电脑';
  }
  if (e?.code === 'not_logged_in' || /登录|login/i.test(message)) {
    return '桌面微信未登录或视频号窗口不可用，请先手动登录微信';
  }
  return message || '桌面微信视频号自动化失败';
}

async function defaultWechatScriptRunner(step, payload = {}) {
  const script = appleScriptForStep(step, payload);
  const { stdout, stderr } = await execFileAsync('osascript', ['-e', script], { timeout: 45_000 });
  return parseScriptResult(stdout, stderr);
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
  }[step];
  if (!terms) throw new Error(`unknown desktop wechat step: ${step}`);

  return `
on run
  tell application "System Events"
    if UI elements enabled is false then return "ERROR|accessibility||辅助功能权限未开启"
  end tell
  if "${step}" is "assert_accessibility" then return "OK|accessibility|ax|辅助功能权限可用"
  tell application id "com.tencent.xinWeChat" to activate
  delay 0.8
  if "${step}" is "activate_wechat" then return "OK|activate|ax|已激活桌面微信"
  tell application "System Events"
    set targetProcess to my vbp_process()
    if targetProcess is missing value then return "ERROR|not_logged_in||未找到桌面微信进程"
    if "${step}" is "open_profile_entry" then
      if my vbp_click_named(targetProcess, ${terms}, true) then return "OK|open_profile_entry|ax|已点击右上角人物头像"
      if my vbp_click_top_right(targetProcess) then return "OK|open_profile_entry|coordinate|未找到头像元素，已使用右上角坐标兜底"
      return "ERROR|profile_entry||未找到视频号右上角人物头像"
    else if "${step}" is "open_creator" then
      if my vbp_click_text(targetProcess, ${nickname}) then return "OK|open_creator|ax|已打开匹配博主"
      if my vbp_search_and_click(targetProcess, ${nickname}) then return "OK|open_creator|ax_search|已搜索并打开匹配博主"
      return "ERROR|creator_not_found||未在桌面微信视频号里找到匹配博主"
    else
      if my vbp_click_named(targetProcess, ${terms}, false) then return "OK|${step}|ax|已完成桌面微信步骤 ${step}"
      return "ERROR|${step}||未找到桌面微信控件 ${step}"
    end if
  end tell
end run

on vbp_process()
  tell application "System Events"
    repeat with bid in {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
      try
        return first process whose bundle identifier is bid
      end try
    end repeat
  end tell
  return missing value
end vbp_process

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

on vbp_click_named(container, terms, topRightOnly)
  tell application "System Events"
    set elems to entire contents of container
    repeat with el in elems
      set label to my vbp_text(el)
      repeat with term in terms
        if label contains (term as text) then
          if topRightOnly then
            try
              set p to position of el
              set s to size of el
              set w to window 1 of container
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

on vbp_click_text(container, term)
  tell application "System Events"
    repeat with el in entire contents of container
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

on vbp_search_and_click(container, term)
  tell application "System Events"
    if my vbp_click_named(container, {"搜索", "Search"}, false) then
      keystroke term
      key code 36
      delay 1.8
      return my vbp_click_text(container, term)
    end if
  end tell
  return false
end vbp_search_and_click

on vbp_click_top_right(container)
  tell application "System Events"
    try
      set w to window 1 of container
      set p to position of w
      set s to size of w
      click at {(item 1 of p) + (item 1 of s) - 54, (item 2 of p) + 54}
      delay 1.2
      return true
    end try
  end tell
  return false
end vbp_click_top_right
`;
}

function appleString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

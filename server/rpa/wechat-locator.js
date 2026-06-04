// This locator uses deterministic system screenshots, CoreGraphics pixel
// analysis, AX text, and coordinate clicks. Swift-heavy work is routed through
// a cached helper binary so patrol does not repeatedly interpret `swift -e`.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../lib/log.js';
import { runWechatSwift } from './wechat-swift.js';

const execFileAsync = promisify(execFile);
const CODE_CONFIDENCE_THRESHOLD = 0.72;
const CREATOR_SCROLL_ATTEMPTS = 12;
const FOLLOWING_SIDEBAR_ROW_MERGE_GAP = 24;

export function normalizeTrafficLightAnchors({ window, buttons } = {}) {
  const normalizedButtons = {};
  for (const [key, button] of Object.entries(buttons || {})) {
    const x = Number(button?.x);
    const y = Number(button?.y);
    const width = Number(button?.width);
    const height = Number(button?.height);
    if ([x, y, width, height].every(Number.isFinite) && width > 4 && height > 4) {
      normalizedButtons[key] = {
        x,
        y,
        width,
        height,
        centerX: x + width / 2,
        centerY: y + height / 2,
      };
    }
  }

  const required = ['close', 'minimize', 'zoom'];
  const missing = required.filter((key) => !normalizedButtons[key]);
  if (missing.length) {
    return { ok: false, reason: `缺少窗口按钮: ${missing.join(',')}` };
  }

  const wx = Number(window?.x);
  const wy = Number(window?.y);
  const ww = Number(window?.width);
  const wh = Number(window?.height);
  if (![wx, wy, ww, wh].every(Number.isFinite) || ww < 240 || wh < 240) {
    return { ok: false, reason: '微信窗口尺寸不可用' };
  }

  return {
    ok: true,
    window: { x: wx, y: wy, width: ww, height: wh, name: window?.name || '', contentCount: Number(window?.contentCount || 0) },
    buttons: normalizedButtons,
    diagnostics: `红黄绿按钮 close=${pointText(normalizedButtons.close)} minimize=${pointText(normalizedButtons.minimize)} zoom=${pointText(normalizedButtons.zoom)} window=${Math.round(wx)},${Math.round(wy)},${Math.round(ww)},${Math.round(wh)}`,
  };
}

export async function getWechatTrafficLightAnchors({ runner = execFileAsync, preferChannelsWindow = false, includeContentCount = true } = {}) {
  const preferChannelsLiteral = preferChannelsWindow ? 'true' : 'false';
  const includeContentCountLiteral = includeContentCount ? 'true' : 'false';
  const script = `
on run
  set rowItems to {}
  set preferChannelsWindow to ${preferChannelsLiteral}
  set includeContentCount to ${includeContentCountLiteral}
  tell application id "com.tencent.xinWeChat"
    activate
    if not preferChannelsWindow then reopen
  end tell
  delay 0.4
  tell application "System Events"
    try
      set p to first process whose bundle identifier is "com.tencent.xinWeChat"
      set visible of p to true
      set frontmost of p to true
      set w to my vbp_target_window(p, preferChannelsWindow)
      try
        set value of attribute "AXMinimized" of w to false
      end try
      try
        perform action "AXRaise" of w
      end try
      delay 0.25
      set wp to position of w
      set ws to size of w
      set contentCount to 0
      if includeContentCount then
        try
          set contentCount to count of entire contents of p
        end try
      end if
      set end of rowItems to "WINDOW|" & (name of w as text) & "|" & ((item 1 of wp) as text) & "|" & ((item 2 of wp) as text) & "|" & ((item 1 of ws) as text) & "|" & ((item 2 of ws) as text) & "|" & (contentCount as text)
      repeat with i from 1 to 12
        try
          set b to button i of w
          set descText to description of b as text
          set roleName to ""
          if descText contains "关闭" or descText contains "close" then
            set roleName to "close"
          else if descText contains "最小" or descText contains "minimize" then
            set roleName to "minimize"
          else if descText contains "全屏" or descText contains "缩放" or descText contains "zoom" or descText contains "full" then
            set roleName to "zoom"
          end if
          if roleName is not "" then
            set bp to position of b
            set bs to size of b
            set end of rowItems to "BUTTON|" & roleName & "|" & descText & "|" & ((item 1 of bp) as text) & "|" & ((item 2 of bp) as text) & "|" & ((item 1 of bs) as text) & "|" & ((item 2 of bs) as text)
          end if
        end try
      end repeat
    on error errMsg
      set end of rowItems to "ERR|" & errMsg
    end try
  end tell
  set AppleScript's text item delimiters to linefeed
  set outText to rowItems as text
  set AppleScript's text item delimiters to ""
  return outText
end run

on vbp_target_window(targetProcessRef, preferChannelsWindow)
  tell application "System Events"
    if preferChannelsWindow then
      set bestWindow to missing value
      set bestScore to -100000
      try
        repeat with candidateWindow in windows of targetProcessRef
          set wp to position of candidateWindow
          set ws to size of candidateWindow
          set wn to ""
          try
            set wn to name of candidateWindow as text
          end try
          set ww to item 1 of ws
          set wh to item 2 of ws
          set score to 0
          if wn contains "窗口" then set score to score + 1000
          if ww < 1100 and wh > 520 then set score to score + 500
          if ww < 1400 and wh > 520 then set score to score + 150
          if ww > 700 and wh > 520 then set score to score + 80
          if ww > 1600 then set score to score - 300
          if score > bestScore then
            set bestScore to score
            set bestWindow to candidateWindow
          end if
        end repeat
      end try
      if bestWindow is not missing value and bestScore > 0 then return bestWindow
      try
        if (count of windows of targetProcessRef) > 1 then return window 2 of targetProcessRef
      end try
    end if
    return window 1 of targetProcessRef
  end tell
end vbp_target_window
`;
  const { stdout } = await runner('osascript', ['-e', script], { timeout: 8_000 });
  return parseTrafficLightOutput(String(stdout || ''));
}

export function parseTrafficLightOutput(text) {
  const buttons = {};
  let window = null;
  const errors = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (!parts[0]) continue;
    if (parts[0] === 'WINDOW') {
      window = {
        name: parts[1] || '',
        x: Number(parts[2]),
        y: Number(parts[3]),
        width: Number(parts[4]),
        height: Number(parts[5]),
        contentCount: Number(parts[6] || 0),
      };
    } else if (parts[0] === 'BUTTON') {
      buttons[parts[1]] = {
        description: parts[2] || '',
        x: Number(parts[3]),
        y: Number(parts[4]),
        width: Number(parts[5]),
        height: Number(parts[6]),
      };
    } else if (parts[0] === 'ERR') {
      errors.push(parts.slice(1).join('|'));
    }
  }
  const normalized = normalizeTrafficLightAnchors({ window, buttons });
  if (!normalized.ok && errors.length) normalized.reason = `${normalized.reason}; ${errors.join('; ')}`;
  return normalized;
}

export function leftRailRegionFromAnchors(anchors) {
  if (!anchors?.ok) return null;
  const { window, buttons } = anchors;
  const greenRight = buttons.zoom.x + buttons.zoom.width;
  const inferredWidth = Math.round((greenRight - window.x) + 66);
  const width = clamp(inferredWidth, 108, Math.min(142, Math.floor(window.width * 0.24)));
  return {
    x: Math.round(window.x),
    y: Math.round(window.y),
    width,
    height: Math.round(window.height),
  };
}

export async function captureWechatLeftRail(anchors, { runner = execFileAsync } = {}) {
  const region = leftRailRegionFromAnchors(anchors);
  if (!region) return { ok: false, reason: '无法计算微信左侧栏截图区域' };

  const dir = mkdtempSync(join(tmpdir(), 'vbp-wechat-rail-'));
  const path = join(dir, 'left-rail.png');
  try {
    await runner('screencapture', ['-x', `-R${region.x},${region.y},${region.width},${region.height}`, path], { timeout: 8_000 });
    const image = await imageSize(path, { runner });
    return { ok: true, path, dir, region, image, diagnostics: `leftRail=${region.x},${region.y},${region.width},${region.height} image=${image.width}x${image.height}` };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: String(e.stderr || e.message || e), region };
  }
}

export async function captureSystemFullScreenshot({ runner = execFileAsync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vbp-wechat-screen-'));
  const path = join(dir, 'full-screen.png');
  try {
    await runner('screencapture', ['-x', path], { timeout: 8_000 });
    const image = await imageSize(path, { runner });
    return { ok: true, path, dir, image, diagnostics: `system_screenshot_full=${image.width}x${image.height}` };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: String(e.stderr || e.message || e) };
  }
}

export function cleanupCapturedRail(rail) {
  if (rail?.dir) rmSync(rail.dir, { recursive: true, force: true });
}

export function cleanupCapturedScreenshot(screenshot) {
  if (screenshot?.dir) rmSync(screenshot.dir, { recursive: true, force: true });
}

export async function locateChannelsIconByCode({ anchors, rail, clusters } = {}) {
  const region = rail?.region || leftRailRegionFromAnchors(anchors);
  if (!anchors?.ok || !region) {
    return { ok: false, method: 'traffic_light_left_rail', reason: '缺少微信窗口红黄绿锚点' };
  }

  let candidates = clusters;
  let analyzerDetail = '';
  if (!Array.isArray(candidates) && rail?.path) {
    try {
      const analyzed = await analyzeLeftRailImage(rail.path, region);
      candidates = analyzed.clusters;
      analyzerDetail = `clusters=${candidates.length}`;
    } catch (e) {
      analyzerDetail = `imageAnalyzer=${String(e.message || e)}`;
      candidates = [];
    }
  }

  const closeRelY = anchors.buttons.close.centerY - region.y;
  const iconRows = normalizeIconClusters(candidates, { startY: closeRelY + 150, region });
  if (iconRows.length >= 4) {
    const target = iconRows[3];
    const spacing = iconRows.slice(1).map((row, index) => row.centerY - iconRows[index].centerY);
    const medianSpacing = median(spacing);
    const spacingOk = Number.isFinite(medianSpacing) && medianSpacing >= 40 && medianSpacing <= 90;
    const confidence = spacingOk && iconRows.length >= 6 ? 0.9 : 0.78;
    return {
      ok: true,
      method: 'traffic_light_left_rail',
      x: Math.round(region.x + (Number.isFinite(target.centerX) ? target.centerX : region.width * 0.5)),
      y: Math.round(region.y + target.centerY),
      confidence,
      diagnostics: `代码定位左栏蝴蝶形视频号图标 ${analyzerDetail} rows=${iconRows.map((row) => Math.round(row.centerY)).join(',')}`,
    };
  }

  const geometric = geometricChannelsPoint(anchors, region);
  return {
    ok: true,
    method: 'traffic_light_left_rail',
    x: geometric.x,
    y: geometric.y,
    confidence: 0.52,
    diagnostics: `图标候选不足，使用红黄绿几何估计 ${analyzerDetail} rows=${iconRows.map((row) => Math.round(row.centerY)).join(',')}`,
  };
}

export async function clickWechatChannelsFromMainByLocator({ runner = execFileAsync } = {}) {
  try {
    const anchors = await getWechatTrafficLightAnchors({ runner, includeContentCount: false });
    if (!anchors.ok) return { ok: false, code: 'main_channels_entry', method: 'traffic_light_left_rail', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };

    let lastMessage = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let rail = null;
      try {
        rail = await captureWechatLeftRail(anchors, { runner });
        if (!rail.ok) {
          lastMessage = [`第${attempt}次无法截取微信左侧栏`, rail.reason, anchors.diagnostics].filter(Boolean).join('；');
          continue;
        }

        const alreadyVisible = await analyzeChannelsAlreadyVisible(rail.path, rail.region, { runner });
        if (alreadyVisible.ok) {
          return {
            ok: true,
            code: 'open_channels_from_main',
            method: 'system_screenshot_already_channels',
            detail: `系统截图确认当前已在视频号界面；${alreadyVisible.detail}; ${anchors.diagnostics}; ${rail.diagnostics}`,
          };
        }

        const codeLocated = await locateChannelsIconByCode({ anchors, rail });
        if (codeLocated.ok && codeLocated.confidence >= CODE_CONFIDENCE_THRESHOLD) {
          return await clickAndVerify(codeLocated, { runner });
        }

        lastMessage = [
          `第${attempt}次代码定位置信度不足，已停止点击`,
          codeLocated.diagnostics || codeLocated.reason,
          anchors.diagnostics,
          rail.diagnostics,
        ].filter(Boolean).join('；');
      } finally {
        cleanupCapturedRail(rail);
      }
      if (attempt < 2) await sleep(700);
    }

    const fullVisible = await verifyChannelsVisibleByFullSystemScreenshot({ runner, anchors });
    if (fullVisible.ok) {
      return {
        ok: true,
        code: 'open_channels_from_main',
        method: fullVisible.method,
        detail: `系统全屏截图确认当前已在视频号界面；${fullVisible.detail}; ${anchors.diagnostics}`,
      };
    }
    const overviewVisible = await verifyProfileOrOverviewVisible({ runner });
    if (overviewVisible.ok) {
      return {
        ok: true,
        code: 'open_channels_from_main',
        method: 'system_screenshot_profile_overview',
        detail: `系统截图确认当前已在视频号个人/总览页；${overviewVisible.detail}; ${anchors.diagnostics}`,
      };
    }

    return {
      ok: false,
      code: 'main_channels_entry',
      method: 'traffic_light_left_rail',
      message: [lastMessage || '代码定位置信度不足，已停止点击', fullVisible.message, overviewVisible.reason].filter(Boolean).join('；'),
    };
  } catch (e) {
    return { ok: false, code: 'main_channels_entry', method: 'traffic_light_left_rail', message: String(e.message || e) };
  }
}

export async function detectWechatChannelsVisibleByScreenshot({ runner = execFileAsync } = {}) {
  let rail = null;
  try {
    const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
    if (!anchors.ok) return { ok: false, method: 'system_screenshot_channels_state', reason: anchors.reason || '无法读取微信窗口红黄绿按钮' };

    const fullVisible = await verifyChannelsVisibleByFullSystemScreenshot({ runner, anchors });
    if (fullVisible.ok) return fullVisible;

    const overviewVisible = await verifyProfileOrOverviewVisible({ runner });
    if (overviewVisible.ok) {
      return {
        ok: true,
        method: 'system_screenshot_profile_overview',
        detail: `系统截图确认当前已在视频号个人/总览页；${overviewVisible.detail}; ${anchors.diagnostics}`,
      };
    }

    rail = await captureWechatLeftRail(anchors, { runner });
    if (!rail.ok) return { ok: false, method: 'system_screenshot_channels_state', reason: rail.reason || '无法截取微信左侧栏' };

    const alreadyVisible = await analyzeChannelsAlreadyVisible(rail.path, rail.region, { runner });
    if (alreadyVisible.ok) {
      return {
        ok: true,
        method: 'system_screenshot_already_channels',
        detail: `系统截图确认当前已在视频号界面；${alreadyVisible.detail}; ${anchors.diagnostics}; ${rail.diagnostics}`,
      };
    }

    const codeLocated = await locateChannelsIconByCode({ anchors, rail });
    if (codeLocated.ok && codeLocated.confidence >= CODE_CONFIDENCE_THRESHOLD) {
      const selected = await analyzeChannelsSelectedRail(rail.path, rail.region, codeLocated, { runner });
      if (selected.ok) {
        return {
          ok: true,
          method: 'system_screenshot_channels_selected',
          detail: `系统截图确认视频号左栏已选中；${selected.detail}; ${codeLocated.diagnostics}; ${anchors.diagnostics}; ${rail.diagnostics}`,
        };
      }
    }

    return {
      ok: false,
      method: 'system_screenshot_channels_state',
      reason: [alreadyVisible.reason, codeLocated.diagnostics || codeLocated.reason].filter(Boolean).join('；'),
    };
  } catch (e) {
    return { ok: false, method: 'system_screenshot_channels_state', reason: String(e.message || e) };
  } finally {
    cleanupCapturedRail(rail);
  }
}

export async function openWechatProfileEntryByLocator({ runner = execFileAsync } = {}) {
  const diagnostics = [];
  let anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (!anchors.ok) return { ok: false, code: 'profile_entry', method: 'profile_icon_locator', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };

  const first = await clickProfileEntryAndVerify(anchors, { runner, waitMs: 800 });
  if (first.ok) return first.result;
  diagnostics.push(first.message);

  const returned = await returnFromVideoDetailIfNeeded(anchors, { runner });
  diagnostics.push(returned.detail);
  anchors = returned.anchors || anchors;

  const retry = await clickProfileEntryAndVerify(anchors, { runner, waitMs: 950 });
  if (retry.ok) {
    retry.result.detail = [retry.result.detail, ...diagnostics].filter(Boolean).join('；');
    return retry.result;
  }

  return {
    ok: false,
    code: 'profile_entry',
    method: 'profile_icon_locator',
    message: [retry.message, anchors.diagnostics, ...diagnostics].filter(Boolean).join('；'),
  };
}

async function clickProfileEntryAndVerify(anchors, { runner, waitMs }) {
  const point = profileEntryPointFromAnchors(anchors);
  const pointError = validateProfileEntryPoint(point, anchors);
  if (pointError) {
    return { ok: false, message: pointError };
  }

  await clickAt(point.x, point.y, { runner });
  await sleep(waitMs);

  const verified = await verifyProfileOrOverviewVisible({ runner });
  if (!verified.ok) {
    return {
      ok: false,
      message: [`已点击右上角小人入口 ${point.x},${point.y}，但未确认进入个人/总览页`, verified.reason].filter(Boolean).join('；'),
    };
  }

  return {
    ok: true,
    result: {
      ok: true,
      code: 'open_profile_entry',
      method: 'profile_icon_locator',
      detail: [`已通过系统坐标点击右上角小人入口 ${point.x},${point.y}`, verified.detail, anchors.diagnostics].filter(Boolean).join('；'),
    },
  };
}

export async function ensureWechatOverviewByLocator({ runner = execFileAsync } = {}) {
  const verified = await verifyProfileOrOverviewVisible({ runner });
  if (verified.ok) {
    return {
      ok: true,
      code: 'open_overview',
      method: 'system_screenshot_profile_overview',
      detail: `系统截图确认当前在个人/关注入口页；${verified.detail}`,
    };
  }
  return { ok: false, code: 'open_overview', method: 'system_screenshot_profile_overview', message: verified.reason || '未确认个人/关注入口页' };
}

export async function openWechatFollowingOverviewByLocator({ runner = execFileAsync } = {}) {
  const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (!anchors.ok) return { ok: false, code: 'open_following_overview', method: 'left_sidebar_following_locator', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };
  const screenshotPoint = await findFollowingSidebarPointByScreenshot({ runner, anchors });
  if (!screenshotPoint.ok) {
    const reference = followingSidebarPointFromAnchors(anchors);
    return {
      ok: false,
      code: 'open_following_overview',
      method: 'left_sidebar_following_locator',
      message: [
        '未能从当前系统截图精准识别左侧栏“关注”，已停止点击',
        screenshotPoint.reason,
        reference ? `几何参考点=${reference.x},${reference.y}` : '',
        anchors.diagnostics,
      ].filter(Boolean).join('；'),
    };
  }
  const point = screenshotPoint;
  const pointError = validateFollowingSidebarPoint(point, anchors);
  if (pointError) return { ok: false, code: 'open_following_overview', method: 'left_sidebar_following_locator', message: pointError };

  await clickAt(point.x, point.y, { runner });
  await sleep(1200);

  const verified = await verifyFollowingOverviewVisible({ runner, point });
  if (!verified.ok) {
    return {
      ok: false,
      code: 'open_following_overview',
      method: 'left_sidebar_following_locator',
      message: [`已点击左侧栏关注 ${point.x},${point.y}，但未确认进入关注总览`, verified.reason, anchors.diagnostics].filter(Boolean).join('；'),
    };
  }
  return {
    ok: true,
    code: 'open_following_overview',
    method: 'left_sidebar_following_locator',
    detail: [`已通过系统坐标点击个人页左侧栏关注 ${point.x},${point.y}`, screenshotPoint.ok ? screenshotPoint.detail : screenshotPoint.reason, verified.detail, anchors.diagnostics].filter(Boolean).join('；'),
  };
}

export async function cleanupWechatAutoplayTabsByLocator({ runner = execFileAsync, keepTabTitle = '关注' } = {}) {
  const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (!anchors.ok) return { ok: false, code: 'cleanup_autoplay_tabs', method: 'hover_tab_close', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };

  const axPlan = await findAutoplayTabClosePlanByAX({ runner, keepTabTitle });
  const screenshotPlan = axPlan.ok ? null : await findAutoplayTabClosePlanByScreenshot({ runner, anchors });
  if (!axPlan.ok && !screenshotPlan.ok) {
    const reference = autoplayTabClosePlanFromAnchors(anchors);
    return {
      ok: false,
      code: 'cleanup_autoplay_tabs',
      method: 'hover_tab_close',
      message: [
        '未能从当前系统截图精准识别关注左侧标签的关闭“×”，已停止点击',
        axPlan.reason,
        screenshotPlan.reason,
        reference && !reference.noop ? `几何参考 close=${reference.closeX},${reference.closeY}` : '',
        anchors.diagnostics,
      ].filter(Boolean).join('；'),
    };
  }
  const plan = axPlan.ok ? axPlan : screenshotPlan;
  if (plan.noop) {
    return { ok: true, code: 'cleanup_autoplay_tabs', method: 'hover_tab_close', detail: `${plan.detail || '关注左侧没有需要关闭的标签'}；closedCount=0；${anchors.diagnostics}` };
  }
  const planError = validateAutoplayTabClosePlan(plan, anchors);
  if (planError) return { ok: false, code: 'cleanup_autoplay_tabs', method: 'hover_tab_close', message: planError };

  await moveTo(plan.hoverX, plan.hoverY, { runner });
  await sleep(650);
  if (Number.isFinite(Number(plan.closeX)) && Number.isFinite(Number(plan.closeY))) {
    await clickAt(plan.closeX, plan.closeY, { runner });
  } else {
    return { ok: false, code: 'cleanup_autoplay_tabs', method: 'hover_tab_close', message: '关闭“×”坐标缺失，已停止点击' };
  }
  await sleep(500);
  return {
    ok: true,
    code: 'cleanup_autoplay_tabs',
    method: 'hover_tab_close',
    detail: [`已悬停并关闭关注左侧标签`, `hover=${Math.round(plan.hoverX)},${Math.round(plan.hoverY)}`, `close=${Math.round(plan.closeX || plan.hoverX + 42)},${Math.round(plan.closeY || plan.hoverY - 1)}`, `closedCount=1`, plan.detail, anchors.diagnostics].filter(Boolean).join('；'),
  };
}

export async function openWechatCreatorByFollowingScroll({ runner = execFileAsync, nickname, maxScrolls = CREATOR_SCROLL_ATTEMPTS } = {}) {
  const term = String(nickname || '').trim();
  if (!term) return { ok: false, code: 'creator_not_found', method: 'following_scroll_locator', message: '缺少视频号博主昵称' };

  const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (!anchors.ok) return { ok: false, code: 'creator_not_found', method: 'following_scroll_locator', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };

  let repeated = 0;
  let previousSignature = '';
  const attempts = Math.max(1, Math.min(30, Number(maxScrolls) || CREATOR_SCROLL_ATTEMPTS));
  const diagnostics = [];
  for (let attempt = 0; attempt <= attempts; attempt++) {
    let screenshot = null;
    try {
      screenshot = await captureSystemFullScreenshot({ runner });
      if (screenshot.ok) diagnostics.push(`第${attempt + 1}次截图 ${screenshot.diagnostics}`);

      const axLocated = await findCreatorPointByAX({ runner, nickname: term, anchors });
      const searchLocated = axLocated.ok ? null : await findCreatorPointByFindHighlight({ runner, nickname: term, anchors });
      const located = axLocated.ok ? axLocated : searchLocated;
      if (located.ok) {
        await clickAt(located.x, located.y, { runner });
        await sleep(1300);
        const verified = await verifyCreatorHomeVisible({ runner, nickname: term });
        if (!verified.ok) {
          return {
            ok: false,
            code: 'creator_not_found',
            method: 'following_scroll_locator',
            message: [`已点击关注列表博主 ${located.x},${located.y}，但未确认打开主页`, verified.reason, located.detail, anchors.diagnostics].filter(Boolean).join('；'),
          };
        }
        return {
          ok: true,
          code: 'open_creator_by_following_scroll',
          method: 'following_scroll_locator',
          detail: [`已通过关注总览打开匹配博主 ${term}`, `click=${located.x},${located.y}`, `scrollAttempts=${attempt}`, located.detail, verified.detail, ...diagnostics.slice(-3), anchors.diagnostics].filter(Boolean).join('；'),
        };
      }

      const signature = await readFollowingListSignatureByAX({ runner });
      const currentSignature = signature.signature || '';
      if (currentSignature && currentSignature === previousSignature) repeated += 1;
      else repeated = 0;
      previousSignature = currentSignature;
      diagnostics.push([axLocated.reason, searchLocated?.reason, signature.detail].filter(Boolean).join('；'));
      if (attempt >= attempts || repeated >= 2) {
        return {
          ok: false,
          code: 'creator_not_found',
          method: 'following_scroll_locator',
          message: [`未在关注总览找到匹配博主 ${term}`, `scrollAttempts=${attempt}`, repeated >= 2 ? '列表连续重复，判断已到底部' : '', ...diagnostics.slice(-5), anchors.diagnostics].filter(Boolean).join('；'),
        };
      }
      const scrollPoint = followingListScrollPointFromAnchors(anchors);
      await scrollAt(scrollPoint.x, scrollPoint.y, -7, { runner });
      await sleep(650);
    } finally {
      cleanupCapturedScreenshot(screenshot);
    }
  }

  return { ok: false, code: 'creator_not_found', method: 'following_scroll_locator', message: `未在关注总览找到匹配博主 ${term}` };
}

export async function openFirstNonPinnedWechatVideoByScreenshot({ runner = execFileAsync, nickname = '' } = {}) {
  const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (!anchors.ok) return { ok: false, code: 'open_first_non_pinned_video_by_screenshot', method: 'creator_grid_screenshot', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };

  let screenshot = null;
  try {
    screenshot = await captureSystemFullScreenshot({ runner });
    if (!screenshot.ok) return { ok: false, code: 'open_first_non_pinned_video_by_screenshot', method: 'creator_grid_screenshot', message: screenshot.reason || '无法截取系统全屏截图' };
    const screenshotCards = await analyzeCreatorVideoCardsByScreenshot(screenshot.path, anchors, { runner });
    const { cards: axCards, badges } = await readCreatorVideoCardsByAX({ runner, anchors });
    const cards = applyBadgesToCards(mergeCreatorCards(screenshotCards, axCards), badges);
    const picked = chooseFirstNonPinnedVideoCard(cards, anchors);
    if (!picked.ok) {
      return {
        ok: false,
        code: 'open_first_non_pinned_video_by_screenshot',
        method: 'creator_grid_screenshot',
        message: [picked.reason, `nickname=${nickname}`, `cards=${cards.length}`, screenshot.diagnostics, anchors.diagnostics].filter(Boolean).join('；'),
      };
    }

    await clickAt(picked.x, picked.y, { runner });
    await sleep(1400);
    const verified = await verifyVideoDetailVisible({ runner });
    if (!verified.ok) {
      return {
        ok: false,
        code: 'open_first_non_pinned_video_by_screenshot',
        method: 'creator_grid_screenshot',
        message: [`已点击第一条非置顶视频 ${picked.x},${picked.y}，但未确认进入详情页`, verified.reason, picked.detail, screenshot.diagnostics, anchors.diagnostics].filter(Boolean).join('；'),
      };
    }

    return {
      ok: true,
      code: 'open_first_non_pinned_video_by_screenshot',
      method: 'creator_grid_screenshot',
      detail: [`已通过截图定位打开第一条非置顶视频`, `click=${picked.x},${picked.y}`, `skippedPinned=${picked.skippedPinned || 0}`, picked.detail, verified.detail, screenshot.diagnostics, anchors.diagnostics].filter(Boolean).join('；'),
    };
  } catch (e) {
    return { ok: false, code: 'open_first_non_pinned_video_by_screenshot', method: 'creator_grid_screenshot', message: String(e.message || e) };
  } finally {
    cleanupCapturedScreenshot(screenshot);
  }
}

export async function goNextWechatVideoByScreenshot({ runner = execFileAsync } = {}) {
  const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (!anchors.ok) return { ok: false, code: 'go_next_video_by_screenshot', method: 'scroll_next_video', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };
  const focusPoint = videoSurfacePointFromAnchors(anchors);
  const before = await captureWechatWindowFingerprint({ runner, anchors });
  const beforeText = await readWechatSignalsByAX({ runner });

  const scrolled = await scrollToNextWechatVideo({ runner, anchors, focusPoint, before, beforeText });
  if (scrolled.ok) return scrolled;

  const arrow = await clickNextWechatArrowFallback({ runner, anchors, focusPoint, before, beforeText });
  if (arrow.ok) return arrow;

  return {
    ok: false,
    code: 'go_next_video_by_screenshot',
    method: 'scroll_next_video',
    message: ['滚动与右侧下箭头兜底都未确认切到下一条视频', scrolled.message, arrow.message, anchors.diagnostics].filter(Boolean).join('；'),
  };
}

async function scrollToNextWechatVideo({ runner, anchors, focusPoint, before, beforeText }) {
  const attempts = [-6, -10];
  let prev = before;
  let prevText = beforeText;
  let lastReason = '';
  for (const [i, delta] of attempts.entries()) {
    await scrollAt(focusPoint.x, focusPoint.y, delta, { runner });
    await sleep(1100);
    const after = await captureWechatWindowFingerprint({ runner, anchors });
    const afterText = await readWechatSignalsByAX({ runner });
    const changed = fingerprintChanged(prev, after) || compactForLog(prevText.text) !== compactForLog(afterText.text);
    if (changed) {
      return {
        ok: true,
        code: 'go_next_video_by_screenshot',
        method: 'scroll_next_video',
        detail: [`已在视频区域向下滚动切到下一条视频`, `scroll=${delta}`, `attempt=${i + 1}`, `focus=${focusPoint.x},${focusPoint.y}`, anchors.diagnostics].filter(Boolean).join('；'),
      };
    }
    lastReason = `第${i + 1}次向下滚动 ${delta} 未确认换片`;
    prev = after;
    prevText = afterText;
  }
  return { ok: false, message: lastReason };
}

async function clickNextWechatArrowFallback({ runner, anchors, focusPoint, before, beforeText }) {
  await mouseWiggle(focusPoint.x, focusPoint.y, { runner });
  await sleep(350);

  let screenshot = null;
  try {
    screenshot = await captureSystemFullScreenshot({ runner });
    if (!screenshot.ok) return { ok: false, message: screenshot.reason || '无法截取系统全屏截图' };
    const candidates = await analyzeNextArrowCandidatesByScreenshot(screenshot.path, anchors, { runner });
    const picked = chooseNextVideoArrowCandidate(candidates, anchors);
    if (!picked.ok) {
      return { ok: false, message: [picked.reason, screenshot.diagnostics].filter(Boolean).join('；') };
    }

    await clickAt(picked.x, picked.y, { runner });
    await sleep(1100);
    const after = await captureWechatWindowFingerprint({ runner, anchors });
    const afterText = await readWechatSignalsByAX({ runner });
    const changed = fingerprintChanged(before, after) || compactForLog(beforeText.text) !== compactForLog(afterText.text);
    if (!changed) {
      return { ok: false, message: [`已点击右侧下箭头 ${picked.x},${picked.y}，但截图/文本未确认变化`, picked.detail, screenshot.diagnostics].filter(Boolean).join('；') };
    }
    return {
      ok: true,
      code: 'go_next_video_by_screenshot',
      method: 'right_arrow_screenshot',
      detail: [`滚动未换片，兜底用截图识别右侧下箭头并点击`, `click=${picked.x},${picked.y}`, picked.detail, screenshot.diagnostics, anchors.diagnostics].filter(Boolean).join('；'),
    };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  } finally {
    cleanupCapturedScreenshot(screenshot);
  }
}

export async function closeWechatCreatorWithCommandW({ runner = execFileAsync, keepTabTitle = '关注' } = {}) {
  const before = await readWechatSignalsByAX({ runner });
  try {
    await commandW({ runner });
    await sleep(320);
    await commandW({ runner });
    await sleep(900);
  } catch (e) {
    return { ok: false, code: 'close_creator_with_command_w', method: 'command_w', message: String(e.stderr || e.message || e) };
  }
  const verified = await verifyFollowingOverviewVisible({ runner, point: null });
  if (!verified.ok) {
    return {
      ok: false,
      code: 'close_creator_with_command_w',
      method: 'command_w',
      message: [`已发送两次 Command+W，但未确认回到“${keepTabTitle}”总览`, verified.reason, before.ok ? `关闭前=${compactForLog(before.text)}` : before.reason].filter(Boolean).join('；'),
    };
  }
  return {
    ok: true,
    code: 'close_creator_with_command_w',
    method: 'command_w',
    detail: [`已发送两次 Command+W 并确认回到“${keepTabTitle}”总览`, verified.detail].filter(Boolean).join('；'),
  };
}

export function profileEntryPointFromAnchors(anchors) {
  if (!anchors?.ok) return null;
  const { window } = anchors;
  const rightInset = window.width < 1000 ? 25 : 54;
  return {
    x: Math.round(window.x + window.width - rightInset),
    y: Math.round(window.y + 70),
  };
}

export function validateProfileEntryPoint(point, anchors) {
  if (!point || !anchors?.ok) return '缺少右上角小人定位点或窗口锚点';
  const { window } = anchors;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return '右上角小人定位点不是有效数字';
  if (point.x < window.x + window.width * 0.82 || point.x > window.x + window.width - 16) return `右上角小人横坐标越界: ${point.x}`;
  if (point.y < window.y + 58 || point.y > window.y + 150) return `右上角小人纵坐标越界: ${point.y}`;
  return null;
}

export function followingSidebarPointFromAnchors(anchors) {
  if (!anchors?.ok) return null;
  const { window } = anchors;
  return {
    x: Math.round(window.x + Math.min(110, Math.max(92, window.width * 0.105))),
    y: Math.round(window.y + Math.min(Math.max(240, window.height * 0.22), 270)),
  };
}

export function validateFollowingSidebarPoint(point, anchors) {
  if (!point || !anchors?.ok) return '缺少左侧关注定位点或窗口锚点';
  const { window } = anchors;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return '左侧关注定位点不是有效数字';
  if (point.x < window.x + 60 || point.x > window.x + window.width * 0.42) return `左侧关注横坐标越界，拒绝点击顶部关注: ${point.x}`;
  if (point.y < window.y + 120 || point.y > window.y + window.height - 60) return `左侧关注纵坐标越界: ${point.y}`;
  return null;
}

export function autoplayTabClosePlanFromAnchors(anchors) {
  if (!anchors?.ok) return null;
  const { window } = anchors;
  const tabY = Math.round(window.y + 40);
  const previousCenterX = Math.round(window.x + window.width * 0.30);
  const previousCloseX = Math.round(window.x + window.width * 0.408);
  if (previousCenterX < window.x + 100 || previousCloseX < window.x + 160) return { noop: true, detail: '关注标签左侧没有可关闭标签' };
  return {
    hoverX: previousCenterX,
    hoverY: tabY,
    closeX: previousCloseX,
    closeY: tabY - 1,
    detail: '顶部标签栏几何兜底，按视频号标签右侧关闭按钮定位',
  };
}

export function validateAutoplayTabClosePlan(plan, anchors) {
  if (!plan || !anchors?.ok) return '缺少关闭标签计划或窗口锚点';
  if (plan.noop) return null;
  const { window } = anchors;
  for (const [key, value] of Object.entries({ hoverX: plan.hoverX, hoverY: plan.hoverY, closeX: plan.closeX, closeY: plan.closeY })) {
    if (!Number.isFinite(Number(value))) return `关闭标签计划 ${key} 不是有效数字`;
  }
  if (plan.hoverY < window.y + 16 || plan.hoverY > window.y + 92) return `悬停点不在顶部标签栏: ${plan.hoverY}`;
  if (plan.hoverX < window.x + 80 || plan.hoverX > window.x + window.width * 0.72) return `悬停点横坐标越界: ${plan.hoverX}`;
  if (plan.closeX < window.x + 80 || plan.closeX > window.x + window.width * 0.72) return `关闭点横坐标越界: ${plan.closeX}`;
  return null;
}

export function chooseFollowingSidebarPointFromRows(rows = [], anchors) {
  if (!anchors?.ok) return { ok: false, reason: '缺少窗口锚点' };
  const { window } = anchors;
  const maxSidebarX = window.x + 155;
  const minSidebarX = window.x + 18;
  const minSidebarY = window.y + 52;
  const maxSidebarY = window.y + Math.min(430, Math.max(300, window.height * 0.62));
  const normalized = rows
    .map((row) => ({
      centerX: Number(row.centerX),
      centerY: Number(row.centerY),
      width: Number(row.width || 0),
      height: Number(row.height || 0),
      darkPixels: Number(row.darkPixels || 0),
    }))
    .filter((row) => [row.centerX, row.centerY].every(Number.isFinite))
    .filter((row) => (
      row.centerX >= minSidebarX
      && row.centerX <= maxSidebarX
      && row.centerY >= minSidebarY
      && row.centerY <= maxSidebarY
      && row.width <= 170
    ))
    .sort((a, b) => a.centerY - b.centerY);
  if (normalized.length < 3) {
    return { ok: false, reason: `左侧栏文字行不足 rows=${normalized.map((row) => Math.round(row.centerY)).join(',')}` };
  }
  const groups = [];
  for (const row of normalized) {
    const last = groups.at(-1);
    if (last && Math.abs(row.centerY - last.centerY) <= FOLLOWING_SIDEBAR_ROW_MERGE_GAP) {
      const weight = Math.max(1, row.darkPixels);
      const totalWeight = last.weight + weight;
      last.centerX = ((last.centerX * last.weight) + (row.centerX * weight)) / totalWeight;
      last.centerY = ((last.centerY * last.weight) + (row.centerY * weight)) / totalWeight;
      last.width = Math.max(last.width, row.width);
      last.height += row.height;
      last.darkPixels += row.darkPixels;
      last.weight = totalWeight;
      last.count += 1;
    } else {
      groups.push({ ...row, weight: Math.max(1, row.darkPixels), count: 1 });
    }
  }
  if (groups.length < 3) {
    return {
      ok: false,
      reason: `左侧栏文字组不足 rows=${normalized.map((row) => Math.round(row.centerY)).join(',')} groups=${groups.map((group) => Math.round(group.centerY)).join(',')}`,
    };
  }
  const spacings = groups.slice(1).map((group, index) => group.centerY - groups[index].centerY);
  const medianSpacing = median(spacings);
  const minSpacing = groups.length >= 4 ? 32 : 46;
  if (!Number.isFinite(medianSpacing) || medianSpacing < minSpacing) {
    return {
      ok: false,
      reason: `左侧栏文字组间距异常，拒绝点击: groups=${groups.map((group) => Math.round(group.centerY)).join(',')} spacing=${Number.isFinite(medianSpacing) ? medianSpacing.toFixed(1) : 'n/a'}`,
    };
  }
  const target = groups[2];
  const reference = followingSidebarPointFromAnchors(anchors);
  if (groups.length < 4 && reference && Math.abs(target.centerY - reference.y) > 90) {
    return {
      ok: false,
      reason: `左侧栏关注候选偏离几何参考，拒绝点击: target=${Math.round(target.centerX)},${Math.round(target.centerY)} reference=${reference.x},${reference.y} groups=${groups.map((group) => Math.round(group.centerY)).join(',')}`,
    };
  }
  const point = {
    ok: true,
    x: Math.max(Math.round(target.centerX), Math.round(window.x + 60)),
    y: Math.round(target.centerY),
    confidence: groups.length >= 4 ? 0.92 : 0.78,
    detail: `system_screenshot_left_sidebar_following rows=${normalized.map((row) => Math.round(row.centerY)).join(',')} groups=${groups.map((group) => Math.round(group.centerY)).join(',')} target=${Math.round(target.centerX)},${Math.round(target.centerY)}`,
  };
  const pointError = validateFollowingSidebarPoint(point, anchors);
  if (pointError) return { ok: false, reason: pointError, rows: normalized };
  return point;
}

export function chooseCreatorSearchHighlightPointFromRects(rects = [], anchors) {
  if (!anchors?.ok) return { ok: false, reason: '缺少窗口锚点' };
  const { window } = anchors;
  const normalized = rects
    .map((rect) => ({
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.width || 0),
      height: Number(rect.height || 0),
      pixels: Number(rect.pixels || 0),
    }))
    .filter((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
    .filter((rect) => (
      rect.width >= 18
      && rect.height >= 8
      && rect.width <= 220
      && rect.height <= 42
      && rect.x >= window.x + 180
      && rect.x <= window.x + window.width - 90
      && rect.y >= window.y + 110
      && rect.y <= window.y + window.height - 35
    ))
    .sort((a, b) => (b.pixels * b.width * b.height) - (a.pixels * a.width * a.height));
  if (!normalized.length) return { ok: false, reason: `未找到查找高亮候选 rects=${rects.length}` };
  const picked = normalized[0];
  return {
    ok: true,
    x: Math.round(picked.x + (picked.width / 2)),
    y: Math.round(picked.y + (picked.height / 2)),
    detail: `find_highlight rect=${Math.round(picked.x)},${Math.round(picked.y)},${Math.round(picked.width)}x${Math.round(picked.height)} candidates=${normalized.length}`,
  };
}

function creatorCardClickPoint(card) {
  const x = Number(card.x);
  const y = Number(card.y);
  const height = Number(card.height || 0);
  const width = Number(card.width || 0);
  if (![x, y, height, width].every(Number.isFinite) || height <= 0 || width <= 0) return { x, y };
  return {
    x,
    y: y - Math.min(56, Math.max(22, height * 0.18)),
  };
}

export function chooseAutoplayClosePlanFromCandidates(candidates = [], anchors) {
  if (!anchors?.ok) return { ok: false, reason: '缺少窗口锚点' };
  const { window } = anchors;
  const normalized = candidates
    .map((candidate) => ({
      x: Number(candidate.x),
      y: Number(candidate.y),
      score: Number(candidate.score || 0),
      width: Number(candidate.width || 0),
      height: Number(candidate.height || 0),
    }))
    .filter((candidate) => [candidate.x, candidate.y].every(Number.isFinite))
    .filter((candidate) => candidate.x > window.x + Math.min(260, window.width * 0.22))
    .sort((a, b) => a.x - b.x);
  const groups = [];
  for (const candidate of normalized) {
    const last = groups.at(-1);
    if (last && Math.abs(candidate.x - last.x) <= 36) {
      const weight = Math.max(0.01, candidate.score);
      const totalWeight = last.weight + weight;
      last.x = ((last.x * last.weight) + (candidate.x * weight)) / totalWeight;
      last.y = ((last.y * last.weight) + (candidate.y * weight)) / totalWeight;
      last.weight = totalWeight;
      last.count += 1;
    } else {
      groups.push({ ...candidate, weight: Math.max(0.01, candidate.score), count: 1 });
    }
  }
  if (groups.length === 0) {
    return { ok: false, reason: `系统截图未识别到顶部标签关闭“×” closeCandidates=${normalized.map((candidate) => Math.round(candidate.x)).join(',')}` };
  }
  if (groups.length === 1) {
    return { ok: true, noop: true, detail: `关注左侧没有可关闭标签 closeCandidates=${normalized.map((candidate) => Math.round(candidate.x)).join(',')}` };
  }
  const target = groups[groups.length - 2];
  const plan = {
    ok: true,
    hoverX: Math.round(Math.max(window.x + 100, target.x - 120)),
    hoverY: Math.round(target.y + 1),
    closeX: Math.round(target.x),
    closeY: Math.round(target.y),
    detail: `system_screenshot_tab_close closeCandidates=${normalized.map((candidate) => Math.round(candidate.x)).join(',')} groups=${groups.map((group) => Math.round(group.x)).join(',')} target=${Math.round(target.x)},${Math.round(target.y)}`,
  };
  const planError = validateAutoplayTabClosePlan(plan, anchors);
  if (planError) return { ok: false, reason: planError, candidates: normalized };
  return plan;
}

export function chooseFirstNonPinnedVideoCard(cards = [], anchors) {
  if (!anchors?.ok) return { ok: false, reason: '缺少窗口锚点' };
  const { window } = anchors;
  const normalized = cards
    .map((card) => ({
      x: Number(card.x ?? card.centerX),
      y: Number(card.y ?? card.centerY),
      width: Number(card.width || 0),
      height: Number(card.height || 0),
      pinned: !!card.pinned || /置顶/.test(String(card.label || '')),
      blocked: /直播|预约/.test(String(card.label || '')),
      confidence: Number(card.confidence || card.score || 0),
      label: String(card.label || ''),
      source: card.source || 'screenshot',
    }))
    .filter((card) => [card.x, card.y, card.width, card.height].every(Number.isFinite))
    .filter((card) => card.width >= 64 && card.height >= 64)
    .filter((card) => card.x > window.x + Math.min(180, window.width * 0.16))
    .filter((card) => card.y > window.y + 130 && card.y < window.y + window.height - 55)
    .sort((a, b) => {
      const rowA = Math.round(a.y / 48);
      const rowB = Math.round(b.y / 48);
      return rowA === rowB ? a.x - b.x : a.y - b.y;
    });
  const skippedPinned = normalized.filter((card) => card.pinned).length;
  const skippedBlocked = normalized.filter((card) => card.blocked).length;
  const picked = normalized.find((card) => !card.pinned && !card.blocked && card.confidence >= 0.55);
  if (!picked) {
    return {
      ok: false,
      reason: `未识别到高置信非置顶视频卡片 cards=${normalized.length} pinned=${skippedPinned} blocked=${skippedBlocked}`,
      cards: normalized,
    };
  }
  const clickPoint = creatorCardClickPoint(picked);
  return {
    ok: true,
    x: Math.round(clickPoint.x),
    y: Math.round(clickPoint.y),
    skippedPinned,
    skippedBlocked,
    confidence: picked.confidence,
    detail: `creator_grid_card source=${picked.source} cards=${normalized.length} pinned=${skippedPinned} blocked=${skippedBlocked} picked=${Math.round(picked.x)},${Math.round(picked.y)} click=${Math.round(clickPoint.x)},${Math.round(clickPoint.y)} size=${Math.round(picked.width)}x${Math.round(picked.height)}`,
  };
}

export function chooseNextVideoArrowCandidate(candidates = [], anchors) {
  if (!anchors?.ok) return { ok: false, reason: '缺少窗口锚点' };
  const { window } = anchors;
  const normalized = candidates
    .map((candidate) => ({
      x: Number(candidate.x),
      y: Number(candidate.y),
      width: Number(candidate.width || 0),
      height: Number(candidate.height || 0),
      score: Number(candidate.score || 0),
      direction: String(candidate.direction || ''),
    }))
    .filter((candidate) => [candidate.x, candidate.y].every(Number.isFinite))
    .filter((candidate) => candidate.x > window.x + window.width * 0.68)
    .filter((candidate) => candidate.y > window.y + window.height * 0.35 && candidate.y < window.y + window.height * 0.82)
    .sort((a, b) => {
      const dirScore = (value) => value.direction === 'down' ? 1 : 0;
      if (dirScore(a) !== dirScore(b)) return dirScore(b) - dirScore(a);
      if (Math.abs(a.score - b.score) > 0.02) return b.score - a.score;
      return b.y - a.y;
    });
  const picked = normalized[0];
  if (!picked || picked.score < 0.16) {
    return {
      ok: false,
      reason: `系统截图未识别到右侧下箭头 candidates=${normalized.map((candidate) => `${Math.round(candidate.x)},${Math.round(candidate.y)}:${candidate.score.toFixed(2)}`).join('/')}`,
      candidates: normalized,
    };
  }
  return {
    ok: true,
    x: Math.round(picked.x),
    y: Math.round(picked.y),
    confidence: picked.score,
    detail: `right_arrow candidates=${normalized.map((candidate) => `${Math.round(candidate.x)},${Math.round(candidate.y)}:${candidate.score.toFixed(2)}:${candidate.direction || 'unknown'}`).join('/')} picked=${Math.round(picked.x)},${Math.round(picked.y)}`,
  };
}

export function validateChannelsWindowFullScreenshotMetrics(metrics = {}) {
  const bodyTotal = Number(metrics.bodyTotal);
  const bodyBlackRatio = Number(metrics.bodyBlackRatio);
  const bodyDarkRatio = Number(metrics.bodyDarkRatio);
  const bodyBrightRatio = Number(metrics.bodyBrightRatio);
  const bodyMidRatio = Number(metrics.bodyMidRatio);
  if (![bodyTotal, bodyBlackRatio, bodyDarkRatio, bodyBrightRatio, bodyMidRatio].every(Number.isFinite)) {
    return '全屏截图缺少视频号窗口颜色指标';
  }
  if (bodyTotal < 4000) return `全屏截图窗口采样点不足: ${bodyTotal}`;
  const darkVideoSurface = bodyBlackRatio >= 0.5 && bodyDarkRatio >= 0.6;
  const darkVideoWithContent = bodyBlackRatio >= 0.42 && bodyDarkRatio >= 0.55 && (bodyBrightRatio >= 0.035 || bodyMidRatio >= 0.02);
  if (darkVideoSurface || darkVideoWithContent) return null;
  return `全屏截图未检测到视频号黑色视频窗口 black=${bodyBlackRatio.toFixed(3)} dark=${bodyDarkRatio.toFixed(3)} bright=${bodyBrightRatio.toFixed(3)} mid=${bodyMidRatio.toFixed(3)}`;
}

export function validateChannelsLightPageScreenshotMetrics(metrics = {}) {
  const topTotal = Number(metrics.topTotal);
  const topOrangePixels = Number(metrics.topOrangePixels);
  const topOrangeClusters = Number(metrics.topOrangeClusters);
  const bodyTotal = Number(metrics.bodyTotal);
  const bodyBrightRatio = Number(metrics.bodyBrightRatio);
  const bodyDarkRatio = Number(metrics.bodyDarkRatio);
  if (![topTotal, topOrangePixels, topOrangeClusters, bodyTotal, bodyBrightRatio, bodyDarkRatio].every(Number.isFinite)) {
    return '全屏截图缺少视频号亮色页颜色指标';
  }
  if (topTotal < 1200 || bodyTotal < 4000) return `全屏截图亮色页采样点不足: top=${topTotal} body=${bodyTotal}`;
  const orangeRatio = topOrangePixels / Math.max(topTotal, 1);
  if (orangeRatio > 0.02) return `全屏截图亮色页橙色面积异常 topOrange=${topOrangePixels} clusters=${topOrangeClusters} ratio=${orangeRatio.toFixed(4)}`;
  const orangeSignal = topOrangePixels >= 70 && topOrangeClusters >= 1 && orangeRatio >= 0.0009;
  const lightBody = bodyBrightRatio >= 0.45 && bodyDarkRatio <= 0.34;
  if (orangeSignal && lightBody) return null;
  return `全屏截图未检测到视频号亮色页 topOrange=${topOrangePixels} clusters=${topOrangeClusters} ratio=${orangeRatio.toFixed(4)} bright=${bodyBrightRatio.toFixed(3)} dark=${bodyDarkRatio.toFixed(3)}`;
}

export function channelsLightPageNeedsRailConfirmation(anchors) {
  if (!anchors?.ok) return true;
  const name = String(anchors.window?.name || '');
  const width = Number(anchors.window?.width || 0);
  if (/视频号|Channels|窗口/i.test(name)) return false;
  if (Number.isFinite(width) && width > 0 && width < 1100) return false;
  return true;
}

function creatorCandidateRoleRank(c) {
  const role = String(c?.role || '');
  const width = Number(c?.width || 0);
  const height = Number(c?.height || 0);
  const small = height > 0 && height <= 52 && width > 0 && width <= 360;
  if (small && /AXStaticText/.test(role)) return 0;
  if (/AXLink|AXButton/.test(role) && height <= 72) return 1;
  if (/AXStaticText/.test(role)) return 2;
  if (/AXLink|AXButton/.test(role)) return 3;
  if (/AXCell|AXGroup|AXRow/.test(role)) return 4;
  return 5;
}

function isLargeCreatorCandidate(c) {
  const role = String(c?.role || '');
  const width = Number(c?.width || 0);
  const height = Number(c?.height || 0);
  return /AXCell|AXGroup|AXRow/.test(role) || height > 72 || width > 420;
}

function creatorCandidateClickPoint(c, anchors) {
  if (!isLargeCreatorCandidate(c)) {
    return { x: c.x, y: c.y, adjusted: false, centerX: c.x, centerY: c.y };
  }
  const { window } = anchors;
  const width = Number(c.width) > 0 ? Number(c.width) : 180;
  const height = Number(c.height) > 0 ? Number(c.height) : 96;
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const x = Math.round(clamp(left + clamp(width * 0.2, 76, 172), window.x + 90, window.x + window.width * 0.82));
  const y = Math.round(clamp(top + clamp(height * 0.28, 22, 48), window.y + 96, window.y + window.height - 42));
  return { x, y, adjusted: true, centerX: c.x, centerY: c.y };
}

export function chooseCreatorCandidate(candidates = [], { nickname, anchors } = {}) {
  if (!anchors?.ok) return { ok: false, reason: '缺少窗口锚点' };
  const term = String(nickname || '').trim();
  if (!term) return { ok: false, reason: '缺少昵称' };
  const { window } = anchors;
  const inBounds = (c) => c.x >= window.x + 80 && c.x <= window.x + window.width * 0.86
    && c.y >= window.y + 90 && c.y <= window.y + window.height - 36;
  const countOccurrences = (haystack, needle) => {
    let n = 0;
    let i = String(haystack || '').indexOf(needle);
    while (i !== -1) {
      n += 1;
      i = String(haystack || '').indexOf(needle, i + needle.length);
    }
    return n;
  };
  const normalized = candidates
    .map((c) => {
      const label = String(c.label || '').trim();
      const occ = countOccurrences(label, term);
      const coverage = label.length ? Math.min(1, (term.length * occ) / label.length) : 0;
      return {
        x: Math.round(Number(c.x)),
        y: Math.round(Number(c.y)),
        width: Number(c.width || 0),
        height: Number(c.height || 0),
        role: String(c.role || ''),
        label,
        exact: label === term,
        contains: occ > 0,
        coverage,
      };
    })
    .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && c.contains && inBounds(c));
  if (!normalized.length) return { ok: false, reason: `关注列表无可点击的昵称候选 term=${term}` };

  const pool = normalized.filter((c) => c.exact || c.coverage >= 0.5);
  if (!pool.length) {
    return {
      ok: false,
      reason: `关注列表只有包含昵称的长文本，拒绝误点 term=${term} 候选=${normalized.map((c) => `${c.x},${c.y}:cov${c.coverage.toFixed(2)}`).join('/')}`,
    };
  }
  pool.sort((a, b) => {
    const roleDelta = creatorCandidateRoleRank(a) - creatorCandidateRoleRank(b);
    if (roleDelta !== 0) return roleDelta;
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (Math.abs(a.coverage - b.coverage) > 0.01) return b.coverage - a.coverage;
    if (Math.abs(a.y - b.y) > 12) return a.y - b.y;
    return a.x - b.x;
  });
  const picked = pool[0];
  const clickPoint = creatorCandidateClickPoint(picked, anchors);
  return {
    ok: true,
    x: clickPoint.x,
    y: clickPoint.y,
    detail: `AX昵称匹配 role=${picked.role || 'unknown'} exact=${picked.exact} coverage=${picked.coverage.toFixed(2)} adjusted=${clickPoint.adjusted} pool=${pool.length}/${normalized.length} center=${clickPoint.centerX},${clickPoint.centerY} click=${clickPoint.x},${clickPoint.y} label=${compactForLog(picked.label)}`,
  };
}

async function findCreatorPointByAX({ runner, nickname, anchors }) {
  const script = `
on run
  set term to ${JSON.stringify(nickname)}
  set rowItems to {}
  tell application "System Events"
    repeat with bid in {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
      try
        set p to first process whose bundle identifier is bid
        if (count of windows of p) > 0 then
          set w to window 1 of p
          set wp to position of w
          set ws to size of w
          repeat with el in entire contents of p
            set label to my vbp_text(el)
            if label contains term then
              try
                set ep to position of el
                set es to size of el
                set cx to (item 1 of ep) + ((item 1 of es) / 2)
                set cy to (item 2 of ep) + ((item 2 of es) / 2)
                if cx > (item 1 of wp) + 95 and cx < (item 1 of wp) + ((item 1 of ws) * 0.82) and cy > (item 2 of wp) + 98 and cy < (item 2 of wp) + (item 2 of ws) - 42 then
                  set elRole to ""
                  try
                    set elRole to role of el as text
                  end try
                  set end of rowItems to "CAND|" & (cx as text) & "|" & (cy as text) & "|" & ((item 1 of es) as text) & "|" & ((item 2 of es) as text) & "|" & elRole & "|" & my vbp_compact(label, 120)
                end if
              end try
            end if
            if (count of rowItems) >= 60 then exit repeat
          end repeat
          if (count of rowItems) > 0 then exit repeat
        end if
      end try
    end repeat
  end tell
  if (count of rowItems) is 0 then return "ERR|当前可见关注列表未找到昵称"
  set AppleScript's text item delimiters to linefeed
  set outText to rowItems as text
  set AppleScript's text item delimiters to ""
  return outText
end run

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

on vbp_compact(valueText, maxLen)
  set s to valueText as text
  set s to my vbp_replace(s, return, " ")
  set s to my vbp_replace(s, linefeed, " ")
  if length of s > maxLen then return (text 1 thru maxLen of s) & "..."
  return s
end vbp_compact

on vbp_replace(sourceText, searchText, replacementText)
  set AppleScript's text item delimiters to searchText
  set parts to text items of sourceText
  set AppleScript's text item delimiters to replacementText
  set joinedText to parts as text
  set AppleScript's text item delimiters to ""
  return joinedText
end vbp_replace
`;
  try {
    const { stdout } = await runner('osascript', ['-e', script], { timeout: 8_000 });
    const text = String(stdout || '').trim();
    if (!text || text.startsWith('ERR|')) return { ok: false, reason: text.replace(/^ERR\|/, '') || 'AX 未找到博主' };
    if (!text.startsWith('CAND|')) {
      if (!text.startsWith('OK|')) return { ok: false, reason: text || 'AX 未找到博主' };
      // Backward-compatible parser for older test runners.
      const [, xRaw, yRaw, label] = text.split('|');
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: `AX 返回博主坐标无效: ${text}` };
      const { window } = anchors;
      if (x < window.x + 80 || x > window.x + window.width * 0.86 || y < window.y + 90 || y > window.y + window.height - 36) {
        return { ok: false, reason: `AX 博主坐标越界: ${Math.round(x)},${Math.round(y)}` };
      }
      return { ok: true, x: Math.round(x), y: Math.round(y), detail: `AX昵称匹配=${compactForLog(label)}` };
    }
    const candidates = text
      .split(/\r?\n/)
      .map((line) => line.split('|'))
      .filter((parts) => parts[0] === 'CAND')
      .map((parts) => ({
        x: Number(parts[1]),
        y: Number(parts[2]),
        width: Number(parts[3]),
        height: Number(parts[4]),
        role: parts[5] || '',
        label: parts.slice(6).join('|'),
      }));
    return chooseCreatorCandidate(candidates, { nickname, anchors });
  } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message || e) };
  }
}

async function findCreatorPointByFindHighlight({ runner, nickname, anchors }) {
  let screenshot = null;
  try {
    const opened = await openFindOverlayWithNickname({ runner, nickname });
    if (!opened.ok) return { ok: false, reason: opened.reason || '未能打开查找框' };
    await sleep(450);
    screenshot = await captureSystemFullScreenshot({ runner });
    if (!screenshot.ok) return { ok: false, reason: screenshot.reason || '无法截取查找结果截图' };
    const rects = await analyzeFindHighlightRectsByScreenshot(screenshot.path, anchors, { runner });
    const picked = chooseCreatorSearchHighlightPointFromRects(rects, anchors);
    if (!picked.ok) {
      await closeFindOverlay({ runner });
      return { ok: false, reason: [picked.reason, `find=${nickname}`, screenshot.diagnostics].filter(Boolean).join('；') };
    }
    return {
      ok: true,
      x: picked.x,
      y: picked.y,
      detail: [`查找高亮直接点击=${nickname}`, picked.detail, screenshot.diagnostics].filter(Boolean).join('；'),
    };
  } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message || e) };
  } finally {
    cleanupCapturedScreenshot(screenshot);
  }
}

async function openFindOverlayWithNickname({ runner, nickname }) {
  const script = `
on run
  set term to ${JSON.stringify(nickname)}
  set oldClipboard to ""
  set shouldRestore to false
  try
    set oldClipboard to the clipboard as text
    set shouldRestore to true
  end try
  try
    tell application id "com.tencent.xinWeChat" to activate
  end try
  delay 0.15
  tell application "System Events"
    keystroke "f" using command down
    delay 0.2
    keystroke "a" using command down
    delay 0.05
    set the clipboard to term
    keystroke "v" using command down
    delay 0.25
  end tell
  if shouldRestore then
    try
      set the clipboard to oldClipboard
    end try
  end if
  return "OK|find pasted"
end run
`;
  try {
    const { stdout } = await runner('osascript', ['-e', script], { timeout: 8_000 });
    const text = String(stdout || '').trim();
    if (text.startsWith('OK|')) return { ok: true, detail: text.slice(3) };
    return { ok: false, reason: text || '查找框无输出' };
  } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message || e) };
  }
}

async function closeFindOverlay({ runner }) {
  try {
    await runner('osascript', ['-e', 'tell application "System Events" to key code 53'], { timeout: 4_000 });
  } catch {}
}

async function readFollowingListSignatureByAX({ runner }) {
  const signals = await readWechatSignalsByAX({ runner });
  if (!signals.ok) return { signature: '', detail: signals.reason || 'AX 列表不可读' };
  const lines = String(signals.text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/视频号|赞和收藏|展开|点赞|评论|收藏|转发/.test(line))
    .slice(-24);
  return {
    signature: lines.join('|').slice(0, 1000),
    detail: `列表签名=${compactForLog(lines.join(' / '))}`,
  };
}

async function verifyCreatorHomeVisible({ runner, nickname }) {
  const ax = await readWechatSignalsByAX({ runner });
  if (ax.ok && ax.text.includes(nickname) && /关注|粉丝|作品|视频|动态/.test(ax.text)) {
    return { ok: true, detail: `AX确认博主主页: ${compactForLog(ax.text)}` };
  }
  const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (anchors.ok) {
    let screenshot = null;
    try {
      screenshot = await captureSystemFullScreenshot({ runner });
      if (screenshot.ok) {
        const cards = await analyzeCreatorVideoCardsByScreenshot(screenshot.path, anchors, { runner });
        if (cards.length > 0) {
          return {
            ok: true,
            detail: `system_screenshot_creator_home cards=${cards.length}; ${screenshot.diagnostics}; ${anchors.diagnostics}`,
          };
        }
      }
    } catch (e) {
      return { ok: false, reason: [ax.reason, String(e.message || e), anchors.diagnostics].filter(Boolean).join('；') };
    } finally {
      cleanupCapturedScreenshot(screenshot);
    }
  }
  return { ok: false, reason: [ax.reason, anchors.reason, `未确认打开博主主页 ${nickname}`].filter(Boolean).join('；') };
}

async function verifyVideoDetailVisible({ runner }) {
  const ax = await readWechatSignalsByAX({ runner });
  if (ax.ok && /展开|点赞|评论|收藏|转发/.test(ax.text)) {
    return { ok: true, detail: `AX确认视频详情: ${compactForLog(ax.text)}` };
  }
  const screenshot = await analyzeCurrentWechatWindowByScreenshot({ runner });
  if (screenshot.ok && screenshot.videoDetail) return { ok: true, detail: screenshot.detail };
  return { ok: false, reason: [ax.reason, screenshot.reason || screenshot.detail].filter(Boolean).join('；') || '未确认视频详情页' };
}

function followingListScrollPointFromAnchors(anchors) {
  const { window } = anchors;
  return {
    x: Math.round(window.x + Math.min(Math.max(window.width * 0.32, 260), window.width - 160)),
    y: Math.round(window.y + window.height * 0.58),
  };
}

function videoSurfacePointFromAnchors(anchors) {
  const { window } = anchors;
  return {
    x: Math.round(window.x + window.width * 0.54),
    y: Math.round(window.y + window.height * 0.52),
  };
}

async function readCreatorVideoCardsByAX({ runner, anchors }) {
  const { window } = anchors;
  // Capture both large card-like elements and small AX badges such as 置顶.
  // Badges are later mapped back to screenshot cards by geometry.
  const script = `
on run
  tell application "System Events"
    repeat with bid in {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
      try
        set p to first process whose bundle identifier is bid
        if (count of windows of p) > 0 then
          set rows to {}
          repeat with el in entire contents of p
            set label to my vbp_text(el)
            if label is not "" then
              try
                set ep to position of el
                set es to size of el
                set bcx to (item 1 of ep) + ((item 1 of es) / 2)
                set bcy to (item 2 of ep) + ((item 2 of es) / 2)
                if label contains "置顶" then
                  set end of rows to "BADGE|pinned|" & (bcx as text) & "|" & (bcy as text) & "|置顶"
                else if label contains "直播" then
                  set end of rows to "BADGE|blocked|" & (bcx as text) & "|" & (bcy as text) & "|直播"
                else if label contains "预约" then
                  set end of rows to "BADGE|blocked|" & (bcx as text) & "|" & (bcy as text) & "|预约"
                end if
                if (item 1 of es) > 60 and (item 2 of es) > 60 then
                  set end of rows to "CARD|" & ((item 1 of ep) as text) & "|" & ((item 2 of ep) as text) & "|" & ((item 1 of es) as text) & "|" & ((item 2 of es) as text) & "|" & my vbp_compact(label, 80)
                end if
              end try
            end if
            if (count of rows) >= 140 then exit repeat
          end repeat
          set AppleScript's text item delimiters to linefeed
          set outText to rows as text
          set AppleScript's text item delimiters to ""
          return outText
        end if
      end try
    end repeat
  end tell
  return ""
end run

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

on vbp_compact(valueText, maxLen)
  set s to valueText as text
  set s to my vbp_replace(s, return, " ")
  set s to my vbp_replace(s, linefeed, " ")
  if length of s > maxLen then return (text 1 thru maxLen of s) & "..."
  return s
end vbp_compact

on vbp_replace(sourceText, searchText, replacementText)
  set AppleScript's text item delimiters to searchText
  set parts to text items of sourceText
  set AppleScript's text item delimiters to replacementText
  set joinedText to parts as text
  set AppleScript's text item delimiters to ""
  return joinedText
end vbp_replace
`;
  try {
    const { stdout } = await runner('osascript', ['-e', script], { timeout: 8_000 });
    const lines = String(stdout || '').trim().split(/\r?\n/).map((line) => line.split('|'));
    const inGrid = (x, y) => x > window.x + 120 && y > window.y + 120 && x < window.x + window.width - 40 && y < window.y + window.height - 40;
    const cards = lines
      .filter((parts) => parts[0] === 'CARD')
      .map((parts) => {
        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const width = Number(parts[3]);
        const height = Number(parts[4]);
        return {
          x: Math.round(x + width / 2),
          y: Math.round(y + height / 2),
          width,
          height,
          label: parts.slice(5).join('|'),
          pinned: /置顶/.test(parts.slice(5).join('|')),
          source: 'ax',
          confidence: 0.62,
        };
      })
      .filter((card) => inGrid(card.x, card.y));
    const badges = lines
      .filter((parts) => parts[0] === 'BADGE')
      .map((parts) => ({ kind: parts[1] || 'pinned', x: Number(parts[2]), y: Number(parts[3]), text: parts[4] || '' }))
      .filter((badge) => Number.isFinite(badge.x) && Number.isFinite(badge.y) && inGrid(badge.x, badge.y));
    return { cards, badges };
  } catch {
    return { cards: [], badges: [] };
  }
}

function mergeCreatorCards(screenshotCards = [], axCards = []) {
  const cards = screenshotCards.map((card) => ({ ...card, label: card.label || '' }));
  for (const ax of axCards) {
    const match = cards.find((card) => Math.abs(card.x - ax.x) <= Math.max(42, card.width / 2) && Math.abs(card.y - ax.y) <= Math.max(42, card.height / 2));
    if (match) {
      match.label = [match.label, ax.label].filter(Boolean).join(' ');
      match.pinned ||= ax.pinned;
      match.blocked ||= /直播|预约/.test(ax.label);
      match.source = `${match.source || 'screenshot'}+ax`;
    } else {
      cards.push(ax);
    }
  }
  return cards;
}

export function applyBadgesToCards(cards = [], badges = []) {
  if (!badges.length) return cards;
  for (const card of cards) {
    const cx = Number(card.x ?? card.centerX);
    const cy = Number(card.y ?? card.centerY);
    const w = Number(card.width || 0);
    const h = Number(card.height || 0);
    if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    for (const badge of badges) {
      const bx = Number(badge.x);
      const by = Number(badge.y);
      if (!Number.isFinite(bx) || !Number.isFinite(by)) continue;
      const inside = bx >= cx - w / 2 - 8 && bx <= cx + w / 2 + 8 && by >= cy - h / 2 - 8 && by <= cy + h / 2 + 8;
      if (!inside) continue;
      if (badge.kind === 'pinned') {
        card.pinned = true;
        if (!/置顶/.test(String(card.label || ''))) card.label = [card.label, '置顶'].filter(Boolean).join(' ');
      } else if (badge.kind === 'blocked') {
        card.blocked = true;
        const tag = badge.text || '直播';
        if (!new RegExp(tag).test(String(card.label || ''))) card.label = [card.label, tag].filter(Boolean).join(' ');
      }
    }
  }
  return cards;
}

async function analyzeCreatorVideoCardsByScreenshot(path, anchors, { runner }) {
  const { window } = anchors;
  const { stdout } = await runWechatSwift('creator-cards', [path, window.x, window.y, window.width, window.height], { runner });
  return JSON.parse(String(stdout || '[]'));
}

async function analyzeCreatorVideoCardsByScreenshotLegacy(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("[]")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)
func pixelX(_ x: Double) -> Int { min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded()))) }
func pixelY(_ y: Double) -> Int { min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded()))) }

let xStart = pixelX(wx + max(170.0, ww * 0.15))
let xEnd = pixelX(wx + ww - 46.0)
let yStart = pixelY(wy + 150.0)
let yEnd = pixelY(wy + wh - 70.0)
let cropW = max(0, xEnd - xStart + 1)
let cropH = max(0, yEnd - yStart + 1)
if cropW <= 0 || cropH <= 0 {
  print("[]")
  exit(0)
}

var rowCounts = Array(repeating: 0, count: cropH)
var rowMinX = Array(repeating: Int.max, count: cropH)
var rowMaxX = Array(repeating: 0, count: cropH)

for cy in 0..<cropH {
  for cx in stride(from: 0, to: cropW, by: 2) {
    let x = xStart + cx
    let y = yStart + cy
    guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
    let r = Double(c.redComponent)
    let g = Double(c.greenComponent)
    let b = Double(c.blueComponent)
    let a = Double(c.alphaComponent)
    let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
    let chroma = max(r, max(g, b)) - min(r, min(g, b))
    if a > 0.7 && (luma < 0.88 || chroma > 0.08) {
      rowCounts[cy] += 1
      rowMinX[cy] = min(rowMinX[cy], x)
      rowMaxX[cy] = max(rowMaxX[cy], x)
    }
  }
}

let threshold = max(24, cropW / 28)
var bands: [(start: Int, end: Int, minX: Int, maxX: Int, pixels: Int)] = []
var start = -1
var end = -1
var minX = Int.max
var maxX = 0
var pixels = 0
var gap = 0
func flush() {
  if start < 0 || end < start { return }
  let hPts = Double(end - start + 1) / max(scaleY, 0.01)
  let wPts = Double(maxX - minX + 1) / max(scaleX, 0.01)
  if hPts >= 70.0 && wPts >= 70.0 && pixels >= 450 {
    bands.append((start, end, minX, maxX, pixels))
  }
}
for i in 0..<cropH {
  if rowCounts[i] >= threshold {
    if start < 0 { start = i }
    end = i
    minX = min(minX, rowMinX[i])
    maxX = max(maxX, rowMaxX[i])
    pixels += rowCounts[i]
    gap = 0
  } else if start >= 0 {
    gap += 1
    if gap > 8 {
      flush()
      start = -1
      end = -1
      minX = Int.max
      maxX = 0
      pixels = 0
      gap = 0
    }
  }
}
flush()

func pinnedScore(minX: Int, maxX: Int, startY: Int, endY: Int) -> Double {
  let w = maxX - minX + 1
  let h = endY - startY + 1
  if w <= 20 || h <= 20 { return 0.0 }
  let px0 = min(width - 1, max(0, maxX - max(22, w / 5)))
  let px1 = min(width - 1, max(0, maxX - 4))
  let py0 = min(height - 1, max(0, startY + Int(Double(h) * 0.58)))
  let py1 = min(height - 1, max(0, endY - 4))
  var bright = 0
  var horizontalRows = 0
  if px0 > px1 || py0 > py1 { return 0.0 }
  for y in py0...py1 {
    var rowBright = 0
    for x in px0...px1 {
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let r = Double(c.redComponent)
      let g = Double(c.greenComponent)
      let b = Double(c.blueComponent)
      let a = Double(c.alphaComponent)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      if a > 0.7 && luma > 0.72 && max(r, max(g, b)) - min(r, min(g, b)) < 0.25 {
        bright += 1
        rowBright += 1
      }
    }
    if rowBright >= max(6, (px1 - px0 + 1) / 3) { horizontalRows += 1 }
  }
  return min(1.0, (Double(bright) / 70.0) + (Double(horizontalRows) / 18.0))
}

var cards: [[String: Any]] = []
for band in bands {
  let hPts = Double(band.end - band.start + 1) / max(scaleY, 0.01)
  let wPts = Double(band.maxX - band.minX + 1) / max(scaleX, 0.01)
  let centerX = Double(bounds.minX) + Double(band.minX + band.maxX) / 2.0 / scaleX
  let centerY = Double(bounds.minY) + Double(yStart + band.start + yStart + band.end) / 2.0 / scaleY
  let pin = pinnedScore(minX: band.minX, maxX: band.maxX, startY: yStart + band.start, endY: yStart + band.end)
  cards.append([
    "x": centerX,
    "y": centerY,
    "width": wPts,
    "height": hPts,
    "confidence": min(0.96, max(0.55, Double(band.pixels) / 1800.0)),
    "pinned": pin >= 0.55,
    "pinScore": pin,
    "source": "screenshot"
  ])
}

cards.sort { a, b in
  let ay = a["y"] as? Double ?? 0
  let by = b["y"] as? Double ?? 0
  if abs(ay - by) > 36 { return ay < by }
  return (a["x"] as? Double ?? 0) < (b["x"] as? Double ?? 0)
}
let json = try! JSONSerialization.data(withJSONObject: cards, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(stdout || '[]'));
}

async function analyzeNextArrowCandidatesByScreenshot(path, anchors, { runner }) {
  const { window } = anchors;
  const { stdout } = await runWechatSwift('next-arrow', [path, window.x, window.y, window.width, window.height], { runner });
  return JSON.parse(String(stdout || '[]'));
}

async function analyzeNextArrowCandidatesByScreenshotLegacy(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("[]")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)
func pixelX(_ x: Double) -> Int { min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded()))) }
func pixelY(_ y: Double) -> Int { min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded()))) }
let xStart = pixelX(wx + ww * 0.70)
let xEnd = pixelX(wx + ww - 24.0)
let yStart = pixelY(wy + wh * 0.30)
let yEnd = pixelY(wy + wh * 0.84)
let cropW = max(0, xEnd - xStart + 1)
let cropH = max(0, yEnd - yStart + 1)
if cropW <= 0 || cropH <= 0 {
  print("[]")
  exit(0)
}

var mask = Array(repeating: false, count: cropW * cropH)
func idx(_ x: Int, _ y: Int) -> Int { y * cropW + x }
for cy in 0..<cropH {
  for cx in 0..<cropW {
    let x = xStart + cx
    let y = yStart + cy
    guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
    let r = Double(c.redComponent)
    let g = Double(c.greenComponent)
    let b = Double(c.blueComponent)
    let a = Double(c.alphaComponent)
    let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
    if a > 0.7 && luma > 0.52 && luma < 0.98 && max(r, max(g, b)) - min(r, min(g, b)) < 0.30 {
      mask[idx(cx, cy)] = true
    }
  }
}

var visited = Array(repeating: false, count: cropW * cropH)
let dirs = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
var candidates: [[String: Any]] = []
for sy in 0..<cropH {
  for sx in 0..<cropW {
    let startIndex = idx(sx, sy)
    if visited[startIndex] || !mask[startIndex] { continue }
    var stack = [(sx, sy)]
    visited[startIndex] = true
    var pixels: [(Int, Int)] = []
    var minX = sx
    var maxX = sx
    var minY = sy
    var maxY = sy
    while let (px, py) = stack.popLast() {
      pixels.append((px, py))
      minX = min(minX, px)
      maxX = max(maxX, px)
      minY = min(minY, py)
      maxY = max(maxY, py)
      for (dx, dy) in dirs {
        let nx = px + dx
        let ny = py + dy
        if nx < 0 || ny < 0 || nx >= cropW || ny >= cropH { continue }
        let ni = idx(nx, ny)
        if visited[ni] || !mask[ni] { continue }
        visited[ni] = true
        stack.append((nx, ny))
      }
    }
    let count = pixels.count
    if count < 12 { continue }
    let boxW = maxX - minX + 1
    let boxH = maxY - minY + 1
    let wPts = Double(boxW) / max(scaleX, 0.01)
    let hPts = Double(boxH) / max(scaleY, 0.01)
    if wPts < 8.0 || wPts > 72.0 || hPts < 8.0 || hPts > 72.0 { continue }
    var lower = 0
    var upper = 0
    for (_, py) in pixels {
      if py > minY + boxH / 2 { lower += 1 } else { upper += 1 }
    }
    let lowerRatio = Double(lower) / Double(max(count, 1))
    let direction = lowerRatio >= 0.47 ? "down" : "up"
    let density = Double(count) / Double(max(1, boxW * boxH))
    let score = min(0.95, max(0.0, density + min(wPts, hPts) / 80.0 + (direction == "down" ? 0.08 : 0.0)))
    candidates.append([
      "x": Double(bounds.minX) + Double(xStart + minX + boxW / 2) / scaleX,
      "y": Double(bounds.minY) + Double(yStart + minY + boxH / 2) / scaleY,
      "width": wPts,
      "height": hPts,
      "score": score,
      "direction": direction
    ])
  }
}
let json = try! JSONSerialization.data(withJSONObject: candidates, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(stdout || '[]'));
}

async function captureWechatWindowFingerprint({ runner, anchors }) {
  let screenshot = null;
  try {
    screenshot = await captureSystemFullScreenshot({ runner });
    if (!screenshot.ok) return { ok: false, signature: '' };
    const signature = await screenshotWindowFingerprint(screenshot.path, anchors, { runner });
    return { ok: true, signature };
  } catch {
    return { ok: false, signature: '' };
  } finally {
    cleanupCapturedScreenshot(screenshot);
  }
}

async function screenshotWindowFingerprint(path, anchors, { runner }) {
  const { window } = anchors;
  const { stdout } = await runWechatSwift('fingerprint', [path, window.x, window.y, window.width, window.height], { runner });
  return String(stdout || '').trim();
}

async function screenshotWindowFingerprintLegacy(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("")
  exit(0)
}
let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)
func pixelX(_ x: Double) -> Int { min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded()))) }
func pixelY(_ y: Double) -> Int { min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded()))) }
let gx = 7
let gy = 7
var parts: [String] = []
for yy in 0..<gy {
  for xx in 0..<gx {
    let x0 = pixelX(wx + ww * (0.18 + 0.68 * Double(xx) / Double(gx)))
    let x1 = pixelX(wx + ww * (0.18 + 0.68 * Double(xx + 1) / Double(gx)))
    let y0 = pixelY(wy + wh * (0.16 + 0.70 * Double(yy) / Double(gy)))
    let y1 = pixelY(wy + wh * (0.16 + 0.70 * Double(yy + 1) / Double(gy)))
    var total = 0.0
    var count = 0.0
    if x0 <= x1 && y0 <= y1 {
      for y in stride(from: y0, through: y1, by: 4) {
        for x in stride(from: x0, through: x1, by: 4) {
          guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
          let luma = (0.2126 * Double(c.redComponent)) + (0.7152 * Double(c.greenComponent)) + (0.0722 * Double(c.blueComponent))
          total += luma
          count += 1
        }
      }
    }
    parts.append(String(Int(((total / max(count, 1.0)) * 9.0).rounded())))
  }
}
print(parts.joined())
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return String(stdout || '').trim();
}

function fingerprintChanged(before, after) {
  const a = String(before?.signature || '');
  const b = String(after?.signature || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff += 1;
  return diff >= Math.max(3, Math.floor(a.length * 0.08));
}

async function clickAndVerify(location, { runner }) {
  try {
    await clickAt(location.x, location.y, { runner });
  } catch (e) {
    return {
      ok: false,
      code: 'main_channels_entry',
      method: location.method,
      message: `定位点点击失败 ${location.x},${location.y}: ${String(e.stderr || e.message || e)}`,
    };
  }
  await sleep(1200);
  const verified = await verifyChannelsVisible({ runner, location });
  if (verified.ok) {
    return {
      ok: true,
      code: 'open_channels_from_main',
      method: location.method,
      detail: `已通过${location.method}进入视频号；点击=${location.x},${location.y}；confidence=${location.confidence}; ${location.diagnostics || ''}; ${verified.detail || ''}`,
    };
  }
  return {
    ok: false,
    code: 'main_channels_entry',
    method: location.method,
    message: `已点击${location.method}定位点 ${location.x},${location.y}，但没有验证为视频号界面；${location.diagnostics || ''}；${verified.message || ''}`,
  };
}

async function clickAt(x, y, { runner }) {
  await runWechatSwift('click', [Math.round(x), Math.round(y)], { runner, timeout: 8_000 });
}

async function clickAtLegacy(x, y, { runner }) {
  const script = `
import CoreGraphics
import Darwin
import Foundation

guard CommandLine.arguments.count >= 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
  exit(2)
}

let source = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType) {
  let point = CGPoint(x: x, y: y)
  guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
  event.post(tap: .cghidEventTap)
}
post(.mouseMoved)
usleep(80_000)
post(.leftMouseDown)
usleep(90_000)
post(.leftMouseUp)
`;
  await runner('swift', ['-e', script, String(Math.round(x)), String(Math.round(y))], { timeout: 8_000 });
}

async function scrollAt(x, y, deltaY, { runner }) {
  await runWechatSwift('scroll', [Math.round(x), Math.round(y), Math.round(deltaY)], { runner, timeout: 8_000 });
}

async function scrollAtLegacy(x, y, deltaY, { runner }) {
  const script = `
import CoreGraphics
import Darwin
import Foundation

guard CommandLine.arguments.count >= 4,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]),
      let deltaY = Int32(CommandLine.arguments[3]) else {
  exit(2)
}

let source = CGEventSource(stateID: .hidSystemState)
let point = CGPoint(x: x, y: y)
if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
  move.post(tap: .cghidEventTap)
}
usleep(80_000)
if let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: deltaY, wheel2: 0, wheel3: 0) {
  event.post(tap: .cghidEventTap)
}
usleep(120_000)
`;
  await runner('swift', ['-e', script, String(Math.round(x)), String(Math.round(y)), String(Math.round(deltaY))], { timeout: 8_000 });
}

async function mouseWiggle(x, y, { runner }) {
  await runWechatSwift('wiggle', [Math.round(x), Math.round(y)], { runner, timeout: 8_000 });
}

async function mouseWiggleLegacy(x, y, { runner }) {
  const script = `
import CoreGraphics
import Darwin
import Foundation

guard CommandLine.arguments.count >= 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
  exit(2)
}

let source = CGEventSource(stateID: .hidSystemState)
for dx in [-18.0, 18.0, -10.0, 10.0, 0.0] {
  let point = CGPoint(x: x + dx, y: y)
  if let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
    event.post(tap: .cghidEventTap)
  }
  usleep(70_000)
}
`;
  await runner('swift', ['-e', script, String(Math.round(x)), String(Math.round(y))], { timeout: 8_000 });
}

async function commandW({ runner }) {
  const script = `
on run
  tell application "System Events"
    keystroke "w" using command down
  end tell
end run
`;
  await runner('osascript', ['-e', script], { timeout: 8_000 });
}

async function moveTo(x, y, { runner }) {
  await runWechatSwift('move', [Math.round(x), Math.round(y)], { runner, timeout: 8_000 });
}

async function moveToLegacy(x, y, { runner }) {
  const script = `
import CoreGraphics
import Darwin
import Foundation

guard CommandLine.arguments.count >= 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
  exit(2)
}

let source = CGEventSource(stateID: .hidSystemState)
let point = CGPoint(x: x, y: y)
if let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
  event.post(tap: .cghidEventTap)
}
usleep(180_000)
`;
  await runner('swift', ['-e', script, String(Math.round(x)), String(Math.round(y))], { timeout: 8_000 });
}

async function verifyChannelsVisible({ runner, location }) {
  const full = await verifyChannelsVisibleByFullSystemScreenshot({ runner });
  if (full.ok) return full;

  const selected = await verifyChannelsSelectedBySystemScreenshot(location, { runner });
  if (selected.ok) return selected;

  const script = `
on run
  tell application "System Events"
    repeat with bid in {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
      try
        set p to first process whose bundle identifier is bid
        if (count of windows of p) > 0 then
          set bidText to bundle identifier of p as text
          if bidText is "com.tencent.flue.WeChatAppEx" then return "OK|channels_window|发现视频号独立窗口"
          set dumpText to my vbp_visible_text_dump(p)
          if dumpText contains "视频号" or dumpText contains "赞和收藏" or dumpText contains "我的视频号" or (dumpText contains "直播" and dumpText contains "朋友" and dumpText contains "推荐") then return "OK|wechat_main|微信窗口文本包含视频号信号"
        end if
      end try
    end repeat
  end tell
  return "ERR|没有发现视频号窗口或文本信号"
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
        if length of out > 3000 then exit repeat
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
    const { stdout } = await runner('osascript', ['-e', script], { timeout: 8_000 });
    const text = String(stdout || '').trim();
    if (text.startsWith('OK|')) return { ok: true, detail: text.split('|').slice(1).join('|') };
    return { ok: false, message: text || '视频号验证无结果' };
  } catch (e) {
    return { ok: false, message: String(e.stderr || e.message || e) };
  }
}

async function verifyChannelsVisibleByFullSystemScreenshot({ runner, anchors: providedAnchors } = {}) {
  let screenshot = null;
  try {
    const anchors = providedAnchors?.ok ? providedAnchors : await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
    if (!anchors.ok) return { ok: false, method: 'system_screenshot_full_channels_window', message: anchors.reason || '无法读取微信窗口锚点' };
    screenshot = await captureSystemFullScreenshot({ runner });
    if (!screenshot.ok) return { ok: false, method: 'system_screenshot_full_channels_window', message: screenshot.reason || '无法截取系统全屏截图' };
    const analyzed = await analyzeChannelsWindowFullScreenshot(screenshot.path, anchors, { runner });
    if (analyzed.ok) {
      return {
        ok: true,
        method: 'system_screenshot_full_channels_window',
        detail: `${analyzed.detail}; ${screenshot.diagnostics}`,
      };
    }
    const lightPage = await analyzeChannelsLightPageFullScreenshot(screenshot.path, anchors, { runner });
    if (lightPage.ok) {
      if (channelsLightPageNeedsRailConfirmation(anchors)) {
        const railSelected = await confirmChannelsLeftRailSelectedByScreenshot({ runner, anchors });
        if (!railSelected.ok) {
          return {
            ok: false,
            method: 'system_screenshot_full_channels_window',
            message: [`亮色页颜色指标命中，但主微信窗口缺少视频号左栏选中确认`, lightPage.detail, railSelected.reason].filter(Boolean).join('；'),
          };
        }
        return {
          ok: true,
          method: 'system_screenshot_full_channels_window',
          detail: `${lightPage.detail}; ${railSelected.detail}; ${screenshot.diagnostics}`,
        };
      }
      return {
        ok: true,
        method: 'system_screenshot_full_channels_window',
        detail: `${lightPage.detail}; ${screenshot.diagnostics}`,
      };
    }
    return { ok: false, method: 'system_screenshot_full_channels_window', message: [analyzed.reason || analyzed.detail, lightPage.reason || lightPage.detail].filter(Boolean).join('；') || '全屏截图未确认视频号界面' };
  } catch (e) {
    return { ok: false, method: 'system_screenshot_full_channels_window', message: String(e.message || e) };
  } finally {
    cleanupCapturedScreenshot(screenshot);
  }
}

async function confirmChannelsLeftRailSelectedByScreenshot({ runner, anchors }) {
  let rail = null;
  try {
    rail = await captureWechatLeftRail(anchors, { runner });
    if (!rail.ok) return { ok: false, reason: rail.reason || '无法截取微信左侧栏' };

    const alreadyVisible = await analyzeChannelsAlreadyVisible(rail.path, rail.region, { runner });
    if (alreadyVisible.ok) {
      return {
        ok: true,
        detail: `left_rail_channels_visible ${alreadyVisible.detail}; ${rail.diagnostics}`,
      };
    }

    const codeLocated = await locateChannelsIconByCode({ anchors, rail });
    if (codeLocated.ok && codeLocated.confidence >= CODE_CONFIDENCE_THRESHOLD) {
      const selected = await analyzeChannelsSelectedRail(rail.path, rail.region, codeLocated, { runner });
      if (selected.ok) {
        return {
          ok: true,
          detail: `left_rail_channels_selected ${selected.detail}; ${codeLocated.diagnostics}; ${rail.diagnostics}`,
        };
      }
      return {
        ok: false,
        reason: [selected.reason, codeLocated.diagnostics, rail.diagnostics].filter(Boolean).join('；'),
      };
    }

    return {
      ok: false,
      reason: [alreadyVisible.reason, codeLocated.diagnostics || codeLocated.reason, rail.diagnostics].filter(Boolean).join('；') || '未确认视频号左栏选中',
    };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally {
    cleanupCapturedRail(rail);
  }
}

async function verifyChannelsSelectedBySystemScreenshot(location, { runner }) {
  if (!Number.isFinite(Number(location?.x)) || !Number.isFinite(Number(location?.y))) {
    return { ok: false, message: '缺少点击点，无法做左栏选中态验证' };
  }
  let rail = null;
  try {
    const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
    if (!anchors.ok) return { ok: false, message: anchors.reason || '无法读取微信窗口锚点' };
    rail = await captureWechatLeftRail(anchors, { runner });
    if (!rail.ok) return { ok: false, message: rail.reason || '无法截取微信左侧栏' };
    const alreadyVisible = await analyzeChannelsAlreadyVisible(rail.path, rail.region, { runner });
    if (alreadyVisible.ok) {
      return {
        ok: true,
        detail: `system_screenshot_already_channels|${alreadyVisible.detail}`,
      };
    }
    const selected = await analyzeChannelsSelectedRail(rail.path, rail.region, location, { runner });
    if (selected.ok) {
      return {
        ok: true,
        detail: `system_left_rail_selected|${selected.detail}`,
      };
    }
    return { ok: false, message: selected.reason || selected.detail || '左栏未显示视频号选中态' };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  } finally {
    cleanupCapturedRail(rail);
  }
}

async function analyzeChannelsWindowFullScreenshot(path, anchors, { runner }) {
  const { window } = anchors;
  const { stdout } = await runWechatSwift('channels-window', [path, window.x, window.y, window.width, window.height], { runner });
  const parsed = JSON.parse(String(stdout || '{}'));
  const reason = validateChannelsWindowFullScreenshotMetrics(parsed);
  const detail = `full_window black=${Number(parsed.bodyBlackRatio || 0).toFixed(3)} dark=${Number(parsed.bodyDarkRatio || 0).toFixed(3)} bright=${Number(parsed.bodyBrightRatio || 0).toFixed(3)} mid=${Number(parsed.bodyMidRatio || 0).toFixed(3)} rect=${parsed.sampleRect || ''} scale=${Number(parsed.scaleX || 0).toFixed(2)}x${Number(parsed.scaleY || 0).toFixed(2)}`;
  if (!reason) return { ok: true, detail };
  return { ok: false, reason: `${reason}; ${detail}` };
}

async function analyzeChannelsWindowFullScreenshotLegacy(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("{\\"ok\\":false,\\"reason\\":\\"无法读取系统全屏截图\\"}")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)

func pixelX(_ x: Double) -> Int {
  return min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded())))
}

func pixelY(_ y: Double) -> Int {
  return min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded())))
}

let xStart = pixelX(wx + ww * 0.04)
let xEnd = pixelX(wx + ww * 0.96)
let yStart = pixelY(wy + 82.0)
let yEnd = pixelY(wy + wh - 95.0)
var total = 0
var black = 0
var dark = 0
var bright = 0
var mid = 0

if xStart <= xEnd && yStart <= yEnd {
  for y in stride(from: yStart, through: yEnd, by: 3) {
    for x in stride(from: xStart, through: xEnd, by: 3) {
      total += 1
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let r = Double(c.redComponent)
      let g = Double(c.greenComponent)
      let b = Double(c.blueComponent)
      let a = Double(c.alphaComponent)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      if a > 0.7 && luma < 0.05 { black += 1 }
      if a > 0.7 && luma < 0.16 { dark += 1 }
      if a > 0.7 && luma > 0.78 { bright += 1 }
      if a > 0.7 && luma > 0.22 && luma < 0.72 { mid += 1 }
    }
  }
}

let totalD = max(Double(total), 1.0)
let out: [String: Any] = [
  "bodyTotal": total,
  "bodyBlackRatio": Double(black) / totalD,
  "bodyDarkRatio": Double(dark) / totalD,
  "bodyBrightRatio": Double(bright) / totalD,
  "bodyMidRatio": Double(mid) / totalD,
  "scaleX": scaleX,
  "scaleY": scaleY,
  "sampleRect": String(xStart) + "," + String(yStart) + "," + String(xEnd - xStart) + "," + String(yEnd - yStart)
]
let json = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '{}'));
  const reason = validateChannelsWindowFullScreenshotMetrics(parsed);
  const detail = `full_window black=${Number(parsed.bodyBlackRatio || 0).toFixed(3)} dark=${Number(parsed.bodyDarkRatio || 0).toFixed(3)} bright=${Number(parsed.bodyBrightRatio || 0).toFixed(3)} mid=${Number(parsed.bodyMidRatio || 0).toFixed(3)} rect=${parsed.sampleRect || ''} scale=${Number(parsed.scaleX || 0).toFixed(2)}x${Number(parsed.scaleY || 0).toFixed(2)}`;
  if (!reason) return { ok: true, detail };
  return { ok: false, reason: `${reason}; ${detail}` };
}

export async function analyzeChannelsLightPageFullScreenshot(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("{\\"topTotal\\":0,\\"topOrangePixels\\":0,\\"topOrangeClusters\\":0,\\"bodyTotal\\":0,\\"bodyBrightRatio\\":0,\\"bodyDarkRatio\\":1}")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)

func pixelX(_ x: Double) -> Int {
  return min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded())))
}

func pixelY(_ y: Double) -> Int {
  return min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded())))
}

let topX0 = pixelX(wx + max(78.0, ww * 0.06))
let topX1 = pixelX(wx + ww - max(80.0, ww * 0.08))
let topY0 = pixelY(wy + 8.0)
let topY1 = pixelY(wy + 72.0)
var topTotal = 0
var topOrange = 0
var orangeColumns = Set<Int>()

if topX0 <= topX1 && topY0 <= topY1 {
  for y in stride(from: topY0, through: topY1, by: 2) {
    for x in stride(from: topX0, through: topX1, by: 2) {
      topTotal += 1
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let r = Double(c.redComponent)
      let g = Double(c.greenComponent)
      let b = Double(c.blueComponent)
      let a = Double(c.alphaComponent)
      let orange = a > 0.55 && r > 0.68 && g > 0.24 && g < 0.86 && b < 0.62 && r > b + 0.18 && g > b + 0.02
      if orange {
        topOrange += 1
        orangeColumns.insert(x / max(1, Int(scaleX * 12.0)))
      }
    }
  }
}

let sortedCols = orangeColumns.sorted()
var clusters = 0
var previous: Int? = nil
for col in sortedCols {
  if previous == nil || col - previous! > 1 { clusters += 1 }
  previous = col
}

let bodyX0 = pixelX(wx + ww * 0.04)
let bodyX1 = pixelX(wx + ww * 0.96)
let bodyY0 = pixelY(wy + 86.0)
let bodyY1 = pixelY(wy + wh - 84.0)
var bodyTotal = 0
var bright = 0
var dark = 0

if bodyX0 <= bodyX1 && bodyY0 <= bodyY1 {
  for y in stride(from: bodyY0, through: bodyY1, by: 5) {
    for x in stride(from: bodyX0, through: bodyX1, by: 5) {
      bodyTotal += 1
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let luma = (0.2126 * Double(c.redComponent)) + (0.7152 * Double(c.greenComponent)) + (0.0722 * Double(c.blueComponent))
      if Double(c.alphaComponent) > 0.7 && luma > 0.78 { bright += 1 }
      if Double(c.alphaComponent) > 0.7 && luma < 0.16 { dark += 1 }
    }
  }
}

let out: [String: Any] = [
  "topTotal": topTotal,
  "topOrangePixels": topOrange,
  "topOrangeClusters": clusters,
  "bodyTotal": bodyTotal,
  "bodyBrightRatio": Double(bright) / max(Double(bodyTotal), 1.0),
  "bodyDarkRatio": Double(dark) / max(Double(bodyTotal), 1.0)
]
let json = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '{}'));
  const reason = validateChannelsLightPageScreenshotMetrics(parsed);
  const topTotal = Number(parsed.topTotal || 0);
  const topOrangePixels = Number(parsed.topOrangePixels || 0);
  const topOrangeClusters = Number(parsed.topOrangeClusters || 0);
  const bodyBrightRatio = Number(parsed.bodyBrightRatio || 0);
  const bodyDarkRatio = Number(parsed.bodyDarkRatio || 0);
  const detail = `light_page topOrange=${topOrangePixels} clusters=${topOrangeClusters} ratio=${(topOrangePixels / Math.max(topTotal, 1)).toFixed(4)} bright=${bodyBrightRatio.toFixed(3)} dark=${bodyDarkRatio.toFixed(3)}`;
  if (!reason) return { ok: true, detail };
  return { ok: false, reason: `${reason}; ${detail}` };
}

async function returnFromVideoDetailIfNeeded(anchors, { runner }) {
  let current = anchors;
  const details = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    let rail = null;
    try {
      rail = await captureWechatLeftRail(current, { runner });
      if (!rail.ok) {
        details.push(`第${attempt}次详情页检测无法截图: ${rail.reason || ''}`);
        break;
      }
      const visible = await analyzeChannelsAlreadyVisible(rail.path, rail.region, { runner });
      if (!visible.ok) break;
      const point = videoDetailBackPointFromAnchors(current);
      await clickAt(point.x, point.y, { runner });
      await sleep(900);
      details.push(`第${attempt}次从视频详情页点击返回 ${point.x},${point.y}: ${visible.detail}`);
      const refreshed = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
      if (refreshed.ok) current = refreshed;
    } finally {
      cleanupCapturedRail(rail);
    }
  }
  return { anchors: current, detail: details.join('；') };
}

function videoDetailBackPointFromAnchors(anchors) {
  const { window } = anchors;
  return {
    x: Math.round(window.x + 95),
    y: Math.round(window.y + 40),
  };
}

async function verifyProfileOrOverviewVisible({ runner }) {
  const ax = await readWechatSignalsByAX({ runner });
  if (ax.ok && /赞和收藏|我的视频号|个人中心|个人主页|浏览记录|关注/.test(ax.text)) {
    return { ok: true, detail: `AX确认个人/总览信号: ${compactForLog(ax.text)}` };
  }

  const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
  if (!anchors.ok) return { ok: false, reason: [ax.reason, anchors.reason].filter(Boolean).join('；') || '未确认个人/总览页' };
  const sidebar = await findFollowingSidebarPointByScreenshot({ runner, anchors });
  if (sidebar.ok) {
    return { ok: true, detail: `system_screenshot_profile_overview ${sidebar.detail}` };
  }
  return { ok: false, reason: [ax.reason, sidebar.reason, anchors.diagnostics].filter(Boolean).join('；') || '未确认个人/总览页' };
}

async function verifyFollowingOverviewVisible({ runner, point }) {
  const ax = await readWechatSignalsByAX({ runner });
  if (ax.ok && /关注/.test(ax.text) && !/顶部视频流关注误点/.test(ax.text)) {
    return { ok: true, detail: `AX确认关注入口/总览信号: ${compactForLog(ax.text)}` };
  }
  const screenshot = await analyzeCurrentWechatWindowByScreenshot({ runner });
  if (screenshot.ok && !screenshot.videoDetail) {
    return { ok: true, detail: `system_screenshot_following_overview point=${point?.x},${point?.y} ${screenshot.detail}` };
  }
  return { ok: false, reason: [ax.reason, screenshot.reason || screenshot.detail].filter(Boolean).join('；') || '未确认关注总览' };
}

async function readWechatSignalsByAX({ runner }) {
  const script = `
on run
  tell application "System Events"
    repeat with bid in {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
      try
        set p to first process whose bundle identifier is bid
        if (count of windows of p) > 0 then
          set dumpText to my vbp_visible_text_dump(p)
          if dumpText is not "" then return "OK|" & dumpText
        end if
      end try
    end repeat
  end tell
  return "ERR|没有可读文本"
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
        if length of out > 4000 then exit repeat
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
    const { stdout } = await runner('osascript', ['-e', script], { timeout: 8_000 });
    const text = String(stdout || '').trim();
    if (text.startsWith('OK|')) return { ok: true, text: text.slice(3) };
    return { ok: false, reason: text || 'AX 无输出' };
  } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message || e) };
  }
}

async function analyzeCurrentWechatWindowByScreenshot({ runner }) {
  let rail = null;
  try {
    const anchors = await getWechatTrafficLightAnchors({ runner, preferChannelsWindow: true, includeContentCount: false });
    if (!anchors.ok) return { ok: false, reason: anchors.reason || '无法读取微信窗口红黄绿按钮' };
    rail = await captureWechatLeftRail(anchors, { runner });
    if (!rail.ok) return { ok: false, reason: rail.reason || '无法截取微信左侧栏' };
    const detail = await analyzeChannelsAlreadyVisible(rail.path, rail.region, { runner });
    return {
      ok: true,
      videoDetail: detail.ok,
      detail: detail.ok ? detail.detail : (detail.reason || 'system_screenshot_non_video_detail'),
    };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally {
    cleanupCapturedRail(rail);
  }
}

async function findAutoplayTabClosePlanByAX({ runner, keepTabTitle }) {
  const script = `
on run
  tell application "System Events"
    repeat with bid in {"com.tencent.flue.WeChatAppEx", "com.tencent.xinWeChat"}
      try
        set p to first process whose bundle identifier is bid
        if (count of windows of p) > 0 then
          set w to window 1 of p
          set wp to position of w
          set ws to size of w
          set keepX to -1
          set keepY to -1
          repeat with el in entire contents of p
            set label to my vbp_text(el)
            if label contains ${JSON.stringify(keepTabTitle)} then
              try
                set ep to position of el
                set es to size of el
                if (item 2 of ep) < (item 2 of wp) + 96 then
                  set keepX to (item 1 of ep) + ((item 1 of es) / 2)
                  set keepY to (item 2 of ep) + ((item 2 of es) / 2)
                  exit repeat
                end if
              end try
            end if
          end repeat
          if keepX < 0 then return "ERR|未找到关注标签页"
          set hoverX to keepX - 96
          set hoverY to keepY
          if hoverX < (item 1 of wp) + 100 then return "NOOP|关注左侧没有可关闭标签"
          return "OK|" & (hoverX as text) & "|" & (hoverY as text) & "|" & ((hoverX + 42) as text) & "|" & ((hoverY - 1) as text) & "|AX 找到关注标签并计算左侧标签关闭点"
        end if
      end try
    end repeat
  end tell
  return "ERR|没有可读窗口"
end run

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
    const { stdout } = await runner('osascript', ['-e', script], { timeout: 8_000 });
    const text = String(stdout || '').trim();
    if (text.startsWith('NOOP|')) return { ok: true, noop: true, detail: text.slice(5) };
    if (!text.startsWith('OK|')) return { ok: false, reason: text || 'AX 未找到标签关闭点' };
    const [, hoverX, hoverY, closeX, closeY, detail] = text.split('|');
    return {
      ok: true,
      hoverX: Number(hoverX),
      hoverY: Number(hoverY),
      closeX: Number(closeX),
      closeY: Number(closeY),
      detail,
    };
  } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message || e) };
  }
}

async function findFollowingSidebarPointByScreenshot({ runner, anchors }) {
  let screenshot = null;
  try {
    screenshot = await captureSystemFullScreenshot({ runner });
    if (!screenshot.ok) return { ok: false, reason: screenshot.reason || '无法截取系统全屏截图' };
    const rows = await analyzeFollowingSidebarRowsByScreenshot(screenshot.path, anchors, { runner });
    const picked = chooseFollowingSidebarPointFromRows(rows, anchors);
    if (picked.ok) {
      picked.detail = `${picked.detail}; ${screenshot.diagnostics}`;
      return picked;
    }
    return picked;
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally {
    cleanupCapturedScreenshot(screenshot);
  }
}

async function findAutoplayTabClosePlanByScreenshot({ runner, anchors }) {
  let screenshot = null;
  try {
    screenshot = await captureSystemFullScreenshot({ runner });
    if (!screenshot.ok) return { ok: false, reason: screenshot.reason || '无法截取系统全屏截图' };
    const candidates = await analyzeTopTabCloseCandidatesByScreenshot(screenshot.path, anchors, { runner });
    const picked = chooseAutoplayClosePlanFromCandidates(candidates, anchors);
    if (picked.ok && !picked.noop) {
      picked.detail = `${picked.detail}; ${screenshot.diagnostics}`;
    }
    return picked;
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally {
    cleanupCapturedScreenshot(screenshot);
  }
}

async function analyzeFollowingSidebarRowsByScreenshot(path, anchors, { runner }) {
  const { window } = anchors;
  const { stdout } = await runWechatSwift('sidebar-rows', [path, window.x, window.y, window.width, window.height], { runner });
  return JSON.parse(String(stdout || '[]'));
}

async function analyzeFollowingSidebarRowsByScreenshotLegacy(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("[]")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)

func pixelX(_ x: Double) -> Int {
  return min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded())))
}

func pixelY(_ y: Double) -> Int {
  return min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded())))
}

let xStart = pixelX(wx + 18.0)
let xEnd = pixelX(wx + 150.0)
let yStart = pixelY(wy + 62.0)
let yEnd = pixelY(wy + min(430.0, max(300.0, wh * 0.62)))
let rowCount = max(0, yEnd - yStart + 1)
var counts = Array(repeating: 0, count: rowCount)
var minXs = Array(repeating: Int.max, count: rowCount)
var maxXs = Array(repeating: 0, count: rowCount)
var sumXs = Array(repeating: 0.0, count: rowCount)

if xStart <= xEnd && yStart <= yEnd {
  for y in yStart...yEnd {
    let row = y - yStart
    for x in xStart...xEnd {
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let r = Double(c.redComponent)
      let g = Double(c.greenComponent)
      let b = Double(c.blueComponent)
      let a = Double(c.alphaComponent)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      if a > 0.7 && luma < 0.82 && max(r, max(g, b)) < 0.90 {
        counts[row] += 1
        minXs[row] = min(minXs[row], x)
        maxXs[row] = max(maxXs[row], x)
        sumXs[row] += Double(x)
      }
    }
  }
}

let threshold = max(5, Int(Double(max(1, xEnd - xStart + 1)) * 0.012))
let maxGap = max(3, Int((6.0 * scaleY).rounded()))
var rows: [[String: Any]] = []
var start = -1
var end = -1
var gap = 0

func flushSegment() {
  if start < 0 || end < start { return }
  var total = 0
  var weightedY = 0.0
  var weightedX = 0.0
  var minX = Int.max
  var maxX = 0
  for i in start...end {
    total += counts[i]
    weightedY += Double(yStart + i) * Double(counts[i])
    weightedX += sumXs[i]
    if counts[i] > 0 {
      minX = min(minX, minXs[i])
      maxX = max(maxX, maxXs[i])
    }
  }
  if total <= 0 { return }
  let heightPts = Double(end - start + 1) / max(scaleY, 0.01)
  let widthPts = Double(maxX - minX + 1) / max(scaleX, 0.01)
  if heightPts >= 8.0 && heightPts <= 36.0 && widthPts >= 18.0 && total >= 40 {
    rows.append([
      "centerX": Double(bounds.minX) + (weightedX / Double(total)) / scaleX,
      "centerY": Double(bounds.minY) + (weightedY / Double(total)) / scaleY,
      "width": widthPts,
      "height": heightPts,
      "darkPixels": total
    ])
  }
}

for i in 0..<rowCount {
  if counts[i] > threshold {
    if start < 0 { start = i }
    end = i
    gap = 0
  } else if start >= 0 {
    gap += 1
    if gap > maxGap {
      flushSegment()
      start = -1
      end = -1
      gap = 0
    }
  }
}
flushSegment()

let json = try! JSONSerialization.data(withJSONObject: rows, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(stdout || '[]'));
}

async function analyzeFindHighlightRectsByScreenshot(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("[]")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)
func pixelX(_ x: Double) -> Int { min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded()))) }
func pixelY(_ y: Double) -> Int { min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded()))) }
func pointX(_ x: Double) -> Double { Double(bounds.minX) + x / max(scaleX, 0.01) }
func pointY(_ y: Double) -> Double { Double(bounds.minY) + y / max(scaleY, 0.01) }

let xStart = pixelX(wx + 175.0)
let xEnd = pixelX(wx + ww - 82.0)
let yStart = pixelY(wy + 112.0)
let yEnd = pixelY(wy + wh - 34.0)
let cropW = max(0, xEnd - xStart + 1)
let cropH = max(0, yEnd - yStart + 1)
if cropW <= 0 || cropH <= 0 {
  print("[]")
  exit(0)
}

var rowCounts = Array(repeating: 0, count: cropH)
var rowMinX = Array(repeating: Int.max, count: cropH)
var rowMaxX = Array(repeating: 0, count: cropH)
var rowPixels = Array(repeating: 0, count: cropH)

for cy in 0..<cropH {
  let y = yStart + cy
  for x in xStart...xEnd {
    guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
    let r = Double(c.redComponent)
    let g = Double(c.greenComponent)
    let b = Double(c.blueComponent)
    let a = Double(c.alphaComponent)
    if a > 0.72 && r > 0.85 && g > 0.34 && g < 0.78 && b < 0.28 && (r - g) > 0.13 {
      rowCounts[cy] += 1
      rowPixels[cy] += 1
      rowMinX[cy] = min(rowMinX[cy], x)
      rowMaxX[cy] = max(rowMaxX[cy], x)
    }
  }
}

let threshold = max(5, Int((18.0 * scaleX).rounded()))
let maxGap = max(2, Int((2.0 * scaleY).rounded()))
var rects: [[String: Any]] = []
var start = -1
var end = -1
var minX = Int.max
var maxX = 0
var pixels = 0
var gap = 0

func flush() {
  if start < 0 || end < start { return }
  let hPts = Double(end - start + 1) / max(scaleY, 0.01)
  let wPts = Double(maxX - minX + 1) / max(scaleX, 0.01)
  if hPts >= 8.0 && hPts <= 42.0 && wPts >= 18.0 && wPts <= 220.0 && pixels >= 40 {
    rects.append([
      "x": pointX(Double(minX)),
      "y": pointY(Double(yStart + start)),
      "width": wPts,
      "height": hPts,
      "pixels": pixels
    ])
  }
}

for i in 0..<cropH {
  if rowCounts[i] >= threshold {
    if start < 0 { start = i }
    end = i
    minX = min(minX, rowMinX[i])
    maxX = max(maxX, rowMaxX[i])
    pixels += rowPixels[i]
    gap = 0
  } else if start >= 0 {
    gap += 1
    if gap > maxGap {
      flush()
      start = -1
      end = -1
      minX = Int.max
      maxX = 0
      pixels = 0
      gap = 0
    }
  }
}
flush()

let json = try! JSONSerialization.data(withJSONObject: rects, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(stdout || '[]'));
}

async function analyzeTopTabCloseCandidatesByScreenshot(path, anchors, { runner }) {
  const { window } = anchors;
  const { stdout } = await runWechatSwift('tab-close', [path, window.x, window.y, window.width, window.height], { runner });
  return JSON.parse(String(stdout || '[]'));
}

async function analyzeTopTabCloseCandidatesByScreenshotLegacy(path, anchors, { runner }) {
  const { window } = anchors;
  const swift = `
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 6,
      let wx = Double(args[2]),
      let wy = Double(args[3]),
      let ww = Double(args[4]),
      let wh = Double(args[5]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("[]")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let bounds = CGDisplayBounds(CGMainDisplayID())
let scaleX = Double(width) / max(Double(bounds.width), 1.0)
let scaleY = Double(height) / max(Double(bounds.height), 1.0)

func pixelX(_ x: Double) -> Int {
  return min(width - 1, max(0, Int(((x - Double(bounds.minX)) * scaleX).rounded())))
}

func pixelY(_ y: Double) -> Int {
  return min(height - 1, max(0, Int(((y - Double(bounds.minY)) * scaleY).rounded())))
}

let xStart = pixelX(wx + min(250.0, ww * 0.20))
let xEnd = pixelX(wx + min(ww - 120.0, ww * 0.82))
let yStart = pixelY(wy + 15.0)
let yEnd = pixelY(wy + 72.0)
let cropWidth = max(0, xEnd - xStart + 1)
let cropHeight = max(0, yEnd - yStart + 1)
if cropWidth <= 0 || cropHeight <= 0 {
  print("[]")
  exit(0)
}

var mask = Array(repeating: false, count: cropWidth * cropHeight)
func idx(_ x: Int, _ y: Int) -> Int { return y * cropWidth + x }

for cy in 0..<cropHeight {
  for cx in 0..<cropWidth {
    let x = xStart + cx
    let y = yStart + cy
    guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
    let r = Double(c.redComponent)
    let g = Double(c.greenComponent)
    let b = Double(c.blueComponent)
    let a = Double(c.alphaComponent)
    let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
    if a > 0.7 && luma < 0.48 && max(r, max(g, b)) < 0.65 {
      mask[idx(cx, cy)] = true
    }
  }
}

var visited = Array(repeating: false, count: cropWidth * cropHeight)
let dirs = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
var candidates: [[String: Any]] = []

for sy in 0..<cropHeight {
  for sx in 0..<cropWidth {
    let startIndex = idx(sx, sy)
    if visited[startIndex] || !mask[startIndex] { continue }
    var stack = [(sx, sy)]
    var pixels: [(Int, Int)] = []
    visited[startIndex] = true
    var minX = sx
    var maxX = sx
    var minY = sy
    var maxY = sy
    while let (px, py) = stack.popLast() {
      pixels.append((px, py))
      minX = min(minX, px)
      maxX = max(maxX, px)
      minY = min(minY, py)
      maxY = max(maxY, py)
      for (dx, dy) in dirs {
        let nx = px + dx
        let ny = py + dy
        if nx < 0 || ny < 0 || nx >= cropWidth || ny >= cropHeight { continue }
        let ni = idx(nx, ny)
        if visited[ni] || !mask[ni] { continue }
        visited[ni] = true
        stack.append((nx, ny))
      }
    }
    let count = pixels.count
    if count < 12 { continue }
    let boxW = maxX - minX + 1
    let boxH = maxY - minY + 1
    let wPts = Double(boxW) / max(scaleX, 0.01)
    let hPts = Double(boxH) / max(scaleY, 0.01)
    if wPts < 6.0 || wPts > 22.0 || hPts < 6.0 || hPts > 22.0 { continue }
    let aspect = wPts / max(hPts, 0.01)
    if aspect < 0.55 || aspect > 1.65 { continue }
    var diag = 0
    var anti = 0
    for (px, py) in pixels {
      let nx = Double(px - minX) / max(Double(boxW - 1), 1.0)
      let ny = Double(py - minY) / max(Double(boxH - 1), 1.0)
      if abs(nx - ny) < 0.24 { diag += 1 }
      if abs((1.0 - nx) - ny) < 0.24 { anti += 1 }
    }
    let density = Double(count) / Double(max(1, boxW * boxH))
    let diagRatio = Double(diag) / Double(count)
    let antiRatio = Double(anti) / Double(count)
    let score = min(diagRatio, antiRatio) - abs(density - 0.28) * 0.25
    if diagRatio >= 0.20 && antiRatio >= 0.20 && density >= 0.10 && density <= 0.58 && score >= 0.18 {
      candidates.append([
        "x": Double(bounds.minX) + Double(xStart + minX + boxW / 2) / scaleX,
        "y": Double(bounds.minY) + Double(yStart + minY + boxH / 2) / scaleY,
        "width": wPts,
        "height": hPts,
        "score": score
      ])
    }
  }
}

candidates.sort { a, b in
  let ax = a["x"] as? Double ?? 0
  let bx = b["x"] as? Double ?? 0
  return ax < bx
}

let json = try! JSONSerialization.data(withJSONObject: candidates, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', [
    '-e',
    swift,
    path,
    String(window.x),
    String(window.y),
    String(window.width),
    String(window.height),
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(stdout || '[]'));
}

async function imageSize(path, { runner }) {
  const { stdout } = await runner('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeout: 5_000 });
  const width = Number(String(stdout).match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(String(stdout).match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('无法读取截图尺寸');
  return { width, height };
}

function compactForLog(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 180);
}

async function analyzeChannelsSelectedRail(path, region, location, { runner }) {
  const targetRelY = Number(location.y) - Number(region.y);
  const { stdout } = await runWechatSwift('selected', [path, region.width, region.height, targetRelY], { runner });
  const parsed = JSON.parse(String(stdout || '{}'));
  const ratio = Number(parsed.ratio || 0);
  const green = Number(parsed.green || 0);
  if (parsed.ok) return { ok: true, detail: `green=${green} ratio=${ratio.toFixed(3)}` };
  return { ok: false, reason: `左栏蝴蝶图标行没有检测到绿色选中态 green=${green} ratio=${ratio.toFixed(3)}` };
}

async function analyzeChannelsSelectedRailLegacy(path, region, location, { runner }) {
  const swift = `
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 5,
      let regionWidth = Double(args[2]),
      let regionHeight = Double(args[3]),
      let targetY = Double(args[4]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("{\\"ok\\":false,\\"reason\\":\\"无法读取左栏截图\\"}")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let scaleX = Double(width) / max(regionWidth, 1)
let scaleY = Double(height) / max(regionHeight, 1)
let centerY = Int((targetY * scaleY).rounded())
let yRadius = max(36, Int(scaleY * 54.0))
let yStart = max(0, centerY - yRadius)
let yEnd = min(height - 1, centerY + yRadius)
let xStart = min(width - 1, max(0, Int(Double(width) * 0.48)))
let xEnd = width - 1
var total = 0
var green = 0

if yStart <= yEnd && xStart <= xEnd {
  for y in yStart...yEnd {
    for x in xStart...xEnd {
      total += 1
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let r = Double(c.redComponent)
      let g = Double(c.greenComponent)
      let b = Double(c.blueComponent)
      let a = Double(c.alphaComponent)
      if a > 0.7 && g > 0.45 && g > r * 1.6 && g > b * 1.25 && r < 0.35 && b < 0.45 {
        green += 1
      }
    }
  }
}

let ratio = total > 0 ? Double(green) / Double(total) : 0
let ok = green >= 1200 && ratio >= 0.08
let out: [String: Any] = [
  "ok": ok,
  "green": green,
  "total": total,
  "ratio": ratio
]
let json = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const targetRelY = Number(location.y) - Number(region.y);
  const { stdout } = await runner('swift', ['-e', swift, path, String(region.width), String(region.height), String(targetRelY)], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '{}'));
  const ratio = Number(parsed.ratio || 0);
  const green = Number(parsed.green || 0);
  if (parsed.ok) return { ok: true, detail: `green=${green} ratio=${ratio.toFixed(3)}` };
  return { ok: false, reason: `左栏蝴蝶图标行没有检测到绿色选中态 green=${green} ratio=${ratio.toFixed(3)}` };
}

async function analyzeChannelsAlreadyVisible(path, region, { runner }) {
  const { stdout } = await runWechatSwift('already', [path, region.width, region.height], { runner });
  const parsed = JSON.parse(String(stdout || '{}'));
  const blackRatio = Number(parsed.blackRatio || 0);
  const brightLower = Number(parsed.brightLower || 0);
  const midLower = Number(parsed.midLower || 0);
  if (parsed.ok) return { ok: true, detail: `video_detail black=${blackRatio.toFixed(3)} bright=${brightLower} mid=${midLower}` };
  return { ok: false, reason: `未检测到视频号视频页 black=${blackRatio.toFixed(3)} bright=${brightLower} mid=${midLower}` };
}

async function analyzeChannelsAlreadyVisibleLegacy(path, region, { runner }) {
  const swift = `
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 4,
      let regionWidth = Double(args[2]),
      let regionHeight = Double(args[3]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("{\\"ok\\":false,\\"reason\\":\\"无法读取左栏截图\\"}")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let scaleY = Double(height) / max(regionHeight, 1)
let yStart = min(height - 1, max(0, Int(scaleY * 90.0)))
var total = 0
var black = 0
var brightLower = 0
var midLower = 0

if yStart < height {
  for y in yStart..<height {
    for x in 0..<width {
      total += 1
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let r = Double(c.redComponent)
      let g = Double(c.greenComponent)
      let b = Double(c.blueComponent)
      let a = Double(c.alphaComponent)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      if a > 0.7 && luma < 0.05 { black += 1 }
      if y > Int(Double(height) * 0.62) && a > 0.7 {
        if luma > 0.78 { brightLower += 1 }
        if luma > 0.22 && luma < 0.72 { midLower += 1 }
      }
    }
  }
}

let blackRatio = total > 0 ? Double(black) / Double(total) : 0
let ok = blackRatio > 0.62 && brightLower > 450 && midLower > 280
let out: [String: Any] = [
  "ok": ok,
  "blackRatio": blackRatio,
  "brightLower": brightLower,
  "midLower": midLower
]
let json = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await runner('swift', ['-e', swift, path, String(region.width), String(region.height)], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '{}'));
  const blackRatio = Number(parsed.blackRatio || 0);
  const brightLower = Number(parsed.brightLower || 0);
  const midLower = Number(parsed.midLower || 0);
  if (parsed.ok) return { ok: true, detail: `video_detail black=${blackRatio.toFixed(3)} bright=${brightLower} mid=${midLower}` };
  return { ok: false, reason: `未检测到视频号视频页 black=${blackRatio.toFixed(3)} bright=${brightLower} mid=${midLower}` };
}

async function analyzeLeftRailImage(path, region) {
  const { stdout } = await runWechatSwift('leftrail', [path, region.width, region.height]);
  const parsed = JSON.parse(String(stdout || '{"clusters":[]}'));
  return { clusters: Array.isArray(parsed.clusters) ? parsed.clusters : [] };
}

async function analyzeLeftRailImageLegacy(path, region) {
  const swift = `
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 4,
      let regionWidth = Double(args[2]),
      let regionHeight = Double(args[3]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
  print("{\\"clusters\\":[]}")
  exit(0)
}

let width = rep.pixelsWide
let height = rep.pixelsHigh
let scaleX = Double(width) / max(regionWidth, 1)
let scaleY = Double(height) / max(regionHeight, 1)
var xStart = max(0, Int(Double(width) * 0.02), Int(scaleX * 6.0))
var xEnd = min(width - 1, Int(Double(width) * 0.52), Int(scaleX * 78.0))
if xStart > xEnd {
  xStart = 0
  xEnd = max(0, width - 1)
}
let minDark = max(3, (xEnd - xStart) / 45)
var rows: [(y: Int, count: Int, minX: Int, maxX: Int)] = []

for y in 0..<height {
  var count = 0
  var minX = width
  var maxX = 0
  if xStart <= xEnd {
    for x in xStart...xEnd {
      guard let raw = rep.colorAt(x: x, y: y), let c = raw.usingColorSpace(.deviceRGB) else { continue }
      let r = Double(c.redComponent)
      let g = Double(c.greenComponent)
      let b = Double(c.blueComponent)
      let a = Double(c.alphaComponent)
      let luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      let chroma = max(r, g, b) - min(r, g, b)
      let darkLineArt = a > 0.5 && luma < 0.54 && chroma < 0.42
      if darkLineArt {
        count += 1
        minX = min(minX, x)
        maxX = max(maxX, x)
      }
    }
  }
  if count >= minDark {
    rows.append((y, count, minX, maxX))
  }
}

var clusters: [[String: Any]] = []
let gap = max(3, Int(scaleY * 4.0))
var i = 0
while i < rows.count {
  var start = rows[i].y
  var end = rows[i].y
  var maxCount = rows[i].count
  var minX = rows[i].minX
  var maxX = rows[i].maxX
  i += 1
  while i < rows.count && rows[i].y - end <= gap {
    end = rows[i].y
    maxCount = max(maxCount, rows[i].count)
    minX = min(minX, rows[i].minX)
    maxX = max(maxX, rows[i].maxX)
    i += 1
  }
  let logicalHeight = Double(end - start + 1) / scaleY
  let logicalWidth = Double(maxX - minX + 1) / scaleX
  let centerY = (Double(start + end) / 2.0) / scaleY
  let centerX = (Double(minX + maxX) / 2.0) / scaleX
  if logicalHeight >= 14 && logicalHeight <= 82 && logicalWidth >= 14 && logicalWidth <= 86 {
    clusters.append([
      "centerX": centerX,
      "centerY": centerY,
      "width": logicalWidth,
      "height": logicalHeight,
      "maxDark": maxCount
    ])
  }
}

let out: [String: Any] = ["clusters": clusters]
let json = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: json, encoding: .utf8)!)
`;
  const { stdout } = await execFileAsync('swift', ['-e', swift, path, String(region.width), String(region.height)], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '{"clusters":[]}'));
  return { clusters: Array.isArray(parsed.clusters) ? parsed.clusters : [] };
}

function normalizeIconClusters(clusters = [], { startY, region }) {
  return clusters
    .map((cluster) => ({
      centerX: Number(cluster.centerX),
      centerY: Number(cluster.centerY),
      width: Number(cluster.width),
      height: Number(cluster.height),
      maxDark: Number(cluster.maxDark || 0),
    }))
    .filter((cluster) => (
      [cluster.centerX, cluster.centerY, cluster.width, cluster.height].every(Number.isFinite)
      && cluster.centerY > startY
      && cluster.centerY < region.height - 40
      && cluster.centerX > Math.max(4, region.width * 0.06)
      && cluster.centerX < Math.min(region.width * 0.62, 78)
      && cluster.width >= 16
      && cluster.width <= 90
      && cluster.height >= 16
      && cluster.height <= 90
    ))
    .sort((a, b) => a.centerY - b.centerY);
}

function geometricChannelsPoint(anchors, region) {
  const close = anchors.buttons.close;
  return {
    x: Math.round(region.x + region.width * 0.5),
    y: Math.round(clamp(close.centerY + 635, region.y + 180, region.y + region.height - 80)),
  };
}

function pointText(p) {
  return `${Math.round(p.centerX)},${Math.round(p.centerY)}`;
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  return nums[Math.floor(nums.length / 2)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * macOS OS 级输入 / 截屏（零 npm 依赖、零原生编译）。
 *
 * 微信桌面端的视频号/公众号是内置 webview，不暴露 CDP 调试端口，CDP 那套
 * goto/evaluate 够不到。所以这里用系统自带能力驱动它：
 *   - 截屏：`screencapture`（命令行，系统自带）。
 *   - 鼠标/键盘/触控板式滚动：`osascript` 跑 JXA，经 ObjC 桥调用 CoreGraphics 的 CGEvent。
 *
 * 坐标系约定：
 *   - 视觉模型读出的坐标是「截图像素」坐标。
 *   - CGEvent 点击用的是「全局点（point）」坐标（主屏左上角为原点）。
 *   - Retina 屏截图是 2× 像素，所以 point = 像素 / scale，scale = 截图宽 / 主屏点宽。
 *
 * 需要用户在「系统设置 → 隐私与安全性」给运行本服务的程序授予
 * 「屏幕录制」和「辅助功能」权限，否则截屏发黑、点击无效。
 */
import { execFile, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function isMac() {
  return process.platform === 'darwin';
}

/** 运行一个命令并 resolve stdout（失败带 stderr 抛错）。 */
export function execFileAsync(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} 失败: ${stderr || err.message}`;
        return reject(err);
      }
      resolve(String(stdout || ''));
    });
  });
}

/** 跑一段 AppleScript / JXA。lang='JavaScript' 走 JXA，可调 CoreGraphics。 */
export function runOsa(script, { lang = 'AppleScript', timeout = 15000 } = {}) {
  const args = lang === 'JavaScript' ? ['-l', 'JavaScript', '-e', script] : ['-e', script];
  return execFileAsync('osascript', args, { timeout });
}

/**
 * 解析 PNG 头部拿宽高（offset 16/20，大端 uint32）。纯函数，便于测试。
 * @param {Buffer} buf  至少 24 字节
 * @returns {{width:number, height:number}}
 */
export function parsePngSize(buf) {
  if (!buf || buf.length < 24) throw new Error('PNG 头部不足 24 字节');
  // 校验 PNG 签名
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('不是合法 PNG');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 把截图像素坐标映射成 CGEvent 全局点坐标。纯函数。
 * @param {{x:number,y:number}} px        像素坐标
 * @param {number} imageWidthPx           截图像素宽
 * @param {number} screenPointWidth       主屏逻辑点宽
 */
export function imagePxToPoint(px, imageWidthPx, screenPointWidth) {
  const scale = imageWidthPx > 0 && screenPointWidth > 0 ? imageWidthPx / screenPointWidth : 1;
  return { x: Math.round(px.x / scale), y: Math.round(px.y / scale) };
}

/** 截全屏，返回 { base64, width, height }（像素）。`-x` 静音、`-t png`。 */
export async function captureScreen({ timeout = 15000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vbp-shot-'));
  const path = join(dir, 'screen.png');
  try {
    await execFileAsync('screencapture', ['-x', '-t', 'png', path], { timeout });
    const buf = readFileSync(path);
    const { width, height } = parsePngSize(buf);
    return { base64: buf.toString('base64'), width, height };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 主屏逻辑点尺寸（用于 Retina 缩放换算）。失败回退到截图本身（scale=1）。 */
export async function screenPointSize() {
  try {
    const out = await runOsa(
      'tell application "Finder" to get bounds of window of desktop',
    );
    // 形如 "0, 0, 1512, 982"
    const nums = out.split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    if (nums.length === 4) return { width: nums[2] - nums[0], height: nums[3] - nums[1] };
  } catch { /* fall through */ }
  return null;
}

/** 构造 JXA 点击脚本（纯函数，便于测试）。坐标为全局点。 */
export function buildClickScript(x, y, { holdMs = 60, button = 'left' } = {}) {
  const isRight = button === 'right';
  const isMiddle = button === 'middle';
  const down = isMiddle
    ? '$.kCGEventOtherMouseDown'
    : (isRight ? '$.kCGEventRightMouseDown' : '$.kCGEventLeftMouseDown');
  const up = isMiddle
    ? '$.kCGEventOtherMouseUp'
    : (isRight ? '$.kCGEventRightMouseUp' : '$.kCGEventLeftMouseUp');
  const btn = isMiddle ? '2' : (isRight ? '$.kCGMouseButtonRight' : '$.kCGMouseButtonLeft');
  const middleField = isMiddle
    ? 'if (typeof $.kCGMouseEventButtonNumber !== "undefined") $.CGEventSetIntegerValueField(d, $.kCGMouseEventButtonNumber, 2);'
    : '';
  const middleFieldUp = isMiddle
    ? 'if (typeof $.kCGMouseEventButtonNumber !== "undefined") $.CGEventSetIntegerValueField(u, $.kCGMouseEventButtonNumber, 2);'
    : '';
  // 实测：用 CGEvent MouseMoved 定位会落点不准（目标 300,300 实际落到 ~253,179）；
  // CGWarpMouseCursorPosition 则像素级精准（200,200→200,200）。所以先 Warp 再点。
  return `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var p = $.CGPointMake(${Number(x)}, ${Number(y)});
$.CGWarpMouseCursorPosition(p);
$.NSThread.sleepForTimeInterval(0.05);
var d = $.CGEventCreateMouseEvent($(), ${down}, p, ${btn});
${middleField}
$.CGEventPost($.kCGHIDEventTap, d);
$.NSThread.sleepForTimeInterval(${Math.max(0, Number(holdMs)) / 1000});
var u = $.CGEventCreateMouseEvent($(), ${up}, p, ${btn});
${middleFieldUp}
$.CGEventPost($.kCGHIDEventTap, u);`;
}

/** 构造 JXA 滚轮脚本（纯函数）。deltaY<0 向下滚（内容上移）。 */
export function buildScrollScript(deltaY, deltaX = 0) {
  return `ObjC.import('CoreGraphics');
var e = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitPixel, 2, ${Math.round(Number(deltaY))}, ${Math.round(Number(deltaX))});
$.CGEventPost($.kCGHIDEventTap, e);`;
}

function splitSwipeDelta(total, steps) {
  const n = Math.min(18, Math.max(3, Math.round(Number(steps) || 9)));
  const target = Math.round(Number(total) || 0);
  if (target === 0) return Array.from({ length: n }, () => 0);

  const weights = Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n;
    return Math.sin(Math.PI * t);
  });
  const weightSum = weights.reduce((sum, item) => sum + item, 0) || 1;
  const values = weights.map((w) => Math.round(target * w / weightSum));
  values[values.length - 1] += target - values.reduce((sum, item) => sum + item, 0);
  return values;
}

/**
 * 构造更接近触控板双指上滑的连续滚动脚本。
 *
 * macOS 不给普通 JXA 直接制造真实多点触控帧；这里采用系统可接受的
 * continuous pixel scroll + scroll phase，行为上比单次滚轮更接近两指滑动。
 * deltaY<0 表示手指向上滑，内容上移，通常进入下一条视频。
 */
export function buildTrackpadSwipeScript({
  deltaY = -900,
  deltaX = 0,
  steps = 9,
  intervalMs = 16,
  x = null,
  y = null,
} = {}) {
  const deltasY = splitSwipeDelta(deltaY, steps);
  const deltasX = splitSwipeDelta(deltaX, deltasY.length);
  const wait = Math.max(4, Math.min(60, Math.round(Number(intervalMs) || 16))) / 1000;
  const hasPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y));
  const pointBlock = hasPoint
    ? `var p = $.CGPointMake(${Math.round(Number(x))}, ${Math.round(Number(y))});
$.CGWarpMouseCursorPosition(p);
$.NSThread.sleepForTimeInterval(0.03);`
    : 'var p = null;';

  return `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
${pointBlock}
var FIELD_CONTINUOUS = (typeof $.kCGScrollWheelEventIsContinuous === 'undefined') ? 88 : $.kCGScrollWheelEventIsContinuous;
var FIELD_PHASE = (typeof $.kCGScrollWheelEventScrollPhase === 'undefined') ? 99 : $.kCGScrollWheelEventScrollPhase;
var PHASE_BEGAN = (typeof $.kCGScrollPhaseBegan === 'undefined') ? 1 : $.kCGScrollPhaseBegan;
var PHASE_CHANGED = (typeof $.kCGScrollPhaseChanged === 'undefined') ? 2 : $.kCGScrollPhaseChanged;
var PHASE_ENDED = (typeof $.kCGScrollPhaseEnded === 'undefined') ? 4 : $.kCGScrollPhaseEnded;
var deltasY = ${JSON.stringify(deltasY)};
var deltasX = ${JSON.stringify(deltasX)};
function postWheel(dy, dx, phase) {
  var e = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitPixel, 2, Math.round(dy), Math.round(dx));
  if (p) $.CGEventSetLocation(e, p);
  $.CGEventSetIntegerValueField(e, FIELD_CONTINUOUS, 1);
  $.CGEventSetIntegerValueField(e, FIELD_PHASE, phase);
  $.CGEventPost($.kCGHIDEventTap, e);
}
postWheel(0, 0, PHASE_BEGAN);
$.NSThread.sleepForTimeInterval(${wait});
for (var i = 0; i < deltasY.length; i++) {
  postWheel(deltasY[i], deltasX[i] || 0, PHASE_CHANGED);
  $.NSThread.sleepForTimeInterval(${wait});
}
postWheel(0, 0, PHASE_ENDED);`;
}

function keyModifierMask(modifiers = null) {
  const text = Array.isArray(modifiers) ? modifiers.join(' ') : String(modifiers || '');
  let mask = 0;
  if (/command/i.test(text)) mask |= 1 << 20;
  if (/shift/i.test(text)) mask |= 1 << 17;
  if (/control|ctrl/i.test(text)) mask |= 1 << 18;
  if (/option|alternate|alt/i.test(text)) mask |= 1 << 19;
  return mask;
}

export function buildKeyCodeScript(code, modifiers = null, { holdMs = 45 } = {}) {
  const key = Math.max(0, Math.floor(Number(code)));
  const flags = keyModifierMask(modifiers);
  return `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var key = ${key};
var flags = ${flags};
var down = $.CGEventCreateKeyboardEvent($(), key, true);
if (flags) $.CGEventSetFlags(down, flags);
$.CGEventPost($.kCGHIDEventTap, down);
$.NSThread.sleepForTimeInterval(${Math.max(0, Number(holdMs)) / 1000});
var up = $.CGEventCreateKeyboardEvent($(), key, false);
if (flags) $.CGEventSetFlags(up, flags);
$.CGEventPost($.kCGHIDEventTap, up);`;
}

export function parseNumberList(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter(Number.isFinite);
}

export function wechatChannelsEntryPoint(bounds) {
  if (bounds?.x == null || bounds?.y == null) {
    throw new Error('微信主窗口坐标无效');
  }
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('微信主窗口坐标无效');
  }
  return {
    x: Math.round(x + 30),
    y: Math.round(y + 354),
  };
}

export function wechatChannelsProfilePoint(bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  if (bounds?.x == null || bounds?.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('视频号窗口坐标无效');
  }
  const rightAnchoredOffset = Number.isFinite(width) && width > 60
    ? Math.min(width - 30, 894)
    : 894;
  return {
    x: Math.round(x + rightAnchoredOffset),
    y: Math.round(y + 64),
  };
}

export function wechatChannelsFollowMenuPoint(bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  if (bounds?.x == null || bounds?.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('视频号窗口坐标无效');
  }
  return {
    x: Math.round(x + 52),
    y: Math.round(y + 151),
  };
}

export function wechatChannelsInitialVideoTabPoint(bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  if (bounds?.x == null || bounds?.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('视频号窗口坐标无效');
  }
  return {
    x: Math.round(x + 276),
    y: Math.round(y + 25),
  };
}

export function buildWechatMainWindowBoundsScript() {
  return `tell application "System Events"
  repeat with processName in {"WeChat", "微信"}
    if exists process (processName as text) then
      tell process (processName as text)
        repeat with w in windows
          try
            if (name of w as text) is "微信" then
              set p to position of w
              set s to size of w
              return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
            end if
          end try
        end repeat
        if (count of windows) > 0 then
          set w to window 1
          set p to position of w
          set s to size of w
          return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
        end if
      end tell
    end if
  end repeat
end tell
return ""`;
}

export function buildWechatAuxiliaryWindowBoundsScript() {
  return `tell application "System Events"
  repeat with processName in {"WeChat", "微信"}
    if exists process (processName as text) then
      tell process (processName as text)
        set bestBounds to ""
        set bestArea to 0
        repeat with w in windows
          try
            if (name of w as text) is not "微信" then
              set p to position of w
              set s to size of w
              set ww to item 1 of s
              set hh to item 2 of s
              if ww >= 500 and hh >= 300 then
                set area to ww * hh
                if area > bestArea then
                  set bestArea to area
                  set bestBounds to (item 1 of p as text) & "," & (item 2 of p as text) & "," & (ww as text) & "," & (hh as text)
                end if
              end if
            end if
          end try
        end repeat
        if bestBounds is not "" then return bestBounds
      end tell
    end if
  end repeat
end tell
return ""`;
}

export async function getWechatMainWindowBounds() {
  const out = await runOsa(buildWechatMainWindowBoundsScript(), { timeout: 8000 });
  const nums = parseNumberList(out);
  if (nums.length < 4) throw new Error('未能读取微信主窗口位置');
  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
}

export async function getWechatAuxiliaryWindowBounds() {
  const out = await runOsa(buildWechatAuxiliaryWindowBoundsScript(), { timeout: 8000 });
  const nums = parseNumberList(out);
  if (nums.length < 4) throw new Error('未能读取视频号窗口位置');
  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
}

export async function getWechatWindowCount() {
  const out = await runOsa(`tell application "System Events"
  repeat with processName in {"WeChat", "微信"}
    if exists process (processName as text) then
      tell process (processName as text)
        return count of windows
      end tell
    end if
  end repeat
end tell
return 0`, { timeout: 8000 });
  return Number(String(out || '').trim()) || 0;
}

export async function waitForWechatAuxiliaryWindow({ timeoutMs = 8000, pollMs = 400 } = {}) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    try {
      await getWechatAuxiliaryWindowBounds();
      return true;
    } catch { /* keep polling */ }
    await sleep(pollMs);
  }
  return false;
}

export async function openWechatChannelsEntry({ afterMs = 2500 } = {}) {
  await activateWeChat();
  const bounds = await getWechatMainWindowBounds();
  const point = wechatChannelsEntryPoint(bounds);
  await clickAtPoint(point.x, point.y, { holdMs: 60 });
  await sleep(afterMs);
  const opened = await waitForWechatAuxiliaryWindow({ timeoutMs: 5000 });
  return { opened, point, bounds };
}

export async function openWechatChannelsProfile({ afterMs = 7000 } = {}) {
  await activateWeChat();
  const bounds = await getWechatAuxiliaryWindowBounds();
  const point = wechatChannelsProfilePoint(bounds);
  await clickAtPoint(point.x, point.y, { holdMs: 60 });
  await sleep(afterMs);
  return { point, bounds };
}

export async function openWechatChannelsFollowMenu({ afterMs = 1500 } = {}) {
  await activateWeChat();
  const bounds = await getWechatAuxiliaryWindowBounds();
  const point = wechatChannelsFollowMenuPoint(bounds);
  await clickAtPoint(point.x, point.y, { holdMs: 60 });
  await sleep(afterMs);
  return { point, bounds };
}

export async function closeWechatChannelsInitialVideoTabFromFollow({ afterMs = 900 } = {}) {
  await activateWeChat();
  const bounds = await getWechatAuxiliaryWindowBounds();
  const point = wechatChannelsInitialVideoTabPoint(bounds);
  await clickAtPoint(point.x, point.y, { button: 'middle', holdMs: 70 });
  await sleep(afterMs);
  return { point, bounds };
}

function escapeAppleScriptText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function normalizeWechatTabTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function shouldCloseWechatTab(tab, { targetTitle = '视频号', keepTitle = '关注' } = {}) {
  const title = normalizeWechatTabTitle(tab?.title);
  if (!title) return false;
  if (title === normalizeWechatTabTitle(keepTitle)) return false;
  if (tab?.selected === true) return false;
  return title === normalizeWechatTabTitle(targetTitle);
}

export function buildCloseInactiveWechatTabScript({ targetTitle = '视频号', keepTitle = '关注' } = {}) {
  const target = escapeAppleScriptText(normalizeWechatTabTitle(targetTitle));
  const keep = escapeAppleScriptText(normalizeWechatTabTitle(keepTitle));
  return `
on elementText(el)
  tell application "System Events"
    set t to ""
    try
      set t to value of attribute "AXTitle" of el as text
    end try
    if t is "" then
      try
        set t to name of el as text
      end try
    end if
    if t is "" then
      try
        set t to value of el as text
      end try
    end if
    return t
  end tell
end elementText

on elementDescription(el)
  tell application "System Events"
    try
      return description of el as text
    on error
      return ""
    end try
  end tell
end elementDescription

on elementSelected(el)
  tell application "System Events"
    try
      if (value of attribute "AXSelected" of el) is true then return true
    end try
    return false
  end tell
end elementSelected

on tryCloseElement(el)
  tell application "System Events"
    try
      perform action "AXClose" of el
      return true
    end try

    try
      set kids to UI elements of el
      repeat with kid in kids
        set labelText to (my elementText(kid)) & " " & (my elementDescription(kid))
        set shouldTryClose to false
        if labelText contains "关闭" then set shouldTryClose to true
        if labelText contains "Close" then set shouldTryClose to true
        if labelText contains "close" then set shouldTryClose to true
        if shouldTryClose then
          try
            click kid
            return true
          end try
          try
            perform action "AXPress" of kid
            return true
          end try
        end if
      end repeat
    end try
    return false
  end tell
end tryCloseElement

tell application "System Events"
  repeat with processName in {"WeChat", "微信"}
    if exists process (processName as text) then
      tell process (processName as text)
        set frontmost to true
        repeat with w in windows
          set foundKeepTab to false
          try
            set elems to entire contents of w
          on error
            set elems to {}
          end try

          repeat with el in elems
            if (my elementText(el)) is "${keep}" then set foundKeepTab to true
          end repeat

          repeat with el in elems
            set titleText to my elementText(el)
            set selectedNow to my elementSelected(el)
            set shouldCloseTab to false
            if titleText is "${target}" then
              if titleText is not "${keep}" then
                if selectedNow is false then set shouldCloseTab to true
              end if
            end if
            if shouldCloseTab then
              if my tryCloseElement(el) then
                if foundKeepTab then
                  return "closed:kept-current"
                else
                  return "closed:no-keep-title-seen"
                end if
              end if
            end if
          end repeat
        end repeat
      end tell
    end if
  end repeat
end tell
return "not_found"`;
}

export async function closeInactiveWechatTab(opts = {}) {
  const out = await runOsa(buildCloseInactiveWechatTabScript(opts), { timeout: opts.timeout ?? 8000 });
  const status = String(out || '').trim();
  return {
    closed: status.startsWith('closed:'),
    status: status || 'not_found',
  };
}

/** 点击全局点坐标。 */
export async function clickAtPoint(x, y, opts = {}) {
  await runOsa(buildClickScript(x, y, opts), { lang: 'JavaScript' });
}

/** 滚动（点像素）。 */
export async function scrollByPixels(deltaY, deltaX = 0) {
  await runOsa(buildScrollScript(deltaY, deltaX), { lang: 'JavaScript' });
}

/** 触控板式上滑，失败时降级为普通滚轮下翻。 */
export async function swipeUpLikeTrackpad({
  distancePx = 900,
  steps = 9,
  intervalMs = 16,
  x = null,
  y = null,
} = {}) {
  const distance = Math.max(120, Math.abs(Math.round(Number(distancePx) || 900)));
  try {
    await runOsa(buildTrackpadSwipeScript({
      deltaY: -distance,
      deltaX: 0,
      steps,
      intervalMs,
      x,
      y,
    }), { lang: 'JavaScript', timeout: 6000 });
    return { method: 'trackpad_swipe' };
  } catch (primaryError) {
    try {
      await scrollByPixels(-distance, 0);
      return { method: 'wheel_scroll', fallbackFrom: primaryError.message };
    } catch (fallbackError) {
      fallbackError.message = `触控板式上滑失败，滚轮兜底也失败: ${fallbackError.message}; 原始上滑错误: ${primaryError.message}`;
      throw fallbackError;
    }
  }
}

/** 触控板式下滑，失败时降级为普通滚轮上翻。 */
export async function swipeDownLikeTrackpad({
  distancePx = 900,
  steps = 9,
  intervalMs = 16,
  x = null,
  y = null,
} = {}) {
  const distance = Math.max(120, Math.abs(Math.round(Number(distancePx) || 900)));
  try {
    await runOsa(buildTrackpadSwipeScript({
      deltaY: distance,
      deltaX: 0,
      steps,
      intervalMs,
      x,
      y,
    }), { lang: 'JavaScript', timeout: 6000 });
    return { method: 'trackpad_swipe' };
  } catch (primaryError) {
    try {
      await scrollByPixels(distance, 0);
      return { method: 'wheel_scroll', fallbackFrom: primaryError.message };
    } catch (fallbackError) {
      fallbackError.message = `触控板式下滑失败，滚轮兜底也失败: ${fallbackError.message}; 原始下滑错误: ${primaryError.message}`;
      throw fallbackError;
    }
  }
}

/** 激活微信窗口（中英文名都试）。 */
export async function activateWeChat() {
  for (const name of ['WeChat', '微信']) {
    try {
      await runOsa(`tell application "${name}" to activate`);
      return name;
    } catch { /* try next */ }
  }
  throw new Error('未找到微信应用（WeChat / 微信）。请确认微信桌面端已安装并登录。');
}

/** 发送一个按键（System Events）。key 用 AppleScript 关键字，如 "escape"、"w" using command。 */
export async function keyStroke(keyExpr) {
  await runOsa(`tell application "System Events" to keystroke ${keyExpr}`);
}

/** 发送 key code（如 53=esc, 13=w）。modifiers 形如 "command down"。 */
export async function keyCode(code, modifiers = null) {
  await runOsa(buildKeyCodeScript(code, modifiers), { lang: 'JavaScript' });
}

/** 写系统剪贴板（用 pbcopy，中文/IME 安全；后续 Cmd+V 粘贴比逐字 keystroke 可靠）。 */
export function setClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy');
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy 退出码 ${code}`))));
    child.stdin.end(String(text ?? ''));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 高层封装：管理一次截图/缩放上下文，提供「按截图像素坐标点击」。
 * 让 wechat.js 直接用视觉模型读出的像素坐标点击，无需关心 Retina 换算。
 */
export class MacInputSession {
  constructor() {
    this.lastShot = null; // { base64, width, height }
    this.pointWidth = null;
  }

  async refreshScreenMetrics() {
    const size = await screenPointSize();
    this.pointWidth = size?.width || null;
  }

  async screenshot() {
    this.lastShot = await captureScreen();
    if (!this.pointWidth) await this.refreshScreenMetrics();
    return this.lastShot;
  }

  /** 按「最近一次截图的像素坐标」点击。 */
  async clickImagePx(px, opts = {}) {
    const imgW = this.lastShot?.width || px.imageWidth || 0;
    const pointW = this.pointWidth || imgW; // 拿不到逻辑宽就当 scale=1
    const pt = imagePxToPoint(px, imgW, pointW);
    await clickAtPoint(pt.x, pt.y, opts);
    await sleep(opts.afterMs ?? 300);
    return pt;
  }

  async scroll(deltaY, deltaX = 0) { await scrollByPixels(deltaY, deltaX); await sleep(250); }
  async swipeUp(opts = {}) {
    const imgW = this.lastShot?.width || 0;
    const imgH = this.lastShot?.height || 0;
    const pointW = this.pointWidth || imgW;
    const defaultPoint = imgW > 0 && imgH > 0
      ? imagePxToPoint({ x: imgW / 2, y: imgH * 0.56 }, imgW, pointW)
      : null;
    const result = await swipeUpLikeTrackpad({
      ...opts,
      x: opts.x ?? defaultPoint?.x ?? null,
      y: opts.y ?? defaultPoint?.y ?? null,
    });
    await sleep(opts.afterMs ?? 700);
    return result;
  }
  async swipeDown(opts = {}) {
    const imgW = this.lastShot?.width || 0;
    const imgH = this.lastShot?.height || 0;
    const pointW = this.pointWidth || imgW;
    const defaultPoint = imgW > 0 && imgH > 0
      ? imagePxToPoint({ x: imgW / 2, y: imgH * 0.56 }, imgW, pointW)
      : null;
    const result = await swipeDownLikeTrackpad({
      ...opts,
      x: opts.x ?? defaultPoint?.x ?? null,
      y: opts.y ?? defaultPoint?.y ?? null,
    });
    await sleep(opts.afterMs ?? 700);
    return result;
  }
  async pressEscape() { await keyCode(53); await sleep(200); }
  async closeTab() { await keyCode(13, 'command down'); await sleep(300); } // Cmd+W
  async closeInactiveTab(opts = {}) { return closeInactiveWechatTab(opts); }
  async openChannelsEntry(opts = {}) { return openWechatChannelsEntry(opts); }
  async openChannelsProfile(opts = {}) { return openWechatChannelsProfile(opts); }
  async openChannelsFollowMenu(opts = {}) { return openWechatChannelsFollowMenu(opts); }
  async closeChannelsInitialVideoTabFromFollow(opts = {}) { return closeWechatChannelsInitialVideoTabFromFollow(opts); }
  async copy() { await keyCode(8, 'command down'); await sleep(200); }       // Cmd+C
  async paste() { await keyCode(9, 'command down'); await sleep(250); }      // Cmd+V
  async enter() { await keyCode(36); await sleep(400); }                     // Return
  /** 用剪贴板可靠输入中文：写剪贴板 → Cmd+V。 */
  async typeViaClipboard(text) { await setClipboard(text); await sleep(120); await this.paste(); }
  async sleep(ms) { await sleep(ms); }
}

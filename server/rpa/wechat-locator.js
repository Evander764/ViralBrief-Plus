import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { callJSON } from '../ai/client.js';
import { log } from '../lib/log.js';

const execFileAsync = promisify(execFile);
const CODE_CONFIDENCE_THRESHOLD = 0.72;
const VISION_CONFIDENCE_THRESHOLD = 0.65;

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

export async function getWechatTrafficLightAnchors({ runner = execFileAsync } = {}) {
  const script = `
on run
  set rowItems to {}
  tell application id "com.tencent.xinWeChat"
    activate
    reopen
  end tell
  delay 0.4
  tell application "System Events"
    try
      set p to first process whose bundle identifier is "com.tencent.xinWeChat"
      set visible of p to true
      set frontmost of p to true
      set w to window 1 of p
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
      try
        set contentCount to count of entire contents of p
      end try
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

export function cleanupCapturedRail(rail) {
  if (rail?.dir) rmSync(rail.dir, { recursive: true, force: true });
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

export async function locateChannelsIconByVision({ anchors, rail } = {}) {
  const region = rail?.region || leftRailRegionFromAnchors(anchors);
  if (!region || !rail?.path || !rail?.image) {
    return { ok: false, method: 'vision_left_rail', reason: '缺少左侧栏截图' };
  }
  try {
    const imageB64 = readFileSync(rail.path, 'base64');
    const imageWidth = rail.image.width;
    const imageHeight = rail.image.height;
    const { json } = await callJSON({
      task: 'wechat_channels_locator',
      maxTokens: 600,
      images: [{ data: imageB64, media_type: 'image/png' }],
      system: [
        '你是桌面软件定位助手。只根据截图识别 macOS 微信左侧导航栏里的“视频号”入口。',
        '视频号图标通常像蝴蝶或双叶结形，不是聊天气泡、联系人、盒子、朋友圈圆环、靶心或小程序图标。',
        '只返回 JSON，不要解释。',
      ].join('\n'),
      user: [
        `截图只包含微信左侧导航栏，图片像素尺寸 ${imageWidth}x${imageHeight}。`,
        '请返回视频号图标中心点的图片像素坐标。',
        'JSON 格式: {"x": number, "y": number, "confidence": number, "reason": "简短说明"}',
      ].join('\n'),
      validate: validateVisionLocatorResult,
    });
    const confidence = Number(json.confidence);
    const px = Number(json.x);
    const py = Number(json.y);
    if (confidence < VISION_CONFIDENCE_THRESHOLD) {
      return { ok: false, method: 'vision_left_rail', reason: `视觉定位置信度过低: ${confidence}`, confidence, diagnostics: json.reason || '' };
    }
    if (px < 0 || py < 0 || px > imageWidth || py > imageHeight) {
      return { ok: false, method: 'vision_left_rail', reason: '视觉定位返回越界坐标', confidence, diagnostics: json.reason || '' };
    }
    const pointError = validateVisionLocatorPoint({ px, py, imageWidth, imageHeight, region });
    if (pointError) {
      return { ok: false, method: 'vision_left_rail', reason: pointError, confidence, diagnostics: json.reason || '' };
    }
    return {
      ok: true,
      method: 'vision_left_rail',
      x: Math.round(region.x + (px / imageWidth) * region.width),
      y: Math.round(region.y + (py / imageHeight) * region.height),
      confidence,
      diagnostics: `视觉定位 ${Math.round(px)},${Math.round(py)}: ${json.reason || ''}`,
    };
  } catch (e) {
    return { ok: false, method: 'vision_left_rail', reason: String(e.message || e) };
  }
}

export async function clickWechatChannelsFromMainByLocator({ runner = execFileAsync } = {}) {
  let rail = null;
  try {
    const anchors = await getWechatTrafficLightAnchors({ runner });
    if (!anchors.ok) return { ok: false, code: 'main_channels_entry', method: 'traffic_light_left_rail', message: anchors.reason || '无法读取微信窗口红黄绿按钮' };
    rail = await captureWechatLeftRail(anchors, { runner });
    if (!rail.ok) return { ok: false, code: 'main_channels_entry', method: 'traffic_light_left_rail', message: rail.reason || '无法截取微信左侧栏' };

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
      const codeClick = await clickAndVerify(codeLocated, { runner });
      if (codeClick.ok) return codeClick;
      log.info(`[RPA] 微信视频号代码定位点击未验证成功，尝试视觉兜底: ${codeClick.message || ''}`);
    }

    log.info(`[RPA] 微信视频号代码定位未达阈值，尝试视觉兜底: ${codeLocated.diagnostics || codeLocated.reason || ''}`);
    const visionLocated = await locateChannelsIconByVision({ anchors, rail });
    if (visionLocated.ok) return await clickAndVerify(visionLocated, { runner });

    return {
      ok: false,
      code: 'main_channels_entry',
      method: 'traffic_light_left_rail+vision_left_rail',
      message: [
        codeLocated.diagnostics || codeLocated.reason || '代码定位失败',
        visionLocated.reason || visionLocated.diagnostics || '视觉定位失败',
        anchors.diagnostics,
        rail.diagnostics,
      ].filter(Boolean).join('；'),
    };
  } finally {
    cleanupCapturedRail(rail);
  }
}

export async function detectWechatChannelsVisibleByScreenshot({ runner = execFileAsync } = {}) {
  let rail = null;
  try {
    const anchors = await getWechatTrafficLightAnchors({ runner });
    if (!anchors.ok) return { ok: false, method: 'system_screenshot_channels_state', reason: anchors.reason || '无法读取微信窗口红黄绿按钮' };
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

export function validateVisionLocatorResult(json) {
  if (!json || typeof json !== 'object') return '返回值不是对象';
  if (!Number.isFinite(Number(json.x))) return 'x 必须是数字';
  if (!Number.isFinite(Number(json.y))) return 'y 必须是数字';
  if (!Number.isFinite(Number(json.confidence))) return 'confidence 必须是数字';
  return null;
}

export function validateVisionLocatorPoint({ px, py, imageWidth, imageHeight, region } = {}) {
  const values = [px, py, imageWidth, imageHeight, region?.width, region?.height].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return '视觉定位缺少截图尺寸或区域信息';
  if (px < 0 || py < 0 || px > imageWidth || py > imageHeight) return '视觉定位返回越界坐标';
  const logicalX = (px / imageWidth) * region.width;
  const minIconX = Math.max(4, region.width * 0.06);
  const maxIconX = Math.min(region.width * 0.46, 58);
  if (logicalX < minIconX || logicalX > maxIconX) {
    return `视觉定位横坐标不在左侧图标列内: ${Math.round(logicalX)}`;
  }
  return null;
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

async function verifyChannelsVisible({ runner, location }) {
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

async function verifyChannelsSelectedBySystemScreenshot(location, { runner }) {
  if (!Number.isFinite(Number(location?.x)) || !Number.isFinite(Number(location?.y))) {
    return { ok: false, message: '缺少点击点，无法做左栏选中态验证' };
  }
  let rail = null;
  try {
    const anchors = await getWechatTrafficLightAnchors({ runner });
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

async function imageSize(path, { runner }) {
  const { stdout } = await runner('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeout: 5_000 });
  const width = Number(String(stdout).match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(String(stdout).match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('无法读取截图尺寸');
  return { width, height };
}

async function analyzeChannelsSelectedRail(path, region, location, { runner }) {
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

/**
 * macOS OS 级输入 / 截屏（零 npm 依赖、零原生编译）。
 *
 * 微信桌面端的视频号/公众号是内置 webview，不暴露 CDP 调试端口，CDP 那套
 * goto/evaluate 够不到。所以这里用系统自带能力驱动它：
 *   - 截屏：`screencapture`（命令行，系统自带）。
 *   - 鼠标/键盘：`osascript` 跑 JXA，经 ObjC 桥调用 CoreGraphics 的 CGEvent。
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
  const down = isRight ? '$.kCGEventRightMouseDown' : '$.kCGEventLeftMouseDown';
  const up = isRight ? '$.kCGEventRightMouseUp' : '$.kCGEventLeftMouseUp';
  const btn = isRight ? '$.kCGMouseButtonRight' : '$.kCGMouseButtonLeft';
  return `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var p = $.CGPointMake(${Number(x)}, ${Number(y)});
var mv = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, p, ${btn});
$.CGEventPost($.kCGHIDEventTap, mv);
$.NSThread.sleepForTimeInterval(0.03);
var d = $.CGEventCreateMouseEvent($(), ${down}, p, ${btn});
$.CGEventPost($.kCGHIDEventTap, d);
$.NSThread.sleepForTimeInterval(${Math.max(0, Number(holdMs)) / 1000});
var u = $.CGEventCreateMouseEvent($(), ${up}, p, ${btn});
$.CGEventPost($.kCGHIDEventTap, u);`;
}

/** 构造 JXA 滚轮脚本（纯函数）。deltaY<0 向下滚（内容上移）。 */
export function buildScrollScript(deltaY, deltaX = 0) {
  return `ObjC.import('CoreGraphics');
var e = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitPixel, 2, ${Math.round(Number(deltaY))}, ${Math.round(Number(deltaX))});
$.CGEventPost($.kCGHIDEventTap, e);`;
}

/** 点击全局点坐标。 */
export async function clickAtPoint(x, y, opts = {}) {
  await runOsa(buildClickScript(x, y, opts), { lang: 'JavaScript' });
}

/** 滚动（点像素）。 */
export async function scrollByPixels(deltaY, deltaX = 0) {
  await runOsa(buildScrollScript(deltaY, deltaX), { lang: 'JavaScript' });
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
  const using = modifiers ? ` using {${modifiers}}` : '';
  await runOsa(`tell application "System Events" to key code ${Number(code)}${using}`);
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
  async pressEscape() { await keyCode(53); await sleep(200); }
  async closeTab() { await keyCode(13, 'command down'); await sleep(300); } // Cmd+W
  async copy() { await keyCode(8, 'command down'); await sleep(200); }       // Cmd+C
  async paste() { await keyCode(9, 'command down'); await sleep(250); }      // Cmd+V
  async enter() { await keyCode(36); await sleep(400); }                     // Return
  /** 用剪贴板可靠输入中文：写剪贴板 → Cmd+V。 */
  async typeViaClipboard(text) { await setClipboard(text); await sleep(120); await this.paste(); }
  async sleep(ms) { await sleep(ms); }
}

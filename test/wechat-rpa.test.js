import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePngSize,
  imagePxToPoint,
  buildClickScript,
  buildKeyCodeScript,
  buildScrollScript,
  buildTrackpadSwipeScript,
  swipeDownLikeTrackpad,
  buildCloseInactiveWechatTabScript,
  buildWechatAuxiliaryWindowBoundsScript,
  buildWechatMainWindowBoundsScript,
  parseNumberList,
  shouldCloseWechatTab,
  wechatChannelsEntryPoint,
  wechatChannelsFollowMenuPoint,
  wechatChannelsInitialVideoTabPoint,
  wechatChannelsProfilePoint,
} from '../server/rpa/macos-input.js';
import { parseChinesePublishTime } from '../server/rpa/wechat.js';

function fakePng(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0); // 签名
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('parsePngSize：从 PNG 头部读出宽高', () => {
  assert.deepEqual(parsePngSize(fakePng(3024, 1964)), { width: 3024, height: 1964 });
  assert.throws(() => parsePngSize(Buffer.alloc(10)), /不足/);
  assert.throws(() => parsePngSize(Buffer.alloc(24)), /不是合法 PNG/);
});

test('imagePxToPoint：Retina 2× 截图坐标换算成逻辑点', () => {
  // 截图宽 3024 像素，主屏逻辑宽 1512 点 → scale=2
  assert.deepEqual(imagePxToPoint({ x: 200, y: 100 }, 3024, 1512), { x: 100, y: 50 });
  // 非 Retina：scale=1
  assert.deepEqual(imagePxToPoint({ x: 200, y: 100 }, 1512, 1512), { x: 200, y: 100 });
  // 拿不到逻辑宽（0）时不缩放
  assert.deepEqual(imagePxToPoint({ x: 200, y: 100 }, 3024, 0), { x: 200, y: 100 });
});

test('buildClickScript：含 CoreGraphics 与左键按下/抬起及坐标', () => {
  const s = buildClickScript(123, 456);
  assert.match(s, /CoreGraphics/);
  assert.match(s, /CGPointMake\(123, 456\)/);
  assert.match(s, /kCGEventLeftMouseDown/);
  assert.match(s, /kCGEventLeftMouseUp/);
  const right = buildClickScript(1, 2, { button: 'right' });
  assert.match(right, /kCGEventRightMouseDown/);
  const middle = buildClickScript(3, 4, { button: 'middle' });
  assert.match(middle, /kCGEventOtherMouseDown/);
  assert.match(middle, /kCGMouseEventButtonNumber/);
});

test('buildKeyCodeScript：用 CoreGraphics 发送按键，避免 System Events keystroke 拦截', () => {
  const esc = buildKeyCodeScript(53);
  assert.match(esc, /CGEventCreateKeyboardEvent/);
  assert.match(esc, /key = 53/);
  assert.doesNotMatch(esc, /System Events/);

  const cmdW = buildKeyCodeScript(13, 'command down');
  assert.match(cmdW, /flags = 1048576/);
  assert.match(cmdW, /CGEventSetFlags/);
});

test('wechatChannelsEntryPoint：从微信主窗口位置计算左侧视频号入口坐标', () => {
  assert.deepEqual(wechatChannelsEntryPoint({ x: 199, y: 43, width: 1209, height: 781 }), { x: 229, y: 397 });
  assert.throws(() => wechatChannelsEntryPoint({ x: null, y: 43 }), /坐标无效/);
});

test('wechatChannelsProfilePoint：从视频号窗口位置计算右上小人入口坐标', () => {
  assert.deepEqual(wechatChannelsProfilePoint({ x: 323, y: 64, width: 924, height: 796 }), { x: 1217, y: 128 });
  assert.throws(() => wechatChannelsProfilePoint({ x: 323, y: Number.NaN }), /坐标无效/);
});

test('wechatChannelsFollowMenuPoint：从视频号窗口位置计算左侧关注入口坐标', () => {
  assert.deepEqual(wechatChannelsFollowMenuPoint({ x: 323, y: 64, width: 1248, height: 829 }), { x: 375, y: 215 });
  assert.throws(() => wechatChannelsFollowMenuPoint({ x: 'bad', y: 64 }), /坐标无效/);
});

test('wechatChannelsInitialVideoTabPoint：从关注总览窗口位置计算左侧旧视频号标签坐标', () => {
  assert.deepEqual(wechatChannelsInitialVideoTabPoint({ x: 323, y: 64, width: 924, height: 796 }), { x: 599, y: 89 });
  assert.throws(() => wechatChannelsInitialVideoTabPoint({ x: 'bad', y: 64 }), /坐标无效/);
});

test('buildWechatMainWindowBoundsScript：优先读取名为微信的主窗口', () => {
  const s = buildWechatMainWindowBoundsScript();
  assert.match(s, /name of w as text\) is "微信"/);
  assert.match(s, /position of w/);
  assert.match(s, /size of w/);
});

test('buildWechatAuxiliaryWindowBoundsScript：读取非主窗口作为视频号窗口', () => {
  const s = buildWechatAuxiliaryWindowBoundsScript();
  assert.match(s, /name of w as text\) is not "微信"/);
  assert.match(s, /position of w/);
  assert.match(s, /size of w/);
  assert.match(s, /ww >= 500 and hh >= 300/);
  assert.match(s, /bestArea/);
  assert.doesNotMatch(s, /set w to window 1/);
});

test('parseNumberList：解析 AppleScript 逗号数字输出', () => {
  assert.deepEqual(parseNumberList('199, 43, 1209, 781'), [199, 43, 1209, 781]);
});

test('buildScrollScript：含滚轮事件与位移', () => {
  const s = buildScrollScript(-180);
  assert.match(s, /CGEventCreateScrollWheelEvent/);
  assert.match(s, /-180/);
});

test('buildTrackpadSwipeScript：生成连续滚动阶段，模拟触控板上滑', () => {
  const s = buildTrackpadSwipeScript({ deltaY: -900, steps: 4, intervalMs: 12, x: 300, y: 500 });
  assert.match(s, /CGWarpMouseCursorPosition/);
  assert.match(s, /kCGScrollWheelEventIsContinuous/);
  assert.match(s, /kCGScrollWheelEventScrollPhase/);
  assert.match(s, /PHASE_BEGAN/);
  assert.match(s, /PHASE_CHANGED/);
  assert.match(s, /PHASE_ENDED/);
  assert.match(s, /deltasY = \[-/);
});

test('swipeDownLikeTrackpad：向下滑动 helper 可导出使用', () => {
  assert.equal(typeof swipeDownLikeTrackpad, 'function');
  const s = buildTrackpadSwipeScript({ deltaY: 900, steps: 4, intervalMs: 12, x: 300, y: 500 });
  assert.match(s, /deltasY = \[/);
  assert.doesNotMatch(s, /deltasY = \[-/);
});

test('shouldCloseWechatTab：只关闭非当前的视频号标签，保留关注总览', () => {
  assert.equal(shouldCloseWechatTab({ title: '视频号', selected: false }), true);
  assert.equal(shouldCloseWechatTab({ title: '视频号', selected: true }), false);
  assert.equal(shouldCloseWechatTab({ title: '关注', selected: true }), false);
  assert.equal(shouldCloseWechatTab({ title: '关注', selected: false }), false);
  assert.equal(shouldCloseWechatTab({ title: ' 视频号\n', selected: false }), true);
});

test('buildCloseInactiveWechatTabScript：按标题关闭旧视频号标签并排除关注标签', () => {
  const s = buildCloseInactiveWechatTabScript({ targetTitle: '视频号', keepTitle: '关注' });
  assert.match(s, /titleText is "视频号"/);
  assert.match(s, /titleText is not "关注"/);
  assert.match(s, /foundKeepTab/);
  assert.match(s, /AXClose/);
});

test('parseChinesePublishTime：相对时间', () => {
  const now = new Date('2026-06-01T04:00:00Z'); // 北京 6/1 12:00
  assert.equal(parseChinesePublishTime('3小时前', now), '2026-06-01T01:00:00.000Z');
  assert.equal(parseChinesePublishTime('刚刚', now), '2026-06-01T04:00:00.000Z');
  assert.equal(parseChinesePublishTime('昨天 09:00', now), '2026-05-31T01:00:00.000Z');
});

test('parseChinesePublishTime：绝对日期按北京时间，缺年份取不晚于今天', () => {
  const now = new Date('2026-06-01T04:00:00Z');
  assert.equal(parseChinesePublishTime('5月30日', now), '2026-05-29T16:00:00.000Z');
  assert.equal(parseChinesePublishTime('编辑于 5月30日 14:30', now), '2026-05-30T06:30:00.000Z');
  assert.equal(parseChinesePublishTime('2025年12月31日', now), '2025-12-30T16:00:00.000Z');
  // 缺年份且月份晚于当前 → 归到去年，避免当成未来
  assert.equal(parseChinesePublishTime('12月31日', now), '2025-12-30T16:00:00.000Z');
});

test('parseChinesePublishTime：空 / 无法解析 → null（绝不瞎猜）', () => {
  assert.equal(parseChinesePublishTime(null), null);
  assert.equal(parseChinesePublishTime(''), null);
  assert.equal(parseChinesePublishTime('随便一段不是时间的文字'), null);
});

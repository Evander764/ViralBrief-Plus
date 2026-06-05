import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-wechat-desktop-error-'));

const { __wechatDesktopInternals } = await import('../server/rpa/wechat-desktop.js');
const {
  friendlyWechatDesktopError,
  appleScriptForMainSearchCreator,
  parseScriptResult,
  sanitizeWechatErrorText,
} = __wechatDesktopInternals;

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

test('微信空白窗口优先提示恢复微信首页或重启，不误报为辅助功能权限', () => {
  const msg = friendlyWechatDesktopError(codedError(
    'wechat_window_empty',
    '微信主窗口当前是空白或不可读，未暴露搜索框；窗口诊断=窗口 微信，控件 0，文本片段 ',
  ));

  assert.match(msg, /微信主窗口当前是空白或不可读/);
  assert.match(msg, /恢复到已登录首页/);
  assert.match(msg, /重启微信后再跑/);
  assert.match(msg, /窗口诊断=窗口 微信，控件 0/);
  assert.doesNotMatch(msg, /系统设置 > 隐私与安全性 > 辅助功能/);
});

test('辅助功能权限失败仍提示到系统设置授权', () => {
  const msg = friendlyWechatDesktopError(codedError(
    'accessibility',
    'System Events got an error: osascript is not allowed assistive access.',
  ));

  assert.match(msg, /无法控制桌面微信/);
  assert.match(msg, /系统设置 > 隐私与安全性 > 辅助功能/);
  assert.doesNotMatch(msg, /微信主窗口当前是空白或不可读/);
});

test('搜索框缺失但窗口有可读控件时保留搜索框诊断', () => {
  const msg = friendlyWechatDesktopError(codedError(
    'main_search_field',
    '未找到微信左上角搜索框；窗口诊断=窗口 微信，控件 24，文本片段 聊天 通讯录 收藏',
  ));

  assert.match(msg, /没有找到微信左上角搜索框/);
  assert.match(msg, /搜索框没有被遮挡/);
  assert.doesNotMatch(msg, /微信主窗口当前是空白或不可读/);
});

test('微信主搜索脚本在空白窗口时先失败并返回明确错误码', () => {
  const script = appleScriptForMainSearchCreator('非常姜老板');

  assert.match(script, /vbp_main_window_is_blank/);
  assert.match(script, /"wechat_window_empty"/);
  assert.match(script, /未暴露搜索框/);
});

test('微信错误清洗会过滤 AppleScript 源码长串并限制长度', () => {
  const raw = [
    '微信主窗口当前是空白或不可读，未暴露搜索框；窗口诊断=窗口 微信，控件 0，文本片段 ',
    'my vbp_context_diagnostics(targetProcess)) if (my vbp_accessible_content_count(targetProcess)) < 1 then return my vbp_result(true, "activate_wechat_main_window", "wechat_main_traffic_lights", "微信正文控件不可读") end if end tell end run on vbp_process(stepName) tell application "System Events" repeat with bid in preferredBids',
  ].join('');
  const msg = friendlyWechatDesktopError(codedError('wechat_window_empty', raw));

  assert.match(msg, /微信主窗口当前是空白或不可读/);
  assert.match(msg, /窗口诊断=窗口 微信，控件 0/);
  assert.ok(msg.length <= 360, `message too long: ${msg.length}`);
  assert.doesNotMatch(msg, /tell application/);
  assert.doesNotMatch(msg, /on vbp_/);
  assert.doesNotMatch(msg, /my vbp_/);
  assert.doesNotMatch(msg, /repeat with/);
});

test('parseScriptResult 的旧管道错误也不会透出脚本源码', () => {
  const parsed = parseScriptResult('', 'ERR|wechat_window_empty|main_search|未暴露搜索框；tell application "System Events" to repeat with el in entire contents of targetProcess');

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'wechat_window_empty');
  assert.match(parsed.message, /未暴露搜索框/);
  assert.doesNotMatch(parsed.message, /tell application/);
});

test('sanitizeWechatErrorText 对纯脚本错误返回短文本', () => {
  const text = sanitizeWechatErrorText('tell application "System Events" to set p to first process whose bundle identifier is "com.tencent.xinWeChat"');

  assert.equal(text, '');
});

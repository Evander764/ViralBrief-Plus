import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-desktop-video-'));

const { upsertAccount } = await import('../server/store.js');
const { get, run } = await import('../server/db.js');
const { runWechatDesktopPatrol, __wechatDesktopInternals } = await import('../server/rpa/wechat-desktop.js');

beforeEach(() => {
  run('DELETE FROM contents');
  run('DELETE FROM accounts');
});

function fakeRunner({ failStep = '', profileMethod = 'ax', channelsMethod = 'ax' } = {}) {
  const calls = [];
  const runner = async (step, payload = {}) => {
    calls.push({ step, payload });
    if (failStep === step) {
      return { ok: false, code: step === 'assert_accessibility' ? 'accessibility' : step, message: `${step} failed` };
    }
    const method = step === 'open_profile_entry' ? profileMethod : step === 'open_channels_home' ? channelsMethod : 'ax';
    return { ok: true, method, detail: `${step} ok` };
  };
  runner.calls = calls;
  return runner;
}

test('desktop WeChat patrol opens nickname and saves local review placeholder', async () => {
  const acc = upsertAccount({ platform: 'wechat_channels', nickname: '目标视频号', monitor_enabled: true });
  const runner = fakeRunner();

  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
    now: new Date('2026-06-02T12:00:00Z'),
  });

  assert.equal(result.success, 1);
  assert.equal(result.newItems, 1);
  assert.deepEqual(runner.calls.map((c) => c.step), [
    'assert_accessibility',
    'activate_wechat',
    'open_channels_home',
    'open_profile_entry',
    'open_overview',
    'open_creator',
  ]);
  assert.equal(runner.calls.at(-1).payload.nickname, '目标视频号');

  const item = get('SELECT * FROM contents WHERE account_id = ? AND platform = ?', [acc.id, 'wechat_channels']);
  assert.match(item.url, /^wechat-desktop:\/\/content\//);
  assert.equal(item.content_type, 'video');
  assert.equal(item.metrics_source, 'desktop_agent');
  assert.equal(item.like_count, null);
  assert.equal(item.data_status, 'needs_review');
});

test('desktop WeChat patrol records coordinate fallback evidence', async () => {
  const acc = upsertAccount({ platform: 'wechat_channels', nickname: '坐标兜底号', monitor_enabled: true });
  const runner = fakeRunner({ profileMethod: 'coordinate', channelsMethod: 'coordinate' });

  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
    now: new Date('2026-06-03T12:00:00Z'),
  });

  assert.equal(result.success, 1);
  const item = get('SELECT * FROM contents WHERE account_id = ? AND platform = ?', [acc.id, 'wechat_channels']);
  const evidence = JSON.parse(item.metrics_evidence_json);
  assert.match(evidence.navigation.method, /coordinate/);
});

test('desktop WeChat patrol reports missing Accessibility permission', async () => {
  upsertAccount({ platform: 'wechat_channels', nickname: '权限测试号', monitor_enabled: true });
  const result = await runWechatDesktopPatrol({
    scriptRunner: fakeRunner({ failStep: 'assert_accessibility' }),
    includePatrolledToday: true,
  });

  assert.equal(result.failed, 1);
  assert.match(result.details[0].error, /辅助功能/);
});

test('desktop WeChat patrol reports creator lookup failure', async () => {
  upsertAccount({ platform: 'wechat_channels', nickname: '不存在博主', monitor_enabled: true });
  const result = await runWechatDesktopPatrol({
    scriptRunner: fakeRunner({ failStep: 'open_creator' }),
    includePatrolledToday: true,
  });

  assert.equal(result.failed, 1);
  assert.match(result.details[0].error, /open_creator failed/);
});

test('desktop WeChat AppleScript prefers main WeChat process and has channels coordinate fallback', () => {
  const script = __wechatDesktopInternals.appleScriptForStep('open_channels_home');
  assert.match(script, /if stepName is "assert_accessibility" or stepName is "activate_wechat" or stepName is "open_channels_home"/);
  assert.match(script, /set preferredBids to \{"com\.tencent\.xinWeChat", "com\.tencent\.flue\.WeChatAppEx"\}/);
  assert.match(script, /vbp_click_channels_sidebar/);
  assert.match(script, /已使用左侧栏坐标兜底/);
  assert.doesNotMatch(script, /\bcontainer\b/);
});

test('desktop WeChat AppleScript prefers AppEx after entering channels', () => {
  const script = __wechatDesktopInternals.appleScriptForStep('open_profile_entry');
  assert.match(script, /set preferredBids to \{"com\.tencent\.flue\.WeChatAppEx", "com\.tencent\.xinWeChat"\}/);
});

test('desktop WeChat friendly error keeps non-permission System Events failures specific', () => {
  const msg = __wechatDesktopInternals.friendlyWechatDesktopError(
    new Error('System Events got an error: 未找到桌面微信视频号入口'),
  );
  assert.match(msg, /台前调度/);
  assert.doesNotMatch(msg, /辅助功能/);
});

test('desktop WeChat parser surfaces osascript failure message', () => {
  const parsed = __wechatDesktopInternals.parseScriptResult('', 'ERROR|open_channels_home||未找到桌面微信视频号入口');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'open_channels_home');
  assert.equal(parsed.message, '未找到桌面微信视频号入口');
});

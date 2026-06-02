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

const pngDataUrl = `data:image/png;base64,${Buffer.from('fakepng').toString('base64')}`;

function sampleCollectedVideos(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    title: `最新视频${i + 1}`,
    bodyExcerpt: `完整文案 ${i + 1}\n展开后的全部内容`,
    like: String(101 + i),
    share: String(201 + i),
    favorite: String(301 + i),
    comment: String(401 + i),
    screenshotData: pngDataUrl,
    metricPositions: {
      like: 'right-bottom-like',
      share: 'right-bottom-share',
      favorite: 'right-bottom-favorite',
      comment: 'right-bottom-comment',
    },
  }));
}

function fakeRunner({ failStep = '', collectItems = sampleCollectedVideos(), methods = {} } = {}) {
  const calls = [];
  const runner = async (step, payload = {}) => {
    calls.push({ step, payload });
    if (failStep === step) {
      return { ok: false, code: step === 'assert_accessibility' ? 'accessibility' : step, message: `${step} failed` };
    }
    if (step === 'collect_latest_videos') {
      return { ok: true, code: step, method: 'video_detail_sequence', detail: 'collected latest videos', items: collectItems };
    }
    return { ok: true, code: step, method: methods[step] || 'ax', detail: `${step} ok` };
  };
  runner.calls = calls;
  return runner;
}

test('desktop WeChat patrol enters following overview once, opens nickname, and saves latest three videos', async () => {
  const acc = upsertAccount({ platform: 'wechat_channels', nickname: '目标视频号', monitor_enabled: true });
  const runner = fakeRunner();

  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
    now: new Date('2026-06-02T12:00:00Z'),
  });

  assert.equal(result.success, 1);
  assert.equal(result.newItems, 3);
  assert.equal(result.maxVideosPerAccount, 3);
  assert.deepEqual(runner.calls.map((c) => c.step), [
    'assert_accessibility',
    'activate_wechat',
    'open_channels_home',
    'open_profile_entry',
    'open_overview',
    'open_following_overview',
    'cleanup_autoplay_tabs',
    'open_creator',
    'collect_latest_videos',
    'close_creator_tabs',
    'close_channels_tabs',
  ]);
  assert.equal(runner.calls.find((c) => c.step === 'cleanup_autoplay_tabs').payload.keepTabTitle, '关注');
  assert.equal(runner.calls.find((c) => c.step === 'open_creator').payload.nickname, '目标视频号');
  assert.equal(runner.calls.find((c) => c.step === 'collect_latest_videos').payload.count, 3);

  const rows = await import('../server/db.js').then(({ all }) => all('SELECT * FROM contents WHERE account_id = ? AND platform = ? ORDER BY title', [acc.id, 'wechat_channels']));
  assert.equal(rows.length, 3);
  const item = rows[0];
  assert.match(item.url, /^wechat-desktop:\/\/content\//);
  assert.equal(item.content_type, 'video');
  assert.equal(item.metrics_source, 'desktop_agent');
  assert.equal(item.user_confirmed, 0);
  assert.equal(item.like_count, 101);
  assert.equal(item.share_count, 201);
  assert.equal(item.favorite_count, 301);
  assert.equal(item.comment_count, 401);
  assert.match(item.body_excerpt, /展开后的全部内容/);
  assert.match(item.screenshot_path, /^screenshots\/rpa_wechat_channels_/);
  assert.equal(item.data_status, 'needs_review');
  const evidence = JSON.parse(item.metrics_evidence_json);
  assert.equal(evidence.share.label, '转发');
  assert.equal(evidence.favorite.label, '收藏/红心');
  assert.equal(evidence.favorite.position, 'right-bottom-favorite');
  assert.match(evidence.navigation.method, /open_channels_home|ax/);
});

test('desktop WeChat patrol respects custom maxVideosPerAccount clamp', async () => {
  upsertAccount({ platform: 'wechat_channels', nickname: '只读两条', monitor_enabled: true });
  const runner = fakeRunner({ collectItems: sampleCollectedVideos(5) });

  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
    maxVideosPerAccount: 2,
  });

  assert.equal(result.success, 1);
  assert.equal(result.newItems, 2);
  assert.equal(result.maxVideosPerAccount, 2);
  assert.equal(runner.calls.find((c) => c.step === 'collect_latest_videos').payload.count, 2);
});

test('desktop WeChat patrol records fixed-coordinate and protected-tab evidence', async () => {
  const acc = upsertAccount({ platform: 'wechat_channels', nickname: '坐标号', monitor_enabled: true });
  const runner = fakeRunner({
    methods: {
      open_channels_home: 'fixed_coordinate',
      cleanup_autoplay_tabs: 'protect_following_tab',
      open_following_overview: 'left_sidebar_only',
    },
  });

  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
    now: new Date('2026-06-03T12:00:00Z'),
  });

  assert.equal(result.success, 1);
  const item = get('SELECT * FROM contents WHERE account_id = ? AND platform = ?', [acc.id, 'wechat_channels']);
  const evidence = JSON.parse(item.metrics_evidence_json);
  assert.match(evidence.navigation.method, /fixed_coordinate/);
  assert.match(evidence.navigation.method, /protect_following_tab/);
  assert.match(evidence.navigation.method, /left_sidebar_only/);
});

test('desktop WeChat patrol reports missing Accessibility permission during setup', async () => {
  upsertAccount({ platform: 'wechat_channels', nickname: '权限测试号', monitor_enabled: true });
  const result = await runWechatDesktopPatrol({
    scriptRunner: fakeRunner({ failStep: 'assert_accessibility' }),
    includePatrolledToday: true,
  });

  assert.equal(result.failed, 1);
  assert.match(result.details[0].error, /辅助功能/);
});

test('desktop WeChat patrol reports creator lookup failure and keeps cleanup stop-safe', async () => {
  upsertAccount({ platform: 'wechat_channels', nickname: '不存在博主', monitor_enabled: true });
  const runner = fakeRunner({ failStep: 'open_creator' });
  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
  });

  assert.equal(result.failed, 1);
  assert.match(result.details[0].error, /open_creator failed/);
  assert.equal(runner.calls.at(-2).step, 'close_creator_tabs');
  assert.equal(runner.calls.at(-1).step, 'close_channels_tabs');
});

test('desktop WeChat patrol fails when latest videos cannot be collected', async () => {
  upsertAccount({ platform: 'wechat_channels', nickname: '空视频号', monitor_enabled: true });
  const result = await runWechatDesktopPatrol({
    scriptRunner: fakeRunner({ collectItems: [] }),
    includePatrolledToday: true,
  });

  assert.equal(result.failed, 1);
  assert.match(result.details[0].error, /未采集到微信视频号最新视频数据/);
});

test('desktop WeChat patrol does not mark account patrolled when stopped after opening creator', async () => {
  const acc = upsertAccount({ platform: 'wechat_channels', nickname: '停止号', monitor_enabled: true });
  const runner = fakeRunner();
  let stop = false;
  const wrappedRunner = async (step, payload) => {
    const r = await runner(step, payload);
    if (step === 'open_creator') stop = true;
    return r;
  };
  wrappedRunner.calls = runner.calls;

  const result = await runWechatDesktopPatrol({
    scriptRunner: wrappedRunner,
    includePatrolledToday: true,
    shouldStop: () => stop,
  });

  assert.equal(result.stopped, true);
  assert.equal(result.success, 0);
  assert.equal(result.newItems, 0);
  const saved = get('SELECT last_patrolled_at FROM accounts WHERE id = ?', [acc.id]);
  assert.equal(saved.last_patrolled_at, null);
});

test('desktop WeChat parser accepts structured JSON result with long text delimiters', () => {
  const parsed = __wechatDesktopInternals.parseScriptResult(
    JSON.stringify({
      ok: true,
      code: 'collect_latest_videos',
      method: 'video_detail_sequence',
      detail: '文案里有 | 也能保留',
      items: [{ title: '标题|带分隔符', like: '1.2万' }],
    }),
    '',
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items[0].title, '标题|带分隔符');
  assert.equal(parsed.detail, '文案里有 | 也能保留');
});

test('desktop WeChat AppleScript uses fixed channels icon, profile-first following, and protected tabs', () => {
  const accessibilityScript = __wechatDesktopInternals.appleScriptForStep('assert_accessibility');
  assert.match(accessibilityScript, /vbp_recover_blank_wechat_window/);
  assert.match(accessibilityScript, /桌面微信没有可用窗口；已尝试从 Dock 微信图标中心和重启微信恢复/);

  const channelsScript = __wechatDesktopInternals.appleScriptForStep('open_channels_home');
  assert.match(channelsScript, /vbp_click_channels_sidebar_fixed/);
  assert.match(channelsScript, /已精准点击左侧视频号小图标中心/);
  assert.match(channelsScript, /vbp_recover_blank_wechat_window/);
  assert.match(channelsScript, /vbp_click_wechat_dock_icon_center/);
  assert.match(channelsScript, /vbp_window_looks_preferences/);
  assert.match(channelsScript, /vbp_close_preferences_window/);
  assert.match(channelsScript, /dock_center/);
  assert.doesNotMatch(channelsScript, /repeat with offsetY/);
  assert.doesNotMatch(channelsScript, /Feishu|飞书/);

  const profileScript = __wechatDesktopInternals.appleScriptForStep('open_profile_entry');
  assert.match(profileScript, /vbp_click_profile_entry/);
  assert.match(profileScript, /右上角小人入口/);

  const followingScript = __wechatDesktopInternals.appleScriptForStep('open_following_overview');
  assert.match(followingScript, /vbp_click_left_following/);
  assert.match(followingScript, /避免误点顶部关注/);
  assert.match(followingScript, /0\.28/);

  const cleanupScript = __wechatDesktopInternals.appleScriptForStep('cleanup_autoplay_tabs', { keepTabTitle: '关注' });
  assert.match(cleanupScript, /vbp_cleanup_autoplay_tabs/);
  assert.match(cleanupScript, /protect_following_tab/);
  assert.match(cleanupScript, /keepTitle/);
  assert.match(cleanupScript, /label is not "关闭"/);
});

test('desktop WeChat AppleScript collection skips pinned, expands text, maps metrics, and uses next arrow', () => {
  const script = __wechatDesktopInternals.appleScriptForStep('collect_latest_videos', { count: 3 });
  assert.match(script, /vbp_open_first_non_pinned_video/);
  assert.match(script, /label does not contain "置顶"/);
  assert.match(script, /vbp_click_expand_if_present/);
  assert.match(script, /vbp_click_next_video_arrow/);
  assert.match(script, /\\"like\\"/);
  assert.match(script, /\\"share\\"/);
  assert.match(script, /\\"favorite\\"/);
  assert.match(script, /\\"comment\\"/);
});

test('desktop WeChat screenshot fallback uses WeChat full screenshot shortcut only after three standard attempts', () => {
  assert.equal(__wechatDesktopInternals.WECHAT_SCREENSHOT_STANDARD_ATTEMPTS, 3);
  const script = __wechatDesktopInternals.wechatScreenshotShortcutScript('/tmp/vbp-wechat-shortcut.png');
  const selectionScript = __wechatDesktopInternals.wechatScreenshotSelectionSwiftScript();
  assert.match(script, /keystroke "a" using \{control down, command down\}/);
  assert.match(script, /the clipboard as «class PNGf»/);
  assert.match(script, /write pngData to outFile/);
  assert.match(selectionScript, /leftMouseDragged/);
  assert.match(selectionScript, /virtualKey: 36/);
});

test('desktop WeChat friendly errors distinguish left-sidebar following from top following', () => {
  const msg = __wechatDesktopInternals.friendlyWechatDesktopError(
    Object.assign(new Error('未找到左侧关注，避免误点顶部关注'), { code: 'open_following_overview' }),
  );
  assert.match(msg, /左侧“关注”/);
  assert.match(msg, /不是顶部视频流/);
});

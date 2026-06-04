import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-desktop-video-'));

const { upsertAccount } = await import('../server/store.js');
const { get, run } = await import('../server/db.js');
const { runWechatDesktopPatrol, __wechatDesktopInternals } = await import('../server/rpa/wechat-desktop.js');
const {
  parseTrafficLightOutput,
  leftRailRegionFromAnchors,
  locateChannelsIconByCode,
  applyBadgesToCards,
  autoplayTabClosePlanFromAnchors,
  chooseAutoplayClosePlanFromCandidates,
  chooseCreatorCandidate,
  chooseCreatorSearchHighlightPointFromRects,
  chooseFirstNonPinnedVideoCard,
  chooseFollowingSidebarPointFromRows,
  chooseNextVideoArrowCandidate,
  channelsLightPageNeedsRailConfirmation,
  followingSidebarPointFromAnchors,
  profileEntryPointFromAnchors,
  validateAutoplayTabClosePlan,
  validateChannelsLightPageScreenshotMetrics,
  validateChannelsWindowFullScreenshotMetrics,
  validateFollowingSidebarPoint,
  validateProfileEntryPoint,
} = await import('../server/rpa/wechat-locator.js');

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
  const failSteps = new Set(Array.isArray(failStep) ? failStep : [failStep].filter(Boolean));
  const runner = async (step, payload = {}) => {
    calls.push({ step, payload });
    if (failSteps.has(step)) {
      return { ok: false, code: step === 'assert_accessibility' ? 'accessibility' : step, message: `${step} failed` };
    }
    if (step === 'collect_current_video') {
      const item = collectItems[(payload.index || 1) - 1];
      return item
        ? { ok: true, code: step, method: 'current_video', detail: 'collected current', items: [item] }
        : { ok: false, code: step, message: 'no current video' };
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
    'activate_wechat_main_window',
    'open_channels_from_main',
    'activate_existing_channels',
    'open_profile_entry',
    'open_overview',
    'open_following_overview',
    'cleanup_autoplay_tabs',
    'open_creator_by_following_scroll',
    'open_first_non_pinned_video_by_screenshot',
    'collect_current_video',
    'go_next_video_by_screenshot',
    'collect_current_video',
    'go_next_video_by_screenshot',
    'collect_current_video',
    'close_creator_with_command_w',
    'close_channels_tabs',
  ]);
  assert.equal(runner.calls.find((c) => c.step === 'cleanup_autoplay_tabs').payload.keepTabTitle, '关注');
  assert.equal(runner.calls.find((c) => c.step === 'activate_wechat_main_window').payload.nickname, undefined);
  assert.equal(runner.calls.find((c) => c.step === 'open_channels_from_main').payload.nickname, undefined);
  assert.equal(runner.calls.find((c) => c.step === 'activate_existing_channels').payload.nickname, undefined);
  assert.equal(runner.calls.find((c) => c.step === 'open_creator_by_following_scroll').payload.nickname, '目标视频号');
  assert.deepEqual(runner.calls.filter((c) => c.step === 'collect_current_video').map((c) => c.payload.index), [1, 2, 3]);

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
  assert.equal(new Set(rows.map((row) => row.screenshot_path)).size, 3);
  const evidence = JSON.parse(item.metrics_evidence_json);
  assert.equal(evidence.share.label, '转发');
  assert.equal(evidence.favorite.label, '收藏/红心');
  assert.equal(evidence.favorite.position, 'right-bottom-favorite');
  assert.match(evidence.navigation.method, /wechat_main|wechat_main_sidebar|ax/);
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
  assert.equal(runner.calls.filter((c) => c.step === 'collect_current_video').length, 2);
});

test('desktop WeChat patrol records main-window, screenshot locator and protected-tab evidence', async () => {
  const acc = upsertAccount({ platform: 'wechat_channels', nickname: '坐标号', monitor_enabled: true });
  const runner = fakeRunner({
    methods: {
      activate_wechat_main_window: 'wechat_main',
      open_channels_from_main: 'wechat_main_sidebar',
      activate_existing_channels: 'channels_dock_window',
      cleanup_autoplay_tabs: 'protect_following_tab',
      open_following_overview: 'left_sidebar_only',
      open_creator_by_following_scroll: 'following_scroll_locator',
      open_first_non_pinned_video_by_screenshot: 'creator_grid_screenshot',
      go_next_video_by_screenshot: 'right_arrow_screenshot',
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
  assert.match(evidence.navigation.method, /wechat_main/);
  assert.match(evidence.navigation.method, /wechat_main_sidebar/);
  assert.match(evidence.navigation.method, /channels_dock_window/);
  assert.match(evidence.navigation.method, /protect_following_tab/);
  assert.match(evidence.navigation.method, /left_sidebar_only/);
  assert.equal(evidence.locator.source, 'system_screenshot_code');
  assert.match(evidence.locator.steps.map((step) => step.method).join('|'), /creator_grid_screenshot|right_arrow_screenshot/);
});

test('desktop WeChat patrol falls back to the Channels Dock icon when main entry fails', async () => {
  upsertAccount({ platform: 'wechat_channels', nickname: '兜底号', monitor_enabled: true });
  const runner = fakeRunner({
    failStep: 'open_channels_from_main',
    methods: {
      activate_wechat_main_window: 'wechat_main',
      activate_channels_dock_icon: 'dock_icon',
      activate_existing_channels: 'channels_dock_window',
    },
  });

  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
  });

  assert.equal(result.success, 1);
  assert.deepEqual(runner.calls.slice(0, 5).map((c) => c.step), [
    'assert_accessibility',
    'activate_wechat_main_window',
    'open_channels_from_main',
    'activate_channels_dock_icon',
    'activate_existing_channels',
  ]);
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
  const runner = fakeRunner({ failStep: 'open_creator_by_following_scroll' });
  const result = await runWechatDesktopPatrol({
    scriptRunner: runner,
    includePatrolledToday: true,
  });

  assert.equal(result.failed, 1);
  assert.match(result.details[0].error, /open_creator_by_following_scroll failed/);
  assert.equal(runner.calls.at(-2).step, 'close_creator_with_command_w');
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
    if (step === 'open_creator_by_following_scroll') stop = true;
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
      code: 'collect_current_video',
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

test('desktop WeChat locator reads traffic-light anchors by role and targets the butterfly Channels icon', async () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信|257|62|1201|768|0',
    'BUTTON|zoom|全屏幕按钮|297|69|18|18',
    'BUTTON|close|关闭按钮|261|69|18|18',
    'BUTTON|minimize|最小化按钮|279|69|18|18',
  ].join('\n'));

  assert.equal(anchors.ok, true);
  assert.equal(Math.round(anchors.buttons.close.centerX), 270);
  assert.equal(Math.round(anchors.buttons.minimize.centerX), 288);
  assert.equal(Math.round(anchors.buttons.zoom.centerX), 306);

  const region = leftRailRegionFromAnchors(anchors);
  assert.equal(region.x, 257);
  assert.equal(region.y, 62);
  assert.ok(region.width >= 108 && region.width <= 142);

  const located = await locateChannelsIconByCode({
    anchors,
    clusters: [
      { centerX: 60, centerY: 215, width: 44, height: 38 },
      { centerX: 61, centerY: 326, width: 43, height: 44 },
      { centerX: 60, centerY: 438, width: 45, height: 45 },
      { centerX: 60, centerY: 550, width: 48, height: 48 },
      { centerX: 60, centerY: 662, width: 52, height: 46 },
      { centerX: 60, centerY: 773, width: 46, height: 46 },
    ],
  });

  assert.equal(located.ok, true);
  assert.equal(located.method, 'traffic_light_left_rail');
  assert.equal(located.x, 317);
  assert.equal(located.y, 612);
  assert.ok(located.confidence >= 0.72);
  assert.match(located.diagnostics, /蝴蝶形视频号图标/);
});

test('desktop WeChat code picker skips pinned creator videos and chooses the first normal card', () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信视频号|111|75|1826|974|0',
    'BUTTON|close|关闭按钮|154|102|18|18',
    'BUTTON|minimize|最小化按钮|194|102|18|18',
    'BUTTON|zoom|全屏幕按钮|234|102|18|18',
  ].join('\n'));

  const picked = chooseFirstNonPinnedVideoCard([
    { x: 430, y: 420, width: 188, height: 250, pinned: true, confidence: 0.92 },
    { x: 650, y: 420, width: 188, height: 250, label: '置顶', confidence: 0.92 },
    { x: 870, y: 420, width: 188, height: 250, label: '直播', confidence: 0.92 },
    { x: 430, y: 710, width: 188, height: 250, confidence: 0.88 },
  ], anchors);

  assert.equal(picked.ok, true);
  assert.equal(picked.x, 430);
  assert.equal(picked.y, 665);
  assert.equal(picked.skippedPinned, 2);
  assert.equal(picked.skippedBlocked, 1);
  assert.match(picked.detail, /creator_grid_card/);
  assert.match(picked.detail, /click=430,665/);
});

test('desktop WeChat code picker refuses uncertain creator video cards instead of clicking fallback coordinates', () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信视频号|111|75|1826|974|0',
    'BUTTON|close|关闭按钮|154|102|18|18',
    'BUTTON|minimize|最小化按钮|194|102|18|18',
    'BUTTON|zoom|全屏幕按钮|234|102|18|18',
  ].join('\n'));

  const picked = chooseFirstNonPinnedVideoCard([
    { x: 430, y: 420, width: 188, height: 250, pinned: true, confidence: 0.92 },
    { x: 650, y: 420, width: 188, height: 250, confidence: 0.41 },
  ], anchors);

  assert.equal(picked.ok, false);
  assert.match(picked.reason, /未识别到高置信非置顶视频卡片/);
});

test('desktop WeChat code picker targets the right-side down arrow from screenshot candidates', () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信视频号|111|75|1826|974|0',
    'BUTTON|close|关闭按钮|154|102|18|18',
    'BUTTON|minimize|最小化按钮|194|102|18|18',
    'BUTTON|zoom|全屏幕按钮|234|102|18|18',
  ].join('\n'));

  const picked = chooseNextVideoArrowCandidate([
    { x: 1500, y: 410, score: 0.4, direction: 'up' },
    { x: 1512, y: 620, score: 0.32, direction: 'down' },
    { x: 400, y: 620, score: 0.8, direction: 'down' },
  ], anchors);

  assert.equal(picked.ok, true);
  assert.equal(picked.x, 1512);
  assert.equal(picked.y, 620);
  assert.match(picked.detail, /right_arrow/);
});

test('desktop WeChat profile and following locator coordinates stay inside safe window regions', () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信|257|62|1201|768|0',
    'BUTTON|zoom|全屏幕按钮|297|69|18|18',
    'BUTTON|close|关闭按钮|261|69|18|18',
    'BUTTON|minimize|最小化按钮|279|69|18|18',
  ].join('\n'));

  const profile = profileEntryPointFromAnchors(anchors);
  assert.equal(validateProfileEntryPoint(profile, anchors), null);
  assert.ok(profile.x > anchors.window.x + anchors.window.width * 0.82);
  assert.ok(profile.y > anchors.window.y + 58);
  assert.match(validateProfileEntryPoint({ x: anchors.window.x + 30, y: anchors.window.y + 44 }, anchors), /横坐标越界/);
  assert.match(validateProfileEntryPoint({ x: profile.x, y: anchors.window.y + 52 }, anchors), /纵坐标越界/);

  const narrowAnchors = parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|339|54|924|796|0',
    'BUTTON|close|关闭按钮|360|67|12|14',
    'BUTTON|minimize|最小化按钮|380|67|12|14',
    'BUTTON|zoom|全屏幕按钮|400|67|12|14',
  ].join('\n'));
  const narrowProfile = profileEntryPointFromAnchors(narrowAnchors);
  assert.equal(validateProfileEntryPoint(narrowProfile, narrowAnchors), null);
  assert.equal(narrowProfile.x, 1238);
  assert.equal(narrowProfile.y, 124);
  assert.ok(narrowProfile.x > narrowAnchors.window.x + narrowAnchors.window.width - 36);

  const following = followingSidebarPointFromAnchors(anchors);
  assert.equal(validateFollowingSidebarPoint(following, anchors), null);
  assert.ok(following.x < anchors.window.x + anchors.window.width * 0.42);
  assert.ok(following.y > anchors.window.y + 120);
  assert.match(validateFollowingSidebarPoint({ x: anchors.window.x + anchors.window.width * 0.7, y: following.y }, anchors), /拒绝点击顶部关注/);

  const overviewAnchors = parseTrafficLightOutput([
    'WINDOW|微信视频号|111|75|1826|974|0',
    'BUTTON|close|关闭按钮|154|102|18|18',
    'BUTTON|minimize|最小化按钮|194|102|18|18',
    'BUTTON|zoom|全屏幕按钮|234|102|18|18',
  ].join('\n'));
  const imageFollowing = followingSidebarPointFromAnchors(overviewAnchors);
  assert.equal(validateFollowingSidebarPoint(imageFollowing, overviewAnchors), null);
  assert.equal(imageFollowing.x, 221);
  assert.equal(imageFollowing.y, 315);
});

test('desktop WeChat autoplay tab cleanup plans hover before close and never targets the Follow tab itself', () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信|257|62|1201|768|0',
    'BUTTON|zoom|全屏幕按钮|297|69|18|18',
    'BUTTON|close|关闭按钮|261|69|18|18',
    'BUTTON|minimize|最小化按钮|279|69|18|18',
  ].join('\n'));

  const plan = autoplayTabClosePlanFromAnchors(anchors);
  assert.equal(validateAutoplayTabClosePlan(plan, anchors), null);
  assert.equal(plan.hoverX, 617);
  assert.equal(plan.closeX, 747);
  assert.ok(plan.closeX > plan.hoverX);
  assert.ok(Math.abs(plan.hoverY - (anchors.window.y + 40)) <= 1);
  assert.match(validateAutoplayTabClosePlan({ hoverX: anchors.window.x + 10, hoverY: plan.hoverY, closeX: plan.closeX, closeY: plan.closeY }, anchors), /悬停点横坐标越界/);

  const imageAnchors = parseTrafficLightOutput([
    'WINDOW|微信视频号|111|75|1826|974|0',
    'BUTTON|close|关闭按钮|154|102|18|18',
    'BUTTON|minimize|最小化按钮|194|102|18|18',
    'BUTTON|zoom|全屏幕按钮|234|102|18|18',
  ].join('\n'));
  const imagePlan = autoplayTabClosePlanFromAnchors(imageAnchors);
  assert.equal(validateAutoplayTabClosePlan(imagePlan, imageAnchors), null);
  assert.equal(imagePlan.hoverX, 659);
  assert.equal(imagePlan.hoverY, 115);
  assert.equal(imagePlan.closeX, 856);
  assert.equal(imagePlan.closeY, 114);
});

test('desktop WeChat screenshot candidate pickers target sidebar Follow and the previous tab close button', () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信视频号|111|75|1826|974|0',
    'BUTTON|close|关闭按钮|154|102|18|18',
    'BUTTON|minimize|最小化按钮|194|102|18|18',
    'BUTTON|zoom|全屏幕按钮|234|102|18|18',
  ].join('\n'));

  const following = chooseFollowingSidebarPointFromRows([
    { centerX: 238, centerY: 221, width: 110, height: 24, darkPixels: 180 },
    { centerX: 229, centerY: 297, width: 96, height: 24, darkPixels: 160 },
    { centerX: 208, centerY: 373, width: 54, height: 24, darkPixels: 100 },
    { centerX: 246, centerY: 448, width: 130, height: 24, darkPixels: 190 },
  ], anchors);
  assert.equal(following.ok, true);
  assert.equal(following.x, 208);
  assert.equal(following.y, 373);
  assert.match(following.detail, /system_screenshot_left_sidebar_following/);
  assert.match(following.detail, /groups=221,297,373,448/);

  const compactFollowing = chooseFollowingSidebarPointFromRows([
    { centerX: 492, centerY: 184, width: 94, height: 20, darkPixels: 170 },
    { centerX: 490, centerY: 222, width: 82, height: 19, darkPixels: 150 },
    { centerX: 488, centerY: 259, width: 48, height: 19, darkPixels: 120 },
  ], parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|418|72|924|796|0',
    'BUTTON|close|关闭按钮|437|85|16|16',
    'BUTTON|minimize|最小化按钮|457|85|16|16',
    'BUTTON|zoom|全屏幕按钮|477|85|16|16',
  ].join('\n')));
  assert.equal(compactFollowing.ok, false);
  assert.match(compactFollowing.reason, /文字组间距异常，拒绝点击/);

  const compactOverviewFollowing = chooseFollowingSidebarPointFromRows([
    { centerX: 497.4, centerY: 174.5, width: 55, height: 13, darkPixels: 1564 },
    { centerX: 496.7, centerY: 212.7, width: 54, height: 13, darkPixels: 875 },
    { centerX: 482.8, centerY: 251.1, width: 26.5, height: 12, darkPixels: 367 },
    { centerX: 503.2, centerY: 288.5, width: 69, height: 13, darkPixels: 1209 },
  ], parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|433|101|925|701|0',
    'BUTTON|close|关闭按钮|454|114|12|14',
    'BUTTON|minimize|最小化按钮|474|114|12|14',
    'BUTTON|zoom|全屏幕按钮|494|114|12|14',
  ].join('\n')));
  assert.equal(compactOverviewFollowing.ok, true);
  assert.equal(compactOverviewFollowing.x, 493);
  assert.equal(compactOverviewFollowing.y, 251);
  assert.match(compactOverviewFollowing.detail, /groups=175,213,251,289/);

  const fourRowsBeatLowGeometryReference = chooseFollowingSidebarPointFromRows([
    { centerX: 498, centerY: 175, width: 55, height: 13, darkPixels: 1564 },
    { centerX: 496, centerY: 213, width: 55, height: 13, darkPixels: 875 },
    { centerX: 483, centerY: 251, width: 27, height: 12, darkPixels: 367 },
    { centerX: 503, centerY: 288, width: 69, height: 13, darkPixels: 1209 },
  ], parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|433|101|925|701|0',
    'BUTTON|close|关闭按钮|454|114|12|14',
    'BUTTON|minimize|最小化按钮|474|114|12|14',
    'BUTTON|zoom|全屏幕按钮|494|114|12|14',
  ].join('\n')));
  assert.equal(fourRowsBeatLowGeometryReference.ok, true);
  assert.equal(fourRowsBeatLowGeometryReference.y, 251);
  assert.match(fourRowsBeatLowGeometryReference.detail, /groups=175,213,251,288/);

  const contentLeakedFollowing = chooseFollowingSidebarPointFromRows([
    { centerX: 330, centerY: 184, width: 92, height: 20, darkPixels: 170 },
    { centerX: 471, centerY: 381, width: 112, height: 18, darkPixels: 160 },
    { centerX: 471, centerY: 405, width: 98, height: 18, darkPixels: 130 },
    { centerX: 471, centerY: 453, width: 104, height: 18, darkPixels: 120 },
  ], parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|221|153|1201|677|0',
    'BUTTON|close|关闭按钮|228|162|12|14',
    'BUTTON|minimize|最小化按钮|248|162|12|14',
    'BUTTON|zoom|全屏幕按钮|268|162|12|14',
  ].join('\n')));
  assert.equal(contentLeakedFollowing.ok, false);
  assert.match(contentLeakedFollowing.reason, /左侧栏文字行不足/);

  const noisyFollowing = chooseFollowingSidebarPointFromRows([
    { centerX: 414, centerY: 171, width: 120, height: 18, darkPixels: 160 },
    { centerX: 420, centerY: 262, width: 82, height: 14, darkPixels: 90 },
    { centerX: 414, centerY: 286, width: 106, height: 14, darkPixels: 120 },
    { centerX: 416, centerY: 334, width: 46, height: 13, darkPixels: 90 },
    { centerX: 412, centerY: 358, width: 62, height: 13, darkPixels: 130 },
    { centerX: 420, centerY: 479, width: 92, height: 14, darkPixels: 100 },
    { centerX: 416, centerY: 502, width: 112, height: 14, darkPixels: 120 },
  ], parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|339|60|924|796|0',
    'BUTTON|close|关闭按钮|360|73|12|14',
    'BUTTON|minimize|最小化按钮|380|73|12|14',
    'BUTTON|zoom|全屏幕按钮|400|73|12|14',
  ].join('\n')));
  assert.equal(noisyFollowing.ok, true);
  assert.equal(noisyFollowing.x, 414);
  assert.ok(noisyFollowing.y >= 344 && noisyFollowing.y <= 348);
  assert.match(noisyFollowing.detail, /groups=171,276,348,479/);

  const closePlan = chooseAutoplayClosePlanFromCandidates([
    { x: 856, y: 114, width: 14, height: 14, score: 0.4 },
    { x: 1296, y: 114, width: 14, height: 14, score: 0.4 },
  ], anchors);
  assert.equal(closePlan.ok, true);
  assert.equal(closePlan.noop, undefined);
  assert.equal(closePlan.closeX, 856);
  assert.equal(closePlan.closeY, 114);
  assert.ok(closePlan.hoverX < closePlan.closeX);
  assert.match(closePlan.detail, /system_screenshot_tab_close/);

  const noExtraTab = chooseAutoplayClosePlanFromCandidates([
    { x: 1296, y: 114, width: 14, height: 14, score: 0.4 },
  ], anchors);
  assert.equal(noExtraTab.ok, true);
  assert.equal(noExtraTab.noop, true);

  const searchHighlight = chooseCreatorSearchHighlightPointFromRects([
    { x: 900, y: 206, width: 80, height: 24, pixels: 160 },
    { x: 850, y: 682, width: 112, height: 24, pixels: 260 },
  ], anchors);
  assert.equal(searchHighlight.ok, true);
  assert.equal(searchHighlight.x, 906);
  assert.equal(searchHighlight.y, 694);
  assert.match(searchHighlight.detail, /find_highlight/);

  const staleTopSearchHighlight = chooseCreatorSearchHighlightPointFromRects([
    { x: 990, y: 121, width: 86, height: 22, pixels: 280 },
  ], anchors);
  assert.equal(staleTopSearchHighlight.ok, false);
  assert.match(staleTopSearchHighlight.reason, /未找到查找高亮候选/);

  const noisyClosePlan = chooseAutoplayClosePlanFromCandidates([
    { x: 552, y: 82, width: 14, height: 14, score: 0.24 },
    { x: 773, y: 82, width: 14, height: 14, score: 0.32 },
    { x: 796, y: 82, width: 14, height: 14, score: 0.36 },
    { x: 807, y: 82, width: 14, height: 14, score: 0.34 },
    { x: 939, y: 81, width: 14, height: 14, score: 0.34 },
    { x: 975, y: 81, width: 14, height: 14, score: 0.32 },
  ], parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|339|60|924|796|0',
    'BUTTON|close|关闭按钮|360|73|12|14',
    'BUTTON|minimize|最小化按钮|380|73|12|14',
    'BUTTON|zoom|全屏幕按钮|400|73|12|14',
  ].join('\n')));
  assert.equal(noisyClosePlan.ok, true);
  assert.equal(noisyClosePlan.closeX, 792);
  assert.match(noisyClosePlan.detail, /groups=552,792,956/);
});

test('desktop WeChat full-system screenshot metrics accept Channels video windows and reject normal chat windows', () => {
  assert.equal(validateChannelsWindowFullScreenshotMetrics({
    bodyTotal: 220000,
    bodyBlackRatio: 0.76,
    bodyDarkRatio: 0.78,
    bodyBrightRatio: 0.14,
    bodyMidRatio: 0.04,
  }), null);
  assert.match(validateChannelsWindowFullScreenshotMetrics({
    bodyTotal: 220000,
    bodyBlackRatio: 0.02,
    bodyDarkRatio: 0.04,
    bodyBrightRatio: 0.82,
    bodyMidRatio: 0.08,
  }), /未检测到视频号黑色视频窗口/);
  assert.match(validateChannelsWindowFullScreenshotMetrics({
    bodyTotal: 200,
    bodyBlackRatio: 0.8,
    bodyDarkRatio: 0.9,
    bodyBrightRatio: 0.02,
    bodyMidRatio: 0.02,
  }), /采样点不足/);
});

test('desktop WeChat full-system screenshot metrics accept bright Channels tab pages', () => {
  assert.equal(validateChannelsLightPageScreenshotMetrics({
    topTotal: 18000,
    topOrangePixels: 130,
    topOrangeClusters: 3,
    bodyTotal: 90000,
    bodyBrightRatio: 0.72,
    bodyDarkRatio: 0.08,
  }), null);
  assert.match(validateChannelsLightPageScreenshotMetrics({
    topTotal: 18000,
    topOrangePixels: 10,
    topOrangeClusters: 0,
    bodyTotal: 90000,
    bodyBrightRatio: 0.72,
    bodyDarkRatio: 0.08,
  }), /未检测到视频号亮色页/);
  assert.match(validateChannelsLightPageScreenshotMetrics({
    topTotal: 18000,
    topOrangePixels: 130,
    topOrangeClusters: 3,
    bodyTotal: 90000,
    bodyBrightRatio: 0.20,
    bodyDarkRatio: 0.52,
  }), /未检测到视频号亮色页/);
  assert.match(validateChannelsLightPageScreenshotMetrics({
    topTotal: 18000,
    topOrangePixels: 1200,
    topOrangeClusters: 2,
    bodyTotal: 90000,
    bodyBrightRatio: 0.72,
    bodyDarkRatio: 0.08,
  }), /橙色面积异常/);
});

test('desktop WeChat bright main window needs left-rail Channels confirmation', () => {
  const normalMain = parseTrafficLightOutput([
    'WINDOW|微信|221|153|1201|677|0',
    'BUTTON|close|关闭按钮|234|169|18|18',
    'BUTTON|minimize|最小化按钮|252|169|18|18',
    'BUTTON|zoom|全屏幕按钮|270|169|18|18',
  ].join('\n'));
  const channelsPopup = parseTrafficLightOutput([
    'WINDOW|微信 (窗口)|433|101|925|701|0',
    'BUTTON|close|关闭按钮|460|121|18|18',
    'BUTTON|minimize|最小化按钮|480|121|18|18',
    'BUTTON|zoom|全屏幕按钮|500|121|18|18',
  ].join('\n'));

  assert.equal(channelsLightPageNeedsRailConfirmation(normalMain), true);
  assert.equal(channelsLightPageNeedsRailConfirmation(channelsPopup), false);
});

test('desktop WeChat AppleScript opens Channels from the main WeChat page before Dock fallback', () => {
  const accessibilityScript = __wechatDesktopInternals.appleScriptForStep('assert_accessibility');
  assert.match(accessibilityScript, /桌面微信没有可用窗口/);
  assert.doesNotMatch(accessibilityScript, /vbp_recover_blank_wechat_window/);
  assert.doesNotMatch(accessibilityScript, /Dock 微信图标中心/);

  const mainScript = __wechatDesktopInternals.appleScriptForStep('activate_wechat_main_window');
  assert.match(mainScript, /com\.tencent\.xinWeChat/);
  assert.match(mainScript, /已激活微信主窗口并确认主页面可读取/);
  assert.match(mainScript, /vbp_has_traffic_light_buttons/);
  assert.match(mainScript, /红黄绿窗口按钮可读/);
  assert.match(mainScript, /wechat_main/);

  const mainEntryScript = __wechatDesktopInternals.appleScriptForStep('open_channels_from_main');
  assert.match(mainEntryScript, /vbp_click_main_channels_entry/);
  assert.match(mainEntryScript, /已从微信主页面进入视频号/);
  assert.match(mainEntryScript, /wechat_main_sidebar/);
  assert.doesNotMatch(mainEntryScript, /\{210, 250, 290, 330\}/);
  assert.doesNotMatch(mainEntryScript, /\+ 34, \(item 2 of wp\) \+ yOffset/);
  assert.doesNotMatch(mainEntryScript, /channels\.weixin/);

  const dockScript = __wechatDesktopInternals.appleScriptForStep('activate_channels_dock_icon');
  assert.match(dockScript, /vbp_click_channels_dock_icon/);
  assert.match(dockScript, /CLICKED\|/);
  assert.match(dockScript, /WeChatAppEx/);
  assert.match(dockScript, /wechatCount > 1/);
  assert.match(dockScript, /rightmostWechatCenterX/);
  assert.match(dockScript, /vbp_click_dock_point/);
  assert.match(dockScript, /Dock点击结果=/);
  assert.match(dockScript, /NO_CLICK\|/);
  assert.match(dockScript, /vbp_dock_diagnostics/);
  assert.match(dockScript, /当前微信窗口已验证为视频号界面/);
  assert.match(dockScript, /当前窗口仍未验证为视频号/);
  assert.doesNotMatch(dockScript, /vbp_click_dock_item_center/);
  assert.doesNotMatch(dockScript, /继续尝试接管窗口/);
  assert.doesNotMatch(dockScript, /open_channels_home/);

  const channelsScript = __wechatDesktopInternals.appleScriptForStep('activate_existing_channels');
  assert.match(channelsScript, /vbp_window_looks_channels/);
  assert.match(channelsScript, /vbp_context_diagnostics/);
  assert.match(channelsScript, /channels_dock_window/);
  assert.match(channelsScript, /已接管并验证微信视频号窗口/);
  assert.match(channelsScript, /绿色的视频号独立窗口图标|当前窗口不是视频号/);
  assert.doesNotMatch(channelsScript, /停留在任意视频或视频号页面/);
  assert.doesNotMatch(channelsScript, /vbp_click_wechat_dock_icon_center/);
  assert.doesNotMatch(channelsScript, /dock_center/);
  assert.doesNotMatch(channelsScript, /Feishu|飞书/);
  assert.throws(() => __wechatDesktopInternals.appleScriptForStep('open_channels_home'), /unknown desktop wechat step/);

  const profileScript = __wechatDesktopInternals.appleScriptForStep('open_profile_entry');
  assert.match(profileScript, /vbp_click_profile_entry/);
  assert.match(profileScript, /vbp_profile_entry_opened/);
  assert.match(profileScript, /没有看到赞和收藏\/个人总览入口/);
  assert.match(profileScript, /右上角小人入口/);

  const overviewScript = __wechatDesktopInternals.appleScriptForStep('open_overview');
  assert.match(overviewScript, /vbp_window_looks_profile_overview/);
  assert.match(overviewScript, /vbp_left_following_candidate_count/);
  assert.match(overviewScript, /未找到赞和收藏\/个人总览入口/);
  assert.doesNotMatch(overviewScript, /未发现需要额外点击的总览入口，继续查找左侧关注/);

  const followingScript = __wechatDesktopInternals.appleScriptForStep('open_following_overview');
  assert.match(followingScript, /vbp_click_left_following/);
  assert.match(followingScript, /vbp_following_diagnostics/);
  assert.match(followingScript, /避免误点顶部关注/);
  assert.match(followingScript, /0\.42/);

  const cleanupScript = __wechatDesktopInternals.appleScriptForStep('cleanup_autoplay_tabs', { keepTabTitle: '关注' });
  assert.match(cleanupScript, /vbp_cleanup_autoplay_tabs/);
  assert.match(cleanupScript, /protect_following_tab/);
  assert.match(cleanupScript, /keepTitle/);
  assert.match(cleanupScript, /label is not "关闭"/);
});

test('desktop WeChat friendly errors prefer the main page and keep the Dock fallback', () => {
  const { friendlyWechatDesktopError } = __wechatDesktopInternals;

  const profileMessage = friendlyWechatDesktopError(
    Object.assign(new Error('未找到视频号右上角人物头像'), { code: 'profile_entry' }),
  );
  assert.match(profileMessage, /当前已进入视频号界面/);
  assert.doesNotMatch(profileMessage, /停留在任意视频/);

  const emptyMessage = friendlyWechatDesktopError(
    Object.assign(new Error('当前微信窗口没有暴露可操作控件'), { code: 'wechat_window_empty' }),
  );
  assert.match(emptyMessage, /微信主窗口已登录/);
  assert.doesNotMatch(emptyMessage, /无法控制桌面微信/);
  assert.doesNotMatch(emptyMessage, /停留在任意视频/);

  const emptyWithPermissionHint = friendlyWechatDesktopError(
    Object.assign(new Error('微信主窗口没有暴露可操作控件；请确认微信主窗口已登录、可见，并允许本应用使用辅助功能'), { code: 'wechat_window_empty' }),
  );
  assert.match(emptyWithPermissionHint, /微信主窗口已登录/);
  assert.doesNotMatch(emptyWithPermissionHint, /无法控制桌面微信/);

  const mainEntryMessage = friendlyWechatDesktopError(
    Object.assign(new Error('未在微信主页面找到视频号入口'), { code: 'main_channels_entry' }),
  );
  assert.match(mainEntryMessage, /微信主页面/);
  assert.match(mainEntryMessage, /独立窗口兜底/);

  const diagnosticMessage = friendlyWechatDesktopError(
    Object.assign(new Error('未找到微信视频号程序坞图标；Dock候选=微信 / Safari；窗口诊断=bundle com.tencent.xinWeChat，窗口 微信'), { code: 'channels_dock_icon' }),
  );
  assert.match(diagnosticMessage, /Dock候选=微信 \/ Safari/);
  assert.match(diagnosticMessage, /窗口诊断=bundle com\.tencent\.xinWeChat/);
});

test('desktop WeChat AppleScript collection only reads current detail text and metrics', () => {
  const script = __wechatDesktopInternals.appleScriptForStep('collect_current_video', { index: 1 });
  assert.match(script, /vbp_click_expand_if_present/);
  assert.match(script, /expandedClicked/);
  assert.match(script, /textSource/);
  assert.match(script, /ax_empty/);
  assert.match(script, /\\"like\\"/);
  assert.match(script, /\\"share\\"/);
  assert.match(script, /\\"favorite\\"/);
  assert.match(script, /\\"comment\\"/);
  assert.throws(() => __wechatDesktopInternals.appleScriptForStep('collect_latest_videos', { count: 3 }), /unknown desktop wechat step/);
  assert.throws(() => __wechatDesktopInternals.appleScriptForStep('open_first_non_pinned_video'), /unknown desktop wechat step/);
  assert.throws(() => __wechatDesktopInternals.appleScriptForStep('go_next_video'), /unknown desktop wechat step/);
});

test('desktop WeChat screenshots use only the system screenshot path', () => {
  assert.equal(__wechatDesktopInternals.WECHAT_SCREENSHOT_STANDARD_ATTEMPTS, 3);
  assert.equal(Object.hasOwn(__wechatDesktopInternals, ['wechatScreenshot', 'ShortcutScript'].join('')), false);
  assert.equal(Object.hasOwn(__wechatDesktopInternals, ['wechatScreenshot', 'SelectionSwiftScript'].join('')), false);
  const source = readFileSync(new URL('../server/rpa/wechat-desktop.js', import.meta.url), 'utf8');
  assert.match(source, /screencapture/);
  assert.doesNotMatch(source, new RegExp(['control', 'command'].join('.+')));
  assert.doesNotMatch(source, new RegExp(['clip', 'board'].join('')));
});

test('desktop WeChat locator source does not use AI or OCR fallbacks', () => {
  const source = [
    readFileSync(new URL('../server/rpa/wechat-locator.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../server/rpa/wechat-desktop.js', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /callJSON/);
  assert.doesNotMatch(source, /vision_left_rail/);
  assert.doesNotMatch(source, /locateChannelsIconByVision/);
  assert.doesNotMatch(source, /\bOCR\b/i);
  assert.match(source, /screencapture/);
  assert.match(source, /CoreGraphics/);
});

test('desktop WeChat locator keeps the Channels window instead of reopening main WeChat', () => {
  const source = readFileSync(new URL('../server/rpa/wechat-locator.js', import.meta.url), 'utf8');
  assert.match(source, /if not preferChannelsWindow then reopen/);
  assert.match(source, /set bestScore to -100000/);
  assert.match(source, /wn contains "窗口"/);
  assert.match(source, /ww < 1100 and wh > 520/);
  assert.match(source, /if bestWindow is not missing value and bestScore > 0 then return bestWindow/);
});

test('desktop WeChat friendly errors distinguish left-sidebar following from top following', () => {
  const msg = __wechatDesktopInternals.friendlyWechatDesktopError(
    Object.assign(new Error('未找到左侧关注，避免误点顶部关注'), { code: 'open_following_overview' }),
  );
  assert.match(msg, /左侧“关注”/);
  assert.match(msg, /不是顶部视频流/);
});

test('desktop WeChat creator picker prefers the name row over bio text', () => {
  const anchors = parseTrafficLightOutput([
    'WINDOW|微信视频号|111|75|1826|974|0',
    'BUTTON|close|关闭按钮|154|102|18|18',
    'BUTTON|minimize|最小化按钮|194|102|18|18',
    'BUTTON|zoom|全屏幕按钮|234|102|18|18',
  ].join('\n'));

  const picked = chooseCreatorCandidate([
    { x: 460, y: 280, width: 500, height: 36, role: 'AXStaticText', label: '这里介绍了目标视频号的简介内容' },
    { x: 420, y: 330, width: 96, height: 24, role: 'AXStaticText', label: '目标视频号' },
  ], { nickname: '目标视频号', anchors });

  assert.equal(picked.ok, true);
  assert.equal(picked.x, 420);
  assert.match(picked.detail, /coverage=1\.00/);

  const rejected = chooseCreatorCandidate([
    { x: 460, y: 280, width: 500, height: 36, role: 'AXStaticText', label: '这里介绍了目标视频号的简介内容' },
  ], { nickname: '目标视频号', anchors });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /拒绝误点/);
});

test('desktop WeChat badge mapping marks pinned creator cards', () => {
  const cards = [
    { x: 420, y: 320, width: 220, height: 160, label: '旧视频' },
    { x: 720, y: 320, width: 220, height: 160, label: '新视频' },
  ];
  const mapped = applyBadgesToCards(cards, [
    { kind: 'pinned', x: 345, y: 255, text: '置顶' },
    { kind: 'blocked', x: 720, y: 318, text: '直播' },
  ]);

  assert.equal(mapped[0].pinned, true);
  assert.match(mapped[0].label, /置顶/);
  assert.equal(mapped[1].blocked, true);
  assert.match(mapped[1].label, /直播/);
});

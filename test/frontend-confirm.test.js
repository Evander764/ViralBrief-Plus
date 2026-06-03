import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();

test('破坏性操作使用页面内确认弹层，不直接依赖浏览器 confirm', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');

  assert.match(appJs, /function askConfirm\(/);
  assert.doesNotMatch(appJs, /if \(!confirm\(/);
  assert.doesNotMatch(appJs, /await confirm\(/);

  for (const id of ['confirmDialog', 'confirmMessage', 'confirmOk', 'confirmCancel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('账号池搜索入口交给本地接口打开 Chrome，不覆盖工作台窗口', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const serverJs = readFileSync(join(root, 'server', 'index.js'), 'utf8');

  assert.match(appJs, /function platformSearchUrl\(/);
  assert.match(appJs, /\/browser\/open/);
  assert.match(appJs, /data-ac-open-url/);
  assert.match(appJs, /dataset\.acOpenUrl/);
  assert.match(appJs, /\/accounts\/open-platform/);
  assert.match(html, /id="acOpenXhsLinks"/);
  assert.match(serverJs, /open-platform/);
  assert.match(serverJs, /accountOpenUrlsForPlatform\(listAccounts\(\), body\.platform \|\| 'xiaohongshu'\)/);
  assert.match(html, /<button[^>]+id="acSearchJump"/);
  assert.doesNotMatch(html, /id="acSearchJump"[^>]+href=/);
  assert.doesNotMatch(appJs, /window\.location\.assign\(/);
  assert.doesNotMatch(appJs, /window\.open\(/);
});

test('概览和每日结果共用设置里的默认回溯天数', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');

  assert.doesNotMatch(html, /id="ovDays"/);
  assert.doesNotMatch(html, /id="rpDays"/);
  assert.doesNotMatch(appJs, /#ovDays/);
  assert.doesNotMatch(appJs, /#rpDays/);
  assert.match(appJs, /function getDefaultWindowType\(\)/);
  assert.match(appJs, /generateReport\(await getDefaultWindowType\(\), \$\('#ovGenMsg'\), skipRpa/);
  assert.match(appJs, /generateReport\(await getDefaultWindowType\(\), \$\('#rpMsg'\), true/);
});

test('每日结果在页面内预览日报，导出文件通过本地接口显示', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const serverJs = readFileSync(join(root, 'server', 'index.js'), 'utf8');
  const swift = readFileSync(join(root, 'scripts', 'LauncherWindow.swift'), 'utf8');

  assert.match(html, /id="rpViewer"/);
  assert.match(html, /id="rpViewerFrame"/);
  assert.match(appJs, /function showReportPreview\(/);
  assert.match(appJs, /data-rp-view/);
  assert.match(appJs, /data-rp-reveal/);
  assert.match(appJs, /\/reveal\?format=/);
  assert.match(serverJs, /p\[2\] === 'reveal'/);
  assert.match(swift, /createWebViewWith configuration/);
  assert.doesNotMatch(appJs, /target="_blank">查看日报/);
});

test('今日候选并入概览，顶部不再有独立候选页入口', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');

  assert.doesNotMatch(html, /data-tab="candidates"/);
  assert.doesNotMatch(html, /id="tab-candidates"/);
  assert.ok(html.indexOf('id="tab-overview"') < html.indexOf('id="candList"'));
  assert.ok(html.indexOf('id="candList"') < html.indexOf('id="tab-library"'));
  assert.match(appJs, /loadOverviewPage/);
  assert.match(appJs, /today=1&include_observations=1/);
  assert.match(html, /北京时间当天抓取记录/);
});

test('今日候选媒体预览优先显示视频截图或小红书封面，并支持中文截图名', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const serverJs = readFileSync(join(root, 'server', 'index.js'), 'utf8');

  assert.match(appJs, /function localScreenshotUrl\(/);
  assert.match(appJs, /encodeURIComponent\(name\)/);
  assert.match(appJs, /function itemMediaSources\(/);
  assert.match(appJs, /it\.platform === 'xiaohongshu'/);
  assert.match(appJs, /it\.content_type === 'video'/);
  assert.match(appJs, /data-fallback-src/);
  assert.match(appJs, /bindMediaFallbacks\(\$\('#candList'\)\)/);
  assert.match(serverJs, /safeUrlBasename\(segs\[1\]\)/);
});

test('巡检默认每轮 6 个标签、每个视频号 3 条，且可在 1-10 间调整', () => {
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const configJs = readFileSync(join(root, 'server', 'config.js'), 'utf8');
  const patrolJs = readFileSync(join(root, 'server', 'rpa', 'patrol.js'), 'utf8');

  assert.match(html, /id="stRpaMaxTabs"[^>]+min="1"[^>]+max="10"[^>]+value="6"/);
  assert.match(html, /id="stWechatVideosPerAccount"[^>]+min="1"[^>]+max="10"[^>]+value="3"/);
  assert.match(html, /默认 6/);
  assert.match(configJs, /rpa: \{ maxTabsPerBatch: 6, wechatVideosPerAccount: 3 \}/);
  assert.match(configJs, /wechatVideosPerAccount/);
  assert.match(configJs, /Math\.min\(10/);
  assert.match(patrolJs, /const DEFAULT_MAX_TABS_PER_BATCH = 6/);
});

test('设置页提供安全存储瘦身入口', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const serverJs = readFileSync(join(root, 'server', 'index.js'), 'utf8');

  assert.match(html, /id="stCleanupStorage"/);
  assert.match(html, /id="stStorageCleanable"/);
  assert.match(appJs, /\/storage\/cleanup/);
  assert.match(appJs, /includeOldScreenshots/);
  assert.match(serverJs, /inspectStorage/);
  assert.match(serverJs, /cleanupStorage/);
});

test('小米 MiMo 预设使用当前 V2.5 模型', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const xiaomiPreset = appJs.match(/xiaomi:\s*\{[^}]+\}/)?.[0] || '';

  assert.match(xiaomiPreset, /https:\/\/api\.xiaomimimo\.com\/v1/);
  assert.match(xiaomiPreset, /mimo-v2\.5-pro/);
  assert.match(xiaomiPreset, /mimo-v2\.5/);
  assert.match(xiaomiPreset, /mimo-v2-flash/);
  assert.doesNotMatch(xiaomiPreset, /mimo-v2-pro/);
});

test('RPA skill 明确要求巡检阶段先保存后筛选', () => {
  const skill = readFileSync(join(root, 'skills', 'rpa-report', 'SKILL.md'), 'utf8');

  assert.match(skill, /巡检阶段不做入选判断/);
  assert.match(skill, /未知时间和超出窗口都保存后待复核或筛选排除/);
  assert.match(skill, /是否入日报只在巡检后的筛选阶段决定/);
});

test('自动巡检前端拆成网页两阶段和微信独立入口，并提供停止按钮', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const serverJs = readFileSync(join(root, 'server', 'index.js'), 'utf8');

  assert.match(appJs, /WEB_PATROL_STAGES/);
  assert.match(appJs, /WECHAT_PATROL_STAGE/);
  assert.match(appJs, /function classifyPatrolSummary/);
  assert.match(appJs, /function patrolFailureDetails/);
  assert.match(appJs, /platform: 'xiaohongshu'/);
  assert.match(appJs, /platform: 'douyin'/);
  assert.match(appJs, /platform: 'wechat_channels'/);
  assert.match(appJs, /includePatrolledToday: true/);
  assert.match(appJs, /ovRunWechatPatrol/);
  assert.match(appJs, /status === 'failed'/);
  assert.match(appJs, /res\.failed/);
  assert.match(appJs, /res\.success/);
  assert.match(appJs, /res\?\.details/);
  assert.match(appJs, /巡检失败，未生成/);
  assert.match(appJs, /ovGenerateWechat/);
  assert.match(appJs, /reportType: 'wechat'/);
  assert.match(appJs, /wechatVideosPerAccount/);
  assert.match(appJs, /\/patrol\/stop/);
  assert.match(serverJs, /requestPatrolStop/);
  assert.match(serverJs, /runWechatDesktopPatrol/);
  assert.match(serverJs, /chromePlatforms/);
  assert.match(serverJs, /patrolStatus/);
  assert.match(serverJs, /platformComplete: patrolStatus === 'success'/);
  assert.match(serverJs, /maxVideosPerAccount/);
  assert.match(html, /id="ovStopPatrol"/);
  assert.match(html, /id="ovRunWechatPatrol"/);
  assert.match(html, /id="ovGenerateWechat"/);
  assert.match(html, /id="candStopRpa"/);
  assert.match(html, /id="stWechatVideosPerAccount"/);
});

test('前端账号池、内容库和日报列表显示微信日报与公众号文章', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');

  assert.match(appJs, /wechat_article: '公众号文章'/);
  assert.match(appJs, /微信日报/);
  assert.match(appJs, /网页日报/);
  assert.match(html, /value="wechat_article">公众号文章/);
  assert.match(html, /生成微信日报/);
  assert.match(html, /巡检微信视频号/);
});

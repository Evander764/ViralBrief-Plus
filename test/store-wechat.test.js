import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 独立临时数据目录，绝不碰真实 data/。
process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-wechat-'));

const {
  upsertAccount, upsertCapture, confirmContent, getContent,
  listWechatHotspots, getEligible,
} = await import('../server/store.js');
const { windowStartISO } = await import('../server/filter.js');
const { scoreAndSortHotspots } = await import('../server/wechat/score.js');

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

test('公众号采集：阅读量作为一等列标准化入库（10万+ → 100000）', () => {
  upsertAccount({ platform: 'wechat_article', nickname: '树成林Light', monitor_enabled: true });
  const r = upsertCapture({
    url: 'https://mp.weixin.qq.com/s/article-1',
    platform: 'wechat_article', content_type: 'article',
    author_name: '树成林Light', title: '一篇公众号文章',
    metrics_raw: { read: '10万+', like: '1.2k', favorite: '300' },
    metrics_source: 'desktop_agent', publish_time: hoursAgo(3),
  });
  assert.equal(r.duplicate, false);
  const c = getContent(r.id);
  assert.equal(c.read_count, 100000);
  assert.equal(c.like_count, 1200);
  assert.equal(c.favorite_count, 300);
  assert.equal(c.platform, 'wechat_article');
});

test('视频号采集：赞/转发/收藏入库，desktop_agent 不自动达标', () => {
  const r = upsertCapture({
    url: 'https://channels.weixin.qq.com/video-1',
    platform: 'wechat_channels', content_type: 'video',
    author_name: '某视频号', title: '一条视频号',
    metrics_raw: { like: '1500', share: '330', favorite: '90' },
    metrics_source: 'desktop_agent', publish_time: hoursAgo(50),
  });
  const c = getContent(r.id);
  assert.equal(c.like_count, 1500);
  assert.equal(c.share_count, 330);
  assert.equal(c.favorite_count, 90);
  // 视觉来源未确认 → 绝不 confirmed
  assert.notEqual(c.data_status, 'confirmed');
});

test('listWechatHotspots：两平台都在列，可叠加评分排序', () => {
  const rows = listWechatHotspots({ windowStart: windowStartISO('last_7_days') });
  const platforms = new Set(rows.map((r) => r.platform));
  assert.ok(platforms.has('wechat_article'));
  assert.ok(platforms.has('wechat_channels'));
  const scored = scoreAndSortHotspots(rows);
  assert.ok(scored.every((r) => r.score && typeof r.score.tier === 'string'));
  // 早窗口高阅读的公众号文章应排在成熟期视频号之前
  assert.equal(scored[0].platform, 'wechat_article');
});

test('不变量 #4：视频号/公众号即便确认也不进正式日报达标清单', () => {
  // 人工确认视频号各项指标（即便达标）
  const r = upsertCapture({
    url: 'https://channels.weixin.qq.com/video-2',
    platform: 'wechat_channels', content_type: 'video',
    author_name: '某视频号', title: '高赞视频号',
    metrics_raw: { like: '5000', share: '5000', favorite: '5000' },
    metrics_source: 'desktop_agent', publish_time: hoursAgo(10),
  });
  confirmContent(r.id, { like_count: 5000, share_count: 5000, favorite_count: 5000 });
  const eligible = getEligible(windowStartISO('last_7_days'));
  assert.equal(eligible.some((c) => c.platform === 'wechat_channels'), false);
});

test('confirmContent 可修正阅读量（read 走同一套确认逻辑）', () => {
  const r = upsertCapture({
    url: 'https://mp.weixin.qq.com/s/article-fix',
    platform: 'wechat_article', content_type: 'article',
    author_name: '树成林Light', title: '待修正阅读量',
    metrics_raw: { like: '200' },
    metrics_source: 'desktop_agent', publish_time: hoursAgo(5),
  });
  const fixed = confirmContent(r.id, { read_count: '3.2万' });
  assert.equal(fixed.read_count, 32000);
});

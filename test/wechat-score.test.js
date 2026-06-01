import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreWechatContent, scoreAndSortHotspots, wechatScoreConfig, ageHoursOf,
  WECHAT_SCORE_DEFAULTS, TIER_RANK,
} from '../server/wechat/score.js';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

test('ageHoursOf：缺时间或非法返回 null，未来时间夹到 0', () => {
  assert.equal(ageHoursOf(null), null);
  assert.equal(ageHoursOf('not-a-date'), null);
  assert.equal(ageHoursOf(hoursAgo(0)) >= 0, true);
  assert.equal(ageHoursOf(new Date(Date.now() + 3_600_000).toISOString()), 0);
});

test('公众号：早窗口内阅读达到早阈值 → early_breakout', () => {
  const r = scoreWechatContent({
    platform: 'wechat_article', publish_time: hoursAgo(3),
    read_count: 6000, like_count: 20,
  });
  assert.equal(r.tier, 'early_breakout');
  assert.equal(r.hot, true);
  assert.equal(r.inEarlyWindow, true);
});

test('公众号：成熟期常规阈值全达标 → qualified', () => {
  const r = scoreWechatContent({
    platform: 'wechat_article', publish_time: hoursAgo(72),
    read_count: 12000, like_count: 300,
  });
  assert.equal(r.tier, 'qualified');
  assert.equal(r.hot, true);
  assert.equal(r.inEarlyWindow, false);
});

test('公众号：成熟期阅读接近达标 → watch；不足 → below', () => {
  const watch = scoreWechatContent({
    platform: 'wechat_article', publish_time: hoursAgo(72),
    read_count: 6000, like_count: 10,
  });
  assert.equal(watch.tier, 'watch');
  const below = scoreWechatContent({
    platform: 'wechat_article', publish_time: hoursAgo(72),
    read_count: 800, like_count: 5,
  });
  assert.equal(below.tier, 'below');
});

test('公众号：阅读/点赞均未知 → unknown（待补录，不当 0）', () => {
  const r = scoreWechatContent({
    platform: 'wechat_article', publish_time: hoursAgo(3),
    read_count: null, like_count: null,
  });
  assert.equal(r.tier, 'unknown');
  assert.equal(r.hot, false);
});

test('视频号：早窗口赞达标 → early_breakout；成熟期赞+收藏达标 → qualified', () => {
  const early = scoreWechatContent({
    platform: 'wechat_channels', publish_time: hoursAgo(5),
    like_count: 1500, favorite_count: 50, share_count: 10,
  });
  assert.equal(early.tier, 'early_breakout');
  const mature = scoreWechatContent({
    platform: 'wechat_channels', publish_time: hoursAgo(80),
    like_count: 3500, favorite_count: 600, share_count: 200,
  });
  assert.equal(mature.tier, 'qualified');
});

test('视频号：发布时间未知 → 退回常规阈值（不奖励速度）', () => {
  const r = scoreWechatContent({
    platform: 'wechat_channels', publish_time: null,
    like_count: 1500, favorite_count: 50,
  });
  // 1500 不到常规 normalLike(3000)，但 >= normalLike*watchRatio(1500) → watch
  assert.equal(r.inEarlyWindow, false);
  assert.equal(r.tier, 'watch');
});

test('wechatScoreConfig：用户配置深合并覆盖默认值', () => {
  const merged = wechatScoreConfig({ wechat: { earlyWindowHours: 6, article: { earlyRead: 1000 } } });
  assert.equal(merged.earlyWindowHours, 6);
  assert.equal(merged.article.earlyRead, 1000);
  assert.equal(merged.article.normalRead, WECHAT_SCORE_DEFAULTS.article.normalRead); // 未覆盖项保留
  assert.equal(merged.channels.normalLike, WECHAT_SCORE_DEFAULTS.channels.normalLike);
});

test('自定义阈值生效：把早阈值调低后命中 early_breakout', () => {
  const cfg = { wechat: { article: { earlyRead: 500 } } };
  const r = scoreWechatContent(
    { platform: 'wechat_article', publish_time: hoursAgo(2), read_count: 800 },
    cfg,
  );
  assert.equal(r.tier, 'early_breakout');
});

test('scoreAndSortHotspots：按热度档位降序排列', () => {
  const rows = [
    { id: 'below', platform: 'wechat_article', publish_time: hoursAgo(72), read_count: 100, captured_at: '2026-06-01T00:00:00Z' },
    { id: 'hot', platform: 'wechat_article', publish_time: hoursAgo(2), read_count: 9000, captured_at: '2026-06-01T00:00:00Z' },
  ];
  const sorted = scoreAndSortHotspots(rows);
  assert.equal(sorted[0].id, 'hot');
  assert.equal(sorted[1].id, 'below');
  assert.equal(sorted[0].score.rank, TIER_RANK.early_breakout);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDataStatus, isEligible, secondMetric } from '../server/filter.js';

const base = { account_id: 'a1', content_type: 'video', user_confirmed: 1, metrics_source: 'manual', publish_time: '2020-01-01T00:00:00Z' };

test('secondMetric 保留兼容辅助：小红书=收藏，抖音/视频号=转发', () => {
  assert.equal(secondMetric('xiaohongshu'), 'favorite');
  assert.equal(secondMetric('douyin'), 'share');
  assert.equal(secondMetric('wechat_channels'), 'share');
  assert.equal(secondMetric('other'), 'share');
});

test('小红书：点赞/收藏/转发任一项 > 1000 即 confirmed', () => {
  assert.equal(computeDataStatus({ ...base, platform: 'xiaohongshu', like_count: 5000, favorite_count: null, share_count: null }), 'confirmed');
  assert.equal(computeDataStatus({ ...base, platform: 'xiaohongshu', like_count: 10, favorite_count: 2000, share_count: null }), 'confirmed');
  assert.equal(computeDataStatus({ ...base, platform: 'xiaohongshu', like_count: 10, favorite_count: 20, share_count: 3000 }), 'confirmed');
});

test('抖音：点赞/收藏/转发任一项 > 1000 即 confirmed', () => {
  assert.equal(computeDataStatus({ ...base, platform: 'douyin', like_count: 5000, share_count: null }), 'confirmed');
  assert.equal(computeDataStatus({ ...base, platform: 'douyin', like_count: 10, share_count: 2000 }), 'confirmed');
  assert.equal(computeDataStatus({ ...base, platform: 'douyin', like_count: 10, share_count: 20, favorite_count: 3000 }), 'confirmed');
});

test('等于 1000 不入选；1000+ 入选', () => {
  assert.equal(computeDataStatus({ ...base, platform: 'douyin', like_count: 1000, share_count: 1000, favorite_count: 1000 }), 'below_threshold');
  assert.equal(computeDataStatus({ ...base, platform: 'douyin', like_count: 1000, like_raw: '1000+' }), 'confirmed');
});

test('小红书与抖音可入选，视频号第一版不入选', () => {
  const xhs = { ...base, platform: 'xiaohongshu', like_count: 1001, data_status: 'confirmed' };
  const dy = { ...base, platform: 'douyin', share_count: 1001, data_status: 'confirmed' };
  const channels = { ...base, platform: 'wechat_channels', share_count: 1001, data_status: 'confirmed' };
  assert.equal(isEligible(xhs), true);
  assert.equal(isEligible(dy), true);
  assert.equal(isEligible(channels), false);
});

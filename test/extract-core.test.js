import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCount, pickMetricsFromObject, pickMetricsFromJsonString, findMetricInText, deriveMetrics,
} from '../extension/extract-core.js';

test('parseCount：单位/逗号/全角/null', () => {
  assert.equal(parseCount('1.2万'), 12000);
  assert.equal(parseCount('1.2w'), 12000);
  assert.equal(parseCount('12,300'), 12300);
  assert.equal(parseCount('1000+'), 1000);
  assert.equal(parseCount('１２３４'), 1234);
  assert.equal(parseCount(8500), 8500);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('暂无'), null);
  assert.equal(parseCount(null), null);
});

test('pickMetricsFromObject：抖音风格嵌套 stats（diggCount/shareCount…）', () => {
  const douyin = {
    aweme: { statistics: { diggCount: 123000, shareCount: 4500, commentCount: 8900, collectCount: 6700, playCount: 9999999 } },
  };
  const r = pickMetricsFromObject(douyin);
  assert.equal(r.like, 123000);
  assert.equal(r.share, 4500);
  assert.equal(r.comment, 8900);
  assert.equal(r.favorite, 6700);
  // playCount 不该被误当作任何核心指标
});

test('pickMetricsFromObject：小红书风格 interactInfo（liked_count/shared_count 为字符串）', () => {
  const xhs = {
    note: { interactInfo: { liked_count: '2.3万', collected_count: '8901', comment_count: '1200', shared_count: '3400' } },
  };
  const r = pickMetricsFromObject(xhs);
  assert.equal(r.like, 23000);
  assert.equal(r.favorite, 8901);
  assert.equal(r.comment, 1200);
  assert.equal(r.share, 3400);
});

test('pickMetricsFromJsonString：能从 __INITIAL_STATE__ 字符串解析', () => {
  const blob = JSON.stringify({ data: { stats: { likeCount: 5000, share_count: 1500 } } });
  const r = pickMetricsFromJsonString(blob);
  assert.equal(r.like, 5000);
  assert.equal(r.share, 1500);
  // 坏 JSON 不抛错
  assert.deepEqual(pickMetricsFromJsonString('{bad json'), { like: null, share: null, comment: null, favorite: null });
});

test('findMetricInText：关键词在数字前后都能匹配', () => {
  assert.equal(findMetricInText('点赞 1.2万', ['赞', '点赞']), 12000);
  assert.equal(findMetricInText('1.2万赞', ['赞']), 12000);
  assert.equal(findMetricInText('转发 3,400 次', ['转发', '分享']), 3400);
  assert.equal(findMetricInText('没有相关词', ['赞']), null);
});

test('deriveMetrics：优先用结构化数据，DOM/正文兜底（分指标互补）', () => {
  const raw = {
    dataBlobs: [JSON.stringify({ statistics: { diggCount: 99000 } })], // 只给了 like
    domTexts: { share: '2.1万', comment: null, favorite: null, like: null }, // share 来自 DOM
    textSample: '评论 880 收藏 1.5万', // comment/favorite 来自正文
  };
  const m = deriveMetrics(raw);
  assert.equal(m.like, 99000);   // 结构化
  assert.equal(m.share, 21000);  // DOM
  assert.equal(m.comment, 880);  // 正文
  assert.equal(m.favorite, 15000); // 正文
});

test('deriveMetrics：结构化值不被较弱来源覆盖', () => {
  const raw = {
    dataBlobs: [JSON.stringify({ likeCount: 100000 })],
    domTexts: { like: '999' }, // 不该覆盖结构化的 100000
    textSample: '赞 1',
  };
  assert.equal(deriveMetrics(raw).like, 100000);
});

test('deriveMetrics：全空 → 全 null（交给用户手填，绝不瞎填 0）', () => {
  const m = deriveMetrics({ dataBlobs: [], domTexts: {}, textSample: '' });
  assert.deepEqual(m, { like: null, share: null, comment: null, favorite: null });
});

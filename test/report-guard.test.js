/**
 * 日报反幻觉护栏（report-guard）的确定性校验单测。
 * 全部测纯函数，不触网；对应 skills/report-guard 第 6 节。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 导入 report.js 会经 store→db 打开 SQLite，先把数据目录指到临时目录，别碰真实库。
process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-guard-'));

const { collectRealNumbers, findFabricatedNumber, validateReportData, normalizeReportData } =
  await import('../server/ai/report.js');

// 源标题含 "2024"，指标里有 1234 / 5678
const items = [
  { title: '我用2024年的新方法涨粉', like_count: 1234, share_count: 5678, comment_count: 90, favorite_count: 12 },
  { title: '三天逆袭', like_count: 2000, share_count: 1500 },
];

test('collectRealNumbers 收集真实指标 + 源标题数字 + 条数', () => {
  const real = collectRealNumbers(items);
  assert.ok(real.has(1234) && real.has(5678) && real.has(2000) && real.has(1500));
  assert.ok(real.has(2024)); // 源标题里的数字算合法
  assert.ok(real.has(items.length)); // 条数算合法
  assert.ok(!real.has(99999)); // 没出现过的不在集合
});

test('findFabricatedNumber 只揪 ≥1000 且不在合法集合的数字', () => {
  const real = collectRealNumbers(items);
  assert.equal(findFabricatedNumber('可能原因：标题制造焦虑', real), null);
  assert.equal(findFabricatedNumber('2024年的玩法', real), null); // 源标题里有，放行
  assert.equal(findFabricatedNumber('点赞 1,234 的爆款', real), null); // 真实指标，放行
  assert.equal(findFabricatedNumber('月入50000的秘密', real), 50000); // 凭空编造，揪出
});

test('validateReportData 放行干净数据', () => {
  const json = {
    daily_summary: '基于 2 条达标内容的观察：两条都靠强钩子标题。',
    top_topic_clusters: [
      { cluster_name: '逆袭叙事', why_it_spread: '可能原因：制造反差', representative_content_ids: ['C1'], rewrite_titles: ['2024年逆袭新法'] },
    ],
    recommended_actions: ['建议方向：承接成长类课程'],
    data_warnings: [],
  };
  assert.equal(validateReportData(json, { items, isFewShot: true }), null);
});

test('validateReportData 拒绝：编造数字出现在 daily_summary 以外的字段', () => {
  const json = {
    daily_summary: '基于 2 条达标内容的观察。',
    top_topic_clusters: [
      { cluster_name: '逆袭', why_it_spread: '可能原因：这条转发了88888次', representative_content_ids: ['C1'], rewrite_titles: [] },
    ],
    recommended_actions: [],
  };
  const err = validateReportData(json, { items, isFewShot: true });
  assert.match(String(err), /88888/);
});

test('validateReportData 拒绝：rewrite_titles 里塞入原文没有的数字', () => {
  const json = {
    daily_summary: 'x',
    top_topic_clusters: [
      { cluster_name: '逆袭', representative_content_ids: ['C1'], rewrite_titles: ['月入100000的副业'] },
    ],
  };
  assert.match(String(validateReportData(json, { items, isFewShot: true })), /100000/);
});

test('validateReportData 拒绝：引用不存在的编号', () => {
  const json = { daily_summary: 'x', top_topic_clusters: [{ cluster_name: 'a', representative_content_ids: ['C9'] }] };
  assert.match(String(validateReportData(json, { items, isFewShot: true })), /C9/);
});

test('normalizeReportData 确定性补认知前缀，且幂等', () => {
  const json = {
    top_topic_clusters: [
      { cluster_name: 'a', why_it_spread: '标题制造焦虑' }, // 缺前缀
      { cluster_name: 'b', why_it_spread: '可能原因：已带前缀' }, // 已带
    ],
    recommended_actions: ['承接知识付费', '建议方向：做社群'],
  };
  normalizeReportData(json);
  assert.equal(json.top_topic_clusters[0].why_it_spread, '可能原因：标题制造焦虑');
  assert.equal(json.top_topic_clusters[1].why_it_spread, '可能原因：已带前缀'); // 不重复加
  assert.equal(json.recommended_actions[0], '建议方向：承接知识付费');
  assert.equal(json.recommended_actions[1], '建议方向：做社群');
});

test('normalizeReportData 把超过 5 个的改写标题截断到 5', () => {
  const json = { top_topic_clusters: [{ cluster_name: 'a', rewrite_titles: ['1', '2', '3', '4', '5', '6', '7'] }] };
  normalizeReportData(json);
  assert.equal(json.top_topic_clusters[0].rewrite_titles.length, 5);
});

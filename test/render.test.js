import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderHtml, renderCsv, fallbackReportData } from '../server/report/render.js';
import { createZip } from '../server/report/archive.js';

const items = [
  { id: 'a', platform: 'douyin', content_type: 'video', author_name: '王', title: '标题A', url: 'https://d/1', like_count: 12000, share_count: 2100, comment_count: 800, favorite_count: 300, publish_time: '2026-05-29T10:00:00.000Z' },
  { id: 'b', platform: 'xiaohongshu', content_type: 'article', author_name: '李', title: '标题B', url: 'https://x/2', like_count: 5000, share_count: 1500, comment_count: 100, favorite_count: 50, publish_time: '2026-05-28T10:00:00.000Z' },
];
const analyses = { a: { rewrite_titles_json: JSON.stringify(['改A1', '改A2']), extracted_topic: 'AI副业', hook_type: '反常识' } };
const reportData = {
  daily_summary: '核心判断……',
  top_topic_clusters: [{ cluster_name: 'AI副业退潮', why_it_spread: '因为X', representative_content_ids: ['C1'], rewrite_titles: ['复用1', '复用2'] }],
  recommended_actions: ['引流到课程'],
  data_warnings: ['注意Y'],
};
const meta = { windowType: 'last_3_days', reportDate: '2026-05-30', generatedAt: '2026-05-30T08:00:00Z', counts: { confirmed: 2, missing_share: 3 }, model: 'gpt-4o-mini', aiUsed: true };

test('Markdown 里的点赞/转发是来自 items 的精确值（千分位）', () => {
  const md = renderMarkdown(reportData, items, analyses, meta);
  assert.match(md, /12,000/);
  assert.match(md, /2,100/);
  assert.match(md, /达标内容清单/);
  assert.match(md, /AI副业退潮/);
  assert.match(md, /复用1/);
  assert.match(md, /缺转发数 3 条/); // 未入选统计来自 counts
});

test('HTML 含表格与精确数字', () => {
  const html = renderHtml(reportData, items, analyses, meta);
  assert.match(html, /<table>/);
  assert.match(html, /12,000/);
  assert.match(html, /每日爆款选题总结/);
});

test('HTML 防 XSS：标题中的脚本被转义', () => {
  const evil = [{ ...items[0], title: '<script>alert(1)</script>' }];
  const html = renderHtml({ ...reportData, top_topic_clusters: [] }, evil, {}, meta);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('CSV 带 UTF-8 BOM 与表头', () => {
  const csv = renderCsv(items, analyses);
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /平台,作者,标题/);
  assert.match(csv, /12000/);
});

test('0 达标时 fallback 不含母题且提示样本不足', () => {
  const fb = fallbackReportData('last_3_days', { missing_share: 2 });
  assert.equal(fb.top_topic_clusters.length, 0);
  assert.match(fb.daily_summary, /样本不足|不足|暂无/);
  const md = renderMarkdown(fb, [], {}, { ...meta, aiUsed: false });
  assert.match(md, /本期无达标内容|样本不足|暂无/);
});

test('日报压缩包为标准 ZIP，包含多份导出文件', () => {
  const zip = createZip([
    { name: 'report.md', data: renderMarkdown(reportData, items, analyses, meta) },
    { name: 'report.html', data: renderHtml(reportData, items, analyses, meta) },
    { name: 'report.csv', data: renderCsv(items, analyses) },
  ]);
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  assert.match(zip.toString('latin1'), /report\.md/);
  assert.match(zip.toString('latin1'), /report\.html/);
  assert.match(zip.toString('latin1'), /report\.csv/);
});

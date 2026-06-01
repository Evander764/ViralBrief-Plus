import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownTableToCsv,
  markdownToReportHtml,
  materializeReportExport,
  recoveredReportExport,
} from '../server/report/recovery.js';

const markdown = `# 每日爆款选题总结 — 最近 1 天

> 生成时间：2026-06-01T08:00:00.000Z

## 三、达标内容清单（数据来自本地库，精确值）

| # | 平台 | 作者 | 标题 | 点赞 | 转发/分享 | 收藏 | 评论 |
|---|------|------|------|------|-----------|------|------|
| 1 | douyin | 影视飓风 | 手机拍广告片到底差在哪 | 21,800 | 3,200 | 11,700 | 2,100 |
`;

function reportWithMissingFiles() {
  return {
    id: 'report-1',
    report_date: '2026-06-01',
    window_type: 'last_1_days',
    report_markdown: markdown,
    export_md_path: '/missing/report_2026-06-01_last_1_days.md',
    export_html_path: '/missing/report_2026-06-01_last_1_days.html',
    export_csv_path: '/missing/report_2026-06-01_last_1_days.csv',
    export_zip_path: '/missing/report_2026-06-01_last_1_days.zip',
  };
}

test('日报 HTML 可从数据库保存的 Markdown 恢复', () => {
  const html = markdownToReportHtml(markdown, reportWithMissingFiles());

  assert.match(html, /<title>每日爆款选题总结 - 2026-06-01<\/title>/);
  assert.match(html, /<h1>每日爆款选题总结/);
  assert.match(html, /<table>/);
  assert.match(html, /手机拍广告片到底差在哪/);
});

test('日报 CSV 可从 Markdown 达标清单恢复', () => {
  const csv = markdownTableToCsv(markdown);

  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /平台,作者,标题/);
  assert.match(csv, /douyin,影视飓风,手机拍广告片到底差在哪/);
  assert.match(csv, /"21,800"/);
});

test('缺失的日报导出文件会被恢复到当前 exports 目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vbp-report-recovery-'));
  try {
    const htmlPath = materializeReportExport(reportWithMissingFiles(), 'html', { exportsDir: dir });
    const csvPath = materializeReportExport(reportWithMissingFiles(), 'csv', { exportsDir: dir });
    const zipPath = materializeReportExport(reportWithMissingFiles(), 'zip', { exportsDir: dir });

    assert.equal(htmlPath, join(dir, 'report_2026-06-01_last_1_days.html'));
    assert.match(readFileSync(htmlPath, 'utf8'), /此预览由数据库中保存的日报正文恢复/);
    assert.match(readFileSync(csvPath, 'utf8'), /douyin,影视飓风/);
    assert.equal(readFileSync(zipPath).subarray(0, 4).toString('hex'), '504b0304');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有保存 Markdown 的旧记录不能伪造恢复内容', () => {
  assert.equal(recoveredReportExport({ id: 'empty', report_markdown: '' }, 'html'), null);
});

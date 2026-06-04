import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-pipeline-'));

const { runDailyReport } = await import('../server/pipeline.js');
const { getReport, deleteReport } = await import('../server/store.js');

test('runDailyReport 生成 Markdown/HTML/CSV 与压缩包，且 deleteReport 可删除记录', async () => {
  const r = await runDailyReport({ windowType: 'last_1_day', skipRpa: true });
  const report = getReport(r.report.id);

  assert.equal(report.report_type, 'web');
  assert.equal(report.eligible_count, 0);
  assert.ok(existsSync(report.export_md_path));
  assert.ok(existsSync(report.export_html_path));
  assert.ok(existsSync(report.export_csv_path));
  assert.ok(existsSync(report.export_zip_path));
  assert.equal(readFileSync(report.export_zip_path).subarray(0, 4).toString('hex'), '504b0304');

  const deleted = deleteReport(report.id);
  assert.equal(deleted.id, report.id);
  assert.equal(getReport(report.id), undefined);
});

test('pipeline keeps web report RPA isolated from desktop WeChat patrol', () => {
  const pipeline = readFileSync(join(process.cwd(), 'server', 'pipeline.js'), 'utf8');
  const daily = pipeline.slice(
    pipeline.indexOf('export async function runDailyReport'),
    pipeline.indexOf('export async function runWechatReport'),
  );
  const wechat = pipeline.slice(pipeline.indexOf('export async function runWechatReport'));

  assert.doesNotMatch(daily, /runWechatDesktopPatrol\(/);
  assert.match(daily, /platform of \['xiaohongshu', 'douyin'\]/);
  // 视频号桌面巡检已移除：微信日报只基于已确认内容生成，不再触发任何 RPA 巡检。
  assert.doesNotMatch(wechat, /runWechatDesktopPatrol/);
});

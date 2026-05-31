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

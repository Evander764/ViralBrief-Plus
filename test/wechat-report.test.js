import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-wechat-report-'));

const { run } = await import('../server/db.js');
const { runWechatReport } = await import('../server/pipeline.js');
const {
  upsertAccount, upsertCapture, confirmContent, archiveContent, getReport, getWechatReportItems,
} = await import('../server/store.js');

const recent = new Date().toISOString();
const old = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
const windowStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function addWechatContent({ platform, title, author, accountId, publishTime = recent, confirm = true }) {
  const r = upsertCapture({
    platform,
    content_type: platform === 'wechat_channels' ? 'video' : 'article',
    url: `${platform}://test/${encodeURIComponent(title)}`,
    author_name: author,
    title,
    publish_time: publishTime,
    metrics_source: 'page_text',
    account_id: accountId,
  });
  if (confirm) confirmContent(r.id, { account_id: accountId });
  return r.id;
}

test('getWechatReportItems 只返回窗口内已人工确认且关联账号池的微信内容', () => {
  const channelsAccount = upsertAccount({ platform: 'wechat_channels', nickname: '视频号作者', monitor_enabled: true });
  const articleAccount = upsertAccount({ platform: 'wechat_article', nickname: '公众号作者', monitor_enabled: false });

  const channelsId = addWechatContent({
    platform: 'wechat_channels',
    title: '视频号已确认',
    author: '视频号作者',
    accountId: channelsAccount.id,
  });
  const articleId = addWechatContent({
    platform: 'wechat_article',
    title: '公众号已确认',
    author: '公众号作者',
    accountId: articleAccount.id,
  });

  addWechatContent({
    platform: 'wechat_channels',
    title: '未确认视频号',
    author: '视频号作者',
    accountId: channelsAccount.id,
    confirm: false,
  });
  addWechatContent({
    platform: 'wechat_article',
    title: '未关联公众号',
    author: '陌生作者',
    accountId: null,
  });
  const archivedId = addWechatContent({
    platform: 'wechat_article',
    title: '已归档公众号',
    author: '公众号作者',
    accountId: articleAccount.id,
  });
  archiveContent(archivedId);
  const duplicateId = addWechatContent({
    platform: 'wechat_channels',
    title: '重复视频号',
    author: '视频号作者',
    accountId: channelsAccount.id,
  });
  run('UPDATE contents SET is_duplicate = 1 WHERE id = ?', [duplicateId]);
  addWechatContent({
    platform: 'wechat_article',
    title: '窗口外公众号',
    author: '公众号作者',
    accountId: articleAccount.id,
    publishTime: old,
  });

  const rows = getWechatReportItems(windowStart);
  assert.deepEqual(rows.map((r) => r.id).sort(), [articleId, channelsId].sort());
  assert.match(rows.find((r) => r.id === channelsId).eligible_reason, /微信视频号已人工确认/);
  assert.match(rows.find((r) => r.id === articleId).eligible_reason, /公众号文章已人工确认/);
});

test('runWechatReport 生成微信日报导出文件并写入 report_type', async () => {
  run('DELETE FROM contents');
  run('DELETE FROM accounts');
  const r = await runWechatReport({ windowType: 'last_1_day', skipRpa: true });
  const report = getReport(r.report.id);

  assert.equal(report.report_type, 'wechat');
  assert.equal(report.eligible_count, 0);
  assert.ok(report.export_md_path.includes('wechat_report_'));
  assert.ok(existsSync(report.export_md_path));
  assert.ok(existsSync(report.export_html_path));
  assert.ok(existsSync(report.export_csv_path));
  assert.ok(existsSync(report.export_zip_path));
  assert.equal(readFileSync(report.export_zip_path).subarray(0, 4).toString('hex'), '504b0304');
});

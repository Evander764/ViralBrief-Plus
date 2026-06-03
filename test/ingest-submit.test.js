import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-ingest-submit-'));

const { ingestPayload } = await import('../server/ingest/submit.js');
const { getContent, listAccounts, upsertAccount } = await import('../server/store.js');

function extractorForWechatArticles(url) {
  if (url.includes('fetch-fail')) return { ok: false, url, note: '模拟抓取失败' };
  return {
    ok: true,
    url,
    platform: 'wechat_article',
    content_type: 'article',
    title: url.includes('second') ? '第二篇公众号文章' : '第一篇公众号文章',
    author_name: '公众号作者',
    body_excerpt: '公众号正文摘要',
    publish_time: '2026-06-03T00:30:00.000Z',
    metrics_raw: { like: null, share: null, comment: null, favorite: null },
    found: [],
    note: '公众号文章已抓取，互动指标需人工核对。',
  };
}

test('批量导入公众号文章：成功、重复、失败和账号匹配结果同返', async () => {
  const lastPatrolledAt = '2026-06-01T00:00:00.000Z';
  const account = upsertAccount({
    platform: 'wechat_article',
    nickname: '公众号作者',
    monitor_enabled: true,
    last_patrolled_at: lastPatrolledAt,
  });

  const first = await ingestPayload({
    urls: [
      'https://mp.weixin.qq.com/s/first',
      'not-a-url',
      'https://mp.weixin.qq.com/s/fetch-fail',
    ],
  }, { extractor: extractorForWechatArticles });

  assert.equal(first.httpStatus, 200);
  assert.equal(first.body.total, 3);
  assert.equal(first.body.success, 1);
  assert.equal(first.body.duplicates, 0);
  assert.equal(first.body.failed, 2);
  assert.equal(first.body.results[0].ok, true);
  assert.equal(first.body.results[0].accountMatched, true);
  assert.equal(first.body.results[0].account_id, account.id);
  assert.equal(first.body.results[1].ok, false);
  assert.match(first.body.results[1].note, /合法的 http\(s\) 链接/);
  assert.equal(first.body.results[2].ok, false);
  assert.equal(first.body.results[2].note, '模拟抓取失败');

  const content = getContent(first.body.results[0].id);
  assert.equal(content.account_id, account.id);
  assert.equal(content.publish_time, '2026-06-03T00:30:00.000Z');

  const afterFirst = listAccounts().find((a) => a.id === account.id);
  assert.equal(afterFirst.last_seen_url, 'https://mp.weixin.qq.com/s/first');
  assert.equal(afterFirst.last_seen_publish_time, '2026-06-03T00:30:00.000Z');
  assert.equal(afterFirst.last_patrolled_at, lastPatrolledAt);

  const duplicate = await ingestPayload({
    urls: ['https://mp.weixin.qq.com/s/first'],
  }, { extractor: extractorForWechatArticles });

  assert.equal(duplicate.body.total, 1);
  assert.equal(duplicate.body.success, 1);
  assert.equal(duplicate.body.duplicates, 1);
  assert.equal(duplicate.body.failed, 0);
  assert.equal(duplicate.body.results[0].duplicate, true);
  assert.equal(duplicate.body.results[0].accountMatched, true);
});

test('单链接导入接口保持旧返回形状', async () => {
  const result = await ingestPayload(
    { url: 'https://mp.weixin.qq.com/s/second' },
    { extractor: extractorForWechatArticles },
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.platform, 'wechat_article');
  assert.equal(result.body.title, '第二篇公众号文章');
  assert.equal(result.body.duplicate, false);
  assert.ok(!('results' in result.body));
});

test('单链接 URL 非法时仍返回 400', async () => {
  const result = await ingestPayload({ url: 'not-a-url' }, { extractor: extractorForWechatArticles });
  assert.equal(result.httpStatus, 400);
  assert.match(result.body.error, /合法的 http\(s\) 链接/);
});

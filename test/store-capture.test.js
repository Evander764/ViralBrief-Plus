import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 每个测试文件用独立临时数据目录，绝不碰真实 data/。
process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-capture-'));

const {
  upsertAccount, upsertCapture, confirmContent, getContent, importAccountsCsv, importAccountsLines, listAccounts, listContents, markAccountSeen,
} = await import('../server/store.js');
const { run } = await import('../server/db.js');

const recent = () => new Date().toISOString();
const twoDaysAgo = () => new Date(Date.now() - 2 * 86400000).toISOString();

test('采集自动来源未确认 → needs_review（不自动达标）', () => {
  const r = upsertCapture({
    url: 'https://www.douyin.com/video/auto1', platform: 'douyin', content_type: 'video',
    author_name: '某人', title: '自动抓的', metrics_raw: { like: '1.2w', share: '2000' },
    metrics_source: 'page_text', publish_time: twoDaysAgo(),
  });
  assert.equal(r.duplicate, false);
  assert.equal(r.status, 'needs_review');
});

test('RPA 稳定证据可自动入选，并保存指标证据 JSON', () => {
  const acc = upsertAccount({ platform: 'douyin', nickname: '证据账号', monitor_enabled: true });
  const r = upsertCapture({
    url: 'https://www.douyin.com/video/evidence1',
    platform: 'douyin',
    content_type: 'video',
    author_name: '证据账号',
    title: '证据测试',
    metrics_raw: { like: '1000+', share: '1000+', favorite: '1000+' },
    metrics_source: 'rpa',
    metrics_confidence: 'dom',
    metrics_evidence: {
      like: { source: 'dom', raw: '1000+', value: 1000 },
      favorite: { source: 'dom', raw: '1000+', value: 1000 },
      share: { source: 'dom', raw: '1000+', value: 1000 },
    },
    publish_time: twoDaysAgo(),
  });
  const c = getContent(r.id);
  assert.equal(c.account_id, acc.id);
  assert.equal(c.data_status, 'confirmed');
  assert.equal(c.eligible_reason, '点赞 1000+，收藏 1000+，转发/分享 1000+ 均达标');
  assert.deepEqual(JSON.parse(c.metrics_evidence_json).like, { source: 'dom', raw: '1000+', value: 1000 });
});

test('采集时按「平台+昵称」自动关联账号池', () => {
  const acc = upsertAccount({ platform: 'douyin', nickname: '商业老王', category: '商业', priority: 'S' });
  const r = upsertCapture({
    url: 'https://www.douyin.com/video/link1', platform: 'douyin', content_type: 'video',
    author_name: '商业老王', title: '关联测试', metrics_raw: { like: '5000', favorite: '4000', share: '3000' },
    metrics_source: 'manual', publish_time: recent(),
  });
  const c = getContent(r.id);
  assert.equal(c.account_id, acc.id, '应自动关联到同名账号');
  assert.equal(c.data_status, 'confirmed');
});

test('采集按主页链接自动关联（忽略追踪参数）', () => {
  const acc = upsertAccount({
    platform: 'xiaohongshu', nickname: '增长小李', homepage_url: 'https://www.xiaohongshu.com/user/profile/ABC',
    category: '营销', priority: 'A',
  });
  const r = upsertCapture({
    url: 'https://www.xiaohongshu.com/explore/note1', platform: 'xiaohongshu', content_type: 'article',
    author_name: '马甲号名字不同', // 昵称对不上，只能靠主页链接匹配
    account_homepage_url: 'https://www.xiaohongshu.com/user/profile/ABC?utm_source=share', // 追踪参数会被归一化忽略
    title: '主页匹配', metrics_raw: { like: '2000', favorite: '2000' },
    metrics_source: 'manual', publish_time: recent(),
  });
  assert.equal(getContent(r.id).account_id, acc.id);
});

test('公众号导入更新账号 last_seen，不改 last_patrolled_at', () => {
  const lastPatrolledAt = '2026-06-01T00:00:00.000Z';
  const acc = upsertAccount({
    platform: 'wechat_article',
    nickname: '公众号作者',
    monitor_enabled: true,
    last_patrolled_at: lastPatrolledAt,
  });

  const updated = markAccountSeen(acc.id, {
    lastSeenUrl: 'https://mp.weixin.qq.com/s/article-seen',
    lastSeenPublishTime: '2026-06-03T00:30:00.000Z',
  });

  assert.equal(updated.last_seen_url, 'https://mp.weixin.qq.com/s/article-seen');
  assert.equal(updated.last_seen_publish_time, '2026-06-03T00:30:00.000Z');
  assert.equal(updated.last_patrolled_at, lastPatrolledAt);
});

test('重复采集：URL 命中 → 合并补缺，不覆盖已有值', () => {
  const first = upsertCapture({
    url: 'https://www.douyin.com/video/dup', platform: 'douyin', content_type: 'video',
    author_name: '甲', title: '原标题', metrics_raw: { like: '1.5w' }, // 只有点赞
    metrics_source: 'manual', publish_time: recent(),
  });
  const before = getContent(first.id);
  assert.equal(before.like_count, 15000);
  assert.equal(before.share_count, null);

  const second = upsertCapture({
    url: 'https://www.douyin.com/video/dup?from=app', platform: 'douyin',
    author_name: '甲', title: '原标题', metrics_raw: { like: '999', share: '2000' }, // 想改点赞 + 补转发
    metrics_source: 'page_text',
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, 'url');
  const after = getContent(first.id);
  assert.equal(after.like_count, 15000, '已有的点赞不被覆盖');
  assert.equal(after.share_count, 2000, '缺失的转发被补上');
});

test('重复补抓会刷新 captured_at，方便同步进今日候选', () => {
  const first = upsertCapture({
    url: 'https://www.xiaohongshu.com/explore/dup-today-candidate',
    platform: 'xiaohongshu',
    content_type: 'article',
    author_name: '候选刷新',
    title: '候选刷新测试',
    metrics_raw: { like: '1.5w' },
    metrics_source: 'page_text',
    publish_time: recent(),
  });
  const capturedSince = new Date(Date.now() - 60_000).toISOString();
  const inTodayCandidates = (id) => ['needs_review', 'missing_share', 'missing_favorite', 'missing_like', 'below_threshold', 'monitoring']
    .some((status) => listContents({ status, capturedSince }).some((it) => it.id === id));
  run('UPDATE contents SET captured_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', first.id]);
  assert.equal(inTodayCandidates(first.id), false);

  const second = upsertCapture({
    url: 'https://www.xiaohongshu.com/explore/dup-today-candidate?from=share',
    platform: 'xiaohongshu',
    content_type: 'article',
    author_name: '候选刷新',
    title: '候选刷新测试',
    metrics_raw: { favorite: '2000' },
    metrics_source: 'page_text',
    publish_time: recent(),
  });

  assert.equal(second.duplicate, true);
  assert.equal(inTodayCandidates(first.id), true);
});

test('confirmContent 强制 manual + user_confirmed，并重算状态', () => {
  const r = upsertCapture({
    url: 'https://www.douyin.com/video/cf', platform: 'douyin', content_type: 'video',
    author_name: '乙', title: '待确认', metrics_raw: { like: '1.2w', share: '500' },
    metrics_source: 'page_ocr', publish_time: twoDaysAgo(),
  });
  assert.equal(getContent(r.id).data_status, 'needs_review');
  // 用户把收藏和转发都改成达标值
  const c = confirmContent(r.id, { like_count: '1.2w', favorite_count: '2200', share_count: '2100' });
  assert.equal(c.metrics_source, 'manual');
  assert.equal(c.user_confirmed, 1);
  assert.equal(c.like_count, 12000);
  assert.equal(c.favorite_count, 2200);
  assert.equal(c.share_count, 2100);
  assert.equal(c.data_status, 'confirmed');
});

test('importAccountsCsv 导入账号并保留兼容平台', () => {
  const before = listAccounts().length;
  const res = importAccountsCsv(
    'platform,nickname,homepage_url,category,priority,monitor_enabled\n' +
    'douyin,新主播A,https://d/a,商业,S,true\n' +
    'wechat_channels,视频号B,,创业,B,false\n' +
    'xiaohongshu,"带逗号, 的名字",https://x/c,营销,A,1\n',
  );
  assert.equal(res.imported, 3);
  assert.equal(listAccounts().length, before + 3);
  const names = listAccounts().map((a) => a.nickname);
  assert.ok(names.includes('带逗号, 的名字'), 'CSV 引号字段解析正确');
});

test('importAccountsLines 支持手动多行反复导入，重复平台+昵称会更新', () => {
  const before = listAccounts().length;
  const first = importAccountsLines(
    '抖音,手动老王,https://old.example,商业,A,true\n' +
    '小红书,手动小李,,营销,B,true\n',
  );
  assert.equal(first.imported, 2);
  assert.equal(listAccounts().length, before + 2);

  const second = importAccountsLines('douyin,手动老王,https://new.example,创业,S,true');
  assert.equal(second.imported, 1);
  assert.equal(listAccounts().length, before + 2, '重复导入应更新而不是新增重复账号');

  const updated = listAccounts().find((a) => a.platform === 'douyin' && a.nickname === '手动老王');
  assert.equal(updated.homepage_url, 'https://new.example');
  assert.equal(updated.priority, 'S');
});

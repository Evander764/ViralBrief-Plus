import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, contentFingerprint, findDuplicate } from '../server/dedup.js';

test('归一化 URL：去 fragment / 追踪参数 / 末尾斜杠 / 大小写主机', () => {
  assert.equal(
    normalizeUrl('https://WWW.Douyin.com/video/12345/?utm_source=wx&scene=1#comment'),
    'https://www.douyin.com/video/12345',
  );
  assert.equal(
    normalizeUrl('https://www.xiaohongshu.com/explore/abc?xsec_token=keep&share_token=drop'),
    'https://www.xiaohongshu.com/explore/abc?xsec_token=keep',
  );
});

test('同一链接不同追踪参数 → 归一化后一致', () => {
  const a = normalizeUrl('https://www.douyin.com/video/9?from=app&utm_campaign=x');
  const b = normalizeUrl('https://www.douyin.com/video/9?utm_source=y');
  assert.equal(a, b);
});

test('内容指纹对平台+作者+标题大小写/空格不敏感', () => {
  const a = contentFingerprint({ platform: 'Douyin', author_name: ' 张三 ', title: 'AI 副业  退潮' });
  const b = contentFingerprint({ platform: 'douyin', author_name: '张三', title: 'AI 副业 退潮' });
  assert.equal(a, b);
});

test('findDuplicate：URL 命中', () => {
  const existing = { id: 'c1', url_key: 'https://www.douyin.com/video/9', fingerprint: 'fp-x' };
  const lookup = (urlKey) => (urlKey === existing.url_key ? existing : undefined);
  const r = findDuplicate({ url: 'https://www.douyin.com/video/9?from=app', platform: 'douyin', author_name: 'a', title: 't' }, lookup);
  assert.equal(r.duplicate, true);
  assert.equal(r.reason, 'url');
  assert.equal(r.existing.id, 'c1');
});

test('findDuplicate：无命中', () => {
  const r = findDuplicate({ url: 'https://x.com/1', platform: 'p', author_name: 'a', title: 't' }, () => undefined);
  assert.equal(r.duplicate, false);
});

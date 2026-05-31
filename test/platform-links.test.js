import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformSearchUrl, looksLikeRealProfile, withUsableLink } from '../server/lib/platform-links.js';

test('platformSearchUrl：各平台生成可用搜索链接（昵称已编码）', () => {
  assert.equal(platformSearchUrl('douyin', '数字生命卡兹克'), 'https://www.douyin.com/search/%E6%95%B0%E5%AD%97%E7%94%9F%E5%91%BD%E5%8D%A1%E5%85%B9%E5%85%8B?type=user');
  assert.match(platformSearchUrl('xiaohongshu', '老王'), /xiaohongshu\.com\/search_result\?keyword=/);
  assert.match(platformSearchUrl('wechat_channels', '老张'), /google\.com\/search/);
  assert.equal(platformSearchUrl('douyin', ''), '');
});

test('looksLikeRealProfile：真实主页通过，编造/裸域名/异平台不通过', () => {
  // 真实样式：带 user/profile 路径或长 ID
  assert.equal(looksLikeRealProfile('douyin', 'https://www.douyin.com/user/MS4wLjABAAAAxyz123'), true);
  assert.equal(looksLikeRealProfile('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/abcd1234'), true);
  // 裸域名（没有具体路径）→ 不认
  assert.equal(looksLikeRealProfile('douyin', 'https://www.douyin.com'), false);
  assert.equal(looksLikeRealProfile('douyin', 'https://www.douyin.com/user/self'), false);
  assert.equal(looksLikeRealProfile('xiaohongshu', 'https://www.xiaohongshu.com/user/profile'), false);
  // 占位/示例 → 不认
  assert.equal(looksLikeRealProfile('douyin', 'https://www.douyin.com/user/EXAMPLE'), false);
  assert.equal(looksLikeRealProfile('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/your-id'), false);
  // host 与 platform 不匹配 → 不认
  assert.equal(looksLikeRealProfile('douyin', 'https://www.xiaohongshu.com/user/profile/abcd1234'), false);
  // 非法/空 → 不认
  assert.equal(looksLikeRealProfile('douyin', ''), false);
  assert.equal(looksLikeRealProfile('douyin', 'not a url'), false);
  assert.equal(looksLikeRealProfile('douyin', null), false);
});

test('withUsableLink：AI 给真实主页 → 保留并标记 verified', () => {
  const r = withUsableLink({ platform: 'douyin', nickname: '老王', homepage_url: 'https://www.douyin.com/user/MS4wLjABAAAAreal123' });
  assert.equal(r.homepage_url, 'https://www.douyin.com/user/MS4wLjABAAAAreal123');
  assert.equal(r.link_verified, true);
  assert.match(r.search_url, /douyin\.com\/search/);
});

test('withUsableLink：AI 给空/死链 → 清空 homepage，补搜索链接', () => {
  const empty = withUsableLink({ platform: 'xiaohongshu', nickname: '增长小李', homepage_url: '' });
  assert.equal(empty.homepage_url, '');
  assert.equal(empty.link_verified, false);
  assert.match(empty.search_url, /xiaohongshu\.com\/search_result/);

  const fake = withUsableLink({ platform: 'douyin', nickname: '某博主', homepage_url: 'https://www.douyin.com/user/EXAMPLE' });
  assert.equal(fake.homepage_url, '', '编造的示例链接被丢弃');
  assert.equal(fake.link_verified, false);
  assert.ok(fake.search_url, '总是有可用搜索链接兜底');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountOpenUrlsForPlatform } from '../server/lib/account-open.js';
import { isAllowedBrowserOpenUrl, openExternalBrowserUrls } from '../server/lib/browser-open.js';

test('browser open whitelist：允许平台搜索和主页链接', () => {
  assert.equal(isAllowedBrowserOpenUrl('https://www.douyin.com/search/%E8%80%81%E7%8E%8B?type=user'), true);
  assert.equal(isAllowedBrowserOpenUrl('https://www.douyin.com/user/MS4wLjABAAAAreal123'), true);
  assert.equal(isAllowedBrowserOpenUrl('https://www.xiaohongshu.com/search_result?keyword=%E8%80%81%E7%8E%8B'), true);
  assert.equal(isAllowedBrowserOpenUrl('https://www.xiaohongshu.com/user/profile/abcd1234'), true);
  assert.equal(isAllowedBrowserOpenUrl('https://www.google.com/search?q=%E8%80%81%E5%BC%A0+%E5%BE%AE%E4%BF%A1%E8%A7%86%E9%A2%91%E5%8F%B7'), true);
});

test('browser open whitelist：拒绝非白名单和非搜索 Google URL', () => {
  assert.equal(isAllowedBrowserOpenUrl('https://example.com'), false);
  assert.equal(isAllowedBrowserOpenUrl('https://evilxiaohongshu.com/search_result?keyword=x'), false);
  assert.equal(isAllowedBrowserOpenUrl('https://www.google.com/maps?q=x'), false);
  assert.equal(isAllowedBrowserOpenUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedBrowserOpenUrl('not a url'), false);
});

test('browser open bulk：macOS 一次命令打开多个 Chrome 标签页', async () => {
  const urls = [
    'https://www.xiaohongshu.com/user/profile/abcd1234',
    'https://www.xiaohongshu.com/user/profile/efgh5678',
  ];
  const calls = [];
  const result = await openExternalBrowserUrls(urls, {
    platform: 'darwin',
    runner: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.deepEqual(result, { openedCount: 2, urls });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: 'open', args: ['-a', 'Google Chrome', ...urls] });
});

test('browser open bulk：任一 URL 不在白名单时不会打开浏览器', async () => {
  const calls = [];
  await assert.rejects(
    () => openExternalBrowserUrls([
      'https://www.xiaohongshu.com/user/profile/abcd1234',
      'https://example.com/',
    ], {
      platform: 'darwin',
      runner: async (command, args) => calls.push({ command, args }),
    }),
    /只允许打开抖音、小红书/,
  );
  assert.equal(calls.length, 0);
});

test('account open urls：只筛出目标平台的有效主页链接', () => {
  const xhsOne = 'https://www.xiaohongshu.com/user/profile/xhs-one';
  const xhsTwo = 'https://www.xiaohongshu.com/user/profile/xhs-two';
  const selected = accountOpenUrlsForPlatform([
    { platform: 'xiaohongshu', homepage_url: xhsOne },
    { platform: '小红书', homepage_url: xhsTwo },
    { platform: 'xiaohongshu', homepage_url: xhsTwo },
    { platform: 'xiaohongshu', homepage_url: 'https://www.xiaohongshu.com/explore/not-homepage' },
    { platform: 'xiaohongshu', homepage_url: '' },
    { platform: 'douyin', homepage_url: 'https://www.douyin.com/user/not-target' },
  ], 'xiaohongshu');

  assert.equal(selected.platform, 'xiaohongshu');
  assert.deepEqual(selected.urls, [xhsOne, xhsTwo]);
  assert.equal(selected.skippedCount, 3);
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-patrol-'));

const { upsertAccount, upsertCapture, getContent } = await import('../server/store.js');
const { get } = await import('../server/db.js');
const { runPatrol } = await import('../server/rpa/patrol.js');

class FakeClient {
  constructor(opts = {}) {
    this.url = 'about:blank';
    this.gotos = [];
    this.typed = '';
    this.postUrls = opts.postUrls || [
      'https://www.douyin.com/video/old',
      'https://www.douyin.com/video/new',
    ];
    this.postCandidates = opts.postCandidates || null;
    this.clickLandingUrls = [...(opts.clickLandingUrls || [])];
    this.clicks = [];
    this.searchHitUrl = opts.searchHitUrl || null;
    this.searchHitText = opts.searchHitText || '主页搜索账号 小红书号';
  }

  async goto(url) {
    this.url = url;
    this.gotos.push(url);
  }

  async sleep() {}
  async screenshot() { return Buffer.from('fakepng'); }
  async currentUrl() { return this.url; }
  async typeText(text) { this.typed += text; }
  async keyPress(key) {
    if (key === 'Enter' && this.url === 'https://www.xiaohongshu.com/explore') {
      this.url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(this.typed)}&type=user`;
    }
  }
  async mouseMove() {}
  async mouseClick(x, y, options) {
    this.clicks.push({ x, y, options, from: this.url });
    if (this.url.includes('xiaohongshu.com/user/profile') && this.clickLandingUrls.length > 0) {
      this.url = this.clickLandingUrls.shift();
    }
  }
  async mouseWheel() {}

  async evaluate(expr) {
    if (expr.includes('vbp-search-input')) {
      return { x: 520, y: 88, width: 1280, height: 800 };
    }
    if (expr.includes('vbp-search-result-hit')) {
      return this.searchHitUrl
        ? { url: this.searchHitUrl, text: this.searchHitText, score: 130, x: 520, y: 240, width: 1280, height: 800 }
        : null;
    }
    if (expr.includes('vbp-post-candidates')) {
      return this.postCandidates || this.postUrls;
    }
    if (expr.includes('const isDetail')) {
      return this.postUrls;
    }
    if (expr.includes('dataBlobs')) {
      const isXhs = this.url.includes('xiaohongshu.com');
      return {
        dataBlobs: [JSON.stringify(isXhs
          ? { note: { interactInfo: { liked_count: '2001', collected_count: '3002', comment_count: '88' } } }
          : { statistics: { diggCount: 1001, shareCount: 12 } })],
        domTexts: {},
        textSample: '',
        pageUrl: this.url,
        title: isXhs ? '新笔记 - 小红书' : '新视频 - 抖音',
        pubTime: '2小时前',
        contentType: isXhs ? 'article' : 'video',
      };
    }
    if (expr.includes('document.title')) {
      return { title: 'ok', url: this.url, text: 'normal page' };
    }
    return null;
  }
}

class MultiTabFakeClient extends FakeClient {
  constructor(shared, id) {
    super();
    this.shared = shared;
    this.id = id;
    shared.clients.push(this);
  }

  async sleep(ms) {
    if (ms < 1000) return;
    this.shared.active++;
    this.shared.maxActive = Math.max(this.shared.maxActive, this.shared.active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    this.shared.active--;
  }

  close() {
    this.shared.closed.push(this.id);
  }

  async evaluate(expr) {
    if (expr.includes('const isDetail')) {
      const id = this.url.split('/').filter(Boolean).pop() || this.id;
      return [`https://www.xiaohongshu.com/explore/${id}-new`];
    }
    return super.evaluate(expr);
  }
}

test('runPatrol skips already-seen URLs and saves the next new candidate', async () => {
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '巡检账号',
    homepage_url: 'https://www.douyin.com/user/test',
    monitor_enabled: true,
  });
  upsertCapture({
    url: 'https://www.douyin.com/video/old',
    platform: 'douyin',
    content_type: 'video',
    author_name: '巡检账号',
    title: '旧视频',
    metrics_source: 'manual',
    metrics_raw: { like: '2000' },
    publish_time: new Date().toISOString(),
  });

  try {
    const result = await runPatrol(new FakeClient(), {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 2,
    });

    assert.equal(result.total, 1);
    assert.equal(result.newItems, 1);
    assert.equal(result.details[0].accountId, acc.id);
    assert.equal(result.details[0].item.url, 'https://www.douyin.com/video/new');
    const saved = getContent(result.details[0].item.id);
    assert.equal(saved.data_status, 'confirmed');
    assert.equal(saved.metrics_confidence, 'structured');
    assert.equal(saved.eligible_reason, '点赞 1001');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol treats fully already-seen candidate lists as duplicate success', async () => {
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '全重复账号',
    homepage_url: 'https://www.douyin.com/user/all-duplicate',
    monitor_enabled: true,
  });
  upsertCapture({
    url: 'https://www.douyin.com/video/already-only',
    platform: 'douyin',
    content_type: 'video',
    author_name: '全重复账号',
    title: '已采集视频',
    metrics_source: 'manual',
    metrics_raw: { like: '2000' },
    publish_time: new Date().toISOString(),
  });

  try {
    const result = await runPatrol(new FakeClient({ postUrls: ['https://www.douyin.com/video/already-only'] }), {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 1,
    });

    assert.equal(result.total, 1);
    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.newItems, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(result.details[0].status, 'ok');
    assert.equal(result.details[0].item.duplicate, true);
    assert.equal(result.details[0].item.url, 'https://www.douyin.com/video/already-only');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol searches Xiaohongshu from the home page when homepage is missing', async () => {
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '主页搜索账号',
    homepage_url: '',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postUrls: ['https://www.xiaohongshu.com/explore/search-new'],
    searchHitUrl: 'https://www.xiaohongshu.com/user/profile/search-profile',
    searchHitText: '主页搜索账号 小红书号: search-profile',
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      maxCandidatesPerAccount: 1,
    });

    assert.equal(result.total, 1);
    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.equal(client.gotos[0], 'https://www.xiaohongshu.com/explore');
    assert.equal(client.typed, '主页搜索账号');
    assert.ok(client.gotos.includes('https://www.xiaohongshu.com/user/profile/search-profile'));
    const savedAccount = get('SELECT homepage_url FROM accounts WHERE id = ?', [acc.id]);
    assert.equal(savedAccount.homepage_url, 'https://www.xiaohongshu.com/user/profile/search-profile');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol opens Xiaohongshu candidate by clicking inside the homepage card', async () => {
  const postUrl = 'https://www.xiaohongshu.com/explore/card-click-new';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '卡片点击账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/card-click-account',
    monitor_enabled: true,
  });
  const rect = { left: 180, top: 220, width: 260, height: 190 };
  const client = new FakeClient({
    postCandidates: [{ url: postUrl, rect, viewport: { width: 1280, height: 800 } }],
    clickLandingUrls: [postUrl],
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      maxCandidatesPerAccount: 1,
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.equal(client.gotos.includes(postUrl), false, 'card candidates should not be opened by direct navigation');
    assert.equal(client.clicks.length, 1);
    assert.ok(client.clicks[0].x > rect.left && client.clicks[0].x < rect.left + rect.width);
    assert.ok(client.clicks[0].y > rect.top && client.clicks[0].y < rect.top + rect.height);
    assert.ok(client.clicks[0].options.holdMs >= 140 && client.clicks[0].options.holdMs <= 340);
    const saved = getContent(result.details[0].item.id);
    assert.equal(saved.like_count, 2001);
    assert.equal(saved.favorite_count, 3002);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol skips a Xiaohongshu card click that lands back on explore and tries the next candidate', async () => {
  const firstUrl = 'https://www.xiaohongshu.com/explore/kicked-first';
  const secondUrl = 'https://www.xiaohongshu.com/explore/kicked-second';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '踢回发现页账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/kicked-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postCandidates: [
      { url: firstUrl, rect: { left: 100, top: 160, width: 220, height: 160 }, viewport: { width: 1280, height: 800 } },
      { url: secondUrl, rect: { left: 360, top: 160, width: 220, height: 160 }, viewport: { width: 1280, height: 800 } },
    ],
    clickLandingUrls: ['https://www.xiaohongshu.com/explore', secondUrl],
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      maxCandidatesPerAccount: 2,
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.equal(result.details[0].item.url, secondUrl);
    assert.equal(client.clicks.length, 2);
    assert.ok(client.gotos.filter((url) => url === acc.homepage_url).length >= 2, 'should return to the homepage before trying the next card');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol opens multiple account tabs per platform when a client factory is provided', async () => {
  const accounts = [
    upsertAccount({
      platform: 'xiaohongshu',
      nickname: '并发账号一',
      homepage_url: 'https://www.xiaohongshu.com/user/profile/concurrent-one',
      monitor_enabled: true,
    }),
    upsertAccount({
      platform: 'xiaohongshu',
      nickname: '并发账号二',
      homepage_url: 'https://www.xiaohongshu.com/user/profile/concurrent-two',
      monitor_enabled: true,
    }),
    upsertAccount({
      platform: 'xiaohongshu',
      nickname: '并发账号三',
      homepage_url: 'https://www.xiaohongshu.com/user/profile/concurrent-three',
      monitor_enabled: true,
    }),
  ];
  const shared = { clients: [], closed: [], active: 0, maxActive: 0 };
  const primary = new MultiTabFakeClient(shared, 'primary');

  try {
    const result = await runPatrol(primary, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      maxCandidatesPerAccount: 1,
      maxTabsPerPlatform: 2,
      clientFactory: async () => new MultiTabFakeClient(shared, `extra-${shared.clients.length}`),
    });

    assert.equal(result.total, 3);
    assert.equal(result.success, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.tabMode, 'multi');
    assert.equal(result.maxTabsPerPlatform, 2);
    assert.ok(shared.clients.length >= 2);
    assert.ok(shared.maxActive >= 2, 'expected at least two active tab sleeps at once');
    assert.ok(shared.closed.includes('extra-1'));
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
    }
  }
});

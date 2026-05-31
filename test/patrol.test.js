import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-patrol-'));

const { upsertAccount, upsertCapture, getContent } = await import('../server/store.js');
const { get } = await import('../server/db.js');
const { runPatrol } = await import('../server/rpa/patrol.js');

function filterCandidatesForScript(expr, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const target = list.find((item) => {
    const url = typeof item === 'string' ? item : item?.url;
    return url && expr.includes(JSON.stringify(url));
  });
  return target ? [target] : list;
}

class FakeClient {
  constructor(opts = {}) {
    this.url = 'about:blank';
    this.gotos = [];
    this.typed = '';
    this.postUrls = opts.postUrls || [
      'https://www.douyin.com/video/old',
      'https://www.douyin.com/video/new',
    ];
    this.douyinPostUrls = opts.douyinPostUrls || this.postUrls;
    this.xhsPostCandidates = opts.xhsPostCandidates || null;
    this.postCandidates = opts.postCandidates || null;
    this.clickLandingUrls = [...(opts.clickLandingUrls || [])];
    this.clicks = [];
    this.searchHitUrl = opts.searchHitUrl || null;
    this.searchHitText = opts.searchHitText || '主页搜索账号 小红书号';
    this.titleByUrl = opts.titleByUrl || {};
    this.pubTimeByUrl = opts.pubTimeByUrl || {};
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
      if (this.url.includes('xiaohongshu.com')) {
        if (this.xhsPostCandidates) return filterCandidatesForScript(expr, this.xhsPostCandidates);
        if (this.postCandidates) return filterCandidatesForScript(expr, this.postCandidates);
        return filterCandidatesForScript(expr, this.postUrls.map((url, i) => ({
          url,
          rect: { left: 160 + i * 240, top: 220, width: 220, height: 160 },
          viewport: { width: 1280, height: 800 },
          likeRaw: '2001',
          likeCount: 2001,
          publishRaw: '2小时前',
        })));
      }
      return filterCandidatesForScript(expr, this.postCandidates || this.douyinPostUrls);
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
        title: this.titleByUrl[this.url] || (isXhs ? '新笔记 - 小红书' : '新视频 - 抖音'),
        pubTime: Object.hasOwn(this.pubTimeByUrl, this.url) ? this.pubTimeByUrl[this.url] : '2小时前',
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

class OrderedClient extends FakeClient {
  constructor(shared, id, opts = {}) {
    super(opts);
    this.shared = shared;
    this.id = id;
    shared.clients.push(this);
  }

  async goto(url) {
    this.shared.events.push({ type: 'goto', id: this.id, url });
    await super.goto(url);
  }

  close() {
    this.shared.events.push({ type: 'close', id: this.id, url: this.url });
    this.shared.closed.push(this.id);
  }
}

class BatchOrderedClient extends OrderedClient {
  async evaluate(expr) {
    if (expr.includes('vbp-post-candidates')) {
      const id = this.url.split('/').filter(Boolean).pop() || this.id;
      if (this.url.includes('xiaohongshu.com')) {
        return [xhsCandidate(`https://www.xiaohongshu.com/explore/${id}-no-like`, {
          likeRaw: null,
          likeCount: null,
          titleRaw: `小红书候选 ${id}`,
        })];
      }
      return [{
        url: `https://www.douyin.com/video/${id}-new`,
        titleRaw: `抖音候选 ${id}`,
        publishRaw: '2小时前',
      }];
    }
    if (expr.includes('dataBlobs') && this.url.includes('douyin.com/video/')) {
      const id = (this.url.split('/').filter(Boolean).pop() || this.id).replace(/-new$/, '');
      return {
        dataBlobs: [JSON.stringify({ statistics: { diggCount: 1001, shareCount: 12 } })],
        domTexts: {},
        textSample: '',
        pageUrl: this.url,
        title: `抖音候选 ${id}`,
        pubTime: '2小时前',
        contentType: 'video',
      };
    }
    return super.evaluate(expr);
  }
}

function xhsCandidate(url, overrides = {}) {
  return {
    url,
    rect: { left: 140, top: 180, width: 220, height: 160 },
    viewport: { width: 1280, height: 800 },
    likeRaw: '2001',
    likeCount: 2001,
    publishRaw: '2小时前',
    ...overrides,
  };
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

test('runPatrol skips Douyin pinned candidates before opening video detail', async () => {
  const pinnedUrl = 'https://www.douyin.com/video/pinned-should-not-open';
  const normalUrl = 'https://www.douyin.com/video/non-pinned-new';
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '抖音置顶过滤账号',
    homepage_url: 'https://www.douyin.com/user/douyin-pinned-filter',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postCandidates: [
      { url: pinnedUrl, isPinned: true, cardText: '置顶 热门旧视频' },
      { url: normalUrl, isPinned: false, cardText: '最新视频' },
    ],
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 2,
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.equal(result.details[0].item.url, normalUrl);
    assert.equal(client.gotos.includes(pinnedUrl), false, 'pinned Douyin video should not be opened');
    assert.ok(client.gotos.includes(normalUrl), 'non-pinned Douyin video should still be opened');
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
    clickLandingUrls: ['https://www.xiaohongshu.com/explore/search-new'],
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
    postCandidates: [{ url: postUrl, rect, viewport: { width: 1280, height: 800 }, likeRaw: '2001', likeCount: 2001, publishRaw: '2小时前' }],
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
      { url: firstUrl, rect: { left: 100, top: 160, width: 220, height: 160 }, viewport: { width: 1280, height: 800 }, likeRaw: '2001', likeCount: 2001, publishRaw: '2小时前' },
      { url: secondUrl, rect: { left: 360, top: 160, width: 220, height: 160 }, viewport: { width: 1280, height: 800 }, likeRaw: '2001', likeCount: 2001, publishRaw: '2小时前' },
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

test('runPatrol opens mixed Xiaohongshu and Douyin accounts in the same batch and closes the batch before the next one', async () => {
  const accounts = [
    upsertAccount({
      platform: 'douyin',
      nickname: '混合抖音一',
      homepage_url: 'https://www.douyin.com/user/mixed-douyin-one',
      priority: 'A001',
      monitor_enabled: true,
    }),
    upsertAccount({
      platform: 'xiaohongshu',
      nickname: '混合小红书一',
      homepage_url: 'https://www.xiaohongshu.com/user/profile/mixed-xhs-one',
      priority: 'A002',
      monitor_enabled: true,
    }),
    upsertAccount({
      platform: 'douyin',
      nickname: '混合抖音二',
      homepage_url: 'https://www.douyin.com/user/mixed-douyin-two',
      priority: 'A003',
      monitor_enabled: true,
    }),
  ];
  const shared = { clients: [], closed: [], events: [] };
  const primary = new BatchOrderedClient(shared, 'primary');
  let seq = 0;

  try {
    const result = await runPatrol(primary, {
      discoverFollows: false,
      platforms: ['douyin', 'xiaohongshu'],
      maxCandidatesPerAccount: 1,
      maxTabsPerBatch: 2,
      freeMemoryBytes: 20 * 1024 * 1024 * 1024,
      clientFactory: async () => new BatchOrderedClient(shared, `mixed-${++seq}`),
    });

    const events = shared.events.map((e, i) => ({ ...e, i }));
    const homeGotos = events.filter((e) => e.type === 'goto' && /mixed-(douyin|xhs)/.test(e.url) && !e.url.includes('/video/'));
    const firstBatchHomes = homeGotos.slice(0, 2);
    const secondBatchHome = homeGotos[2];
    const firstVideoGoto = events.find((e) => e.type === 'goto' && e.url.includes('/video/'));
    const closesBeforeSecondBatch = events.filter((e) => e.type === 'close' && e.i < secondBatchHome.i);

    assert.equal(result.success, 3);
    assert.equal(result.maxTabsPerBatch, 2);
    assert.equal(firstBatchHomes.length, 2);
    assert.ok(firstBatchHomes.some((e) => e.url.includes('douyin.com/user/')));
    assert.ok(firstBatchHomes.some((e) => e.url.includes('xiaohongshu.com/user/profile/')));
    assert.ok(firstVideoGoto.i > Math.max(...firstBatchHomes.map((e) => e.i)), 'content processing starts after all homepages in the batch are open');
    assert.equal(closesBeforeSecondBatch.length, 2, 'first batch tabs should close before next batch opens');
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol defaults to batches of 10 and waits for all 10 tabs to close before opening the next batch', async () => {
  const accounts = [];
  for (let i = 0; i < 12; i++) {
    const isDouyin = i % 2 === 0;
    accounts.push(upsertAccount({
      platform: isDouyin ? 'douyin' : 'xiaohongshu',
      nickname: `十个一批账号${i}`,
      homepage_url: isDouyin
        ? `https://www.douyin.com/user/batch10-${i}`
        : `https://www.xiaohongshu.com/user/profile/batch10-${i}`,
      priority: `B${String(i).padStart(3, '0')}`,
      monitor_enabled: true,
    }));
  }
  const shared = { clients: [], closed: [], events: [] };
  const primary = new BatchOrderedClient(shared, 'primary');
  let seq = 0;

  try {
    const result = await runPatrol(primary, {
      discoverFollows: false,
      platforms: ['douyin', 'xiaohongshu'],
      maxCandidatesPerAccount: 1,
      freeMemoryBytes: 20 * 1024 * 1024 * 1024,
      clientFactory: async () => new BatchOrderedClient(shared, `batch10-${++seq}`),
    });

    const events = shared.events.map((e, i) => ({ ...e, i }));
    const homeGotos = events.filter((e) => e.type === 'goto' && /batch10-\d+/.test(e.url) && !e.url.includes('/video/'));
    const firstTenHomeMaxIndex = Math.max(...homeGotos.slice(0, 10).map((e) => e.i));
    const firstVideoGoto = events.find((e) => e.type === 'goto' && e.url.includes('/video/'));
    const eleventhHome = homeGotos[10];
    const closesBeforeEleventh = events.filter((e) => e.type === 'close' && e.i < eleventhHome.i);

    assert.equal(result.total, 12);
    assert.equal(result.maxTabsPerBatch, 10);
    assert.equal(homeGotos.length, 12);
    assert.ok(homeGotos.slice(0, 10).some((e) => e.url.includes('douyin.com/user/')));
    assert.ok(homeGotos.slice(0, 10).some((e) => e.url.includes('xiaohongshu.com/user/profile/')));
    assert.ok(firstVideoGoto.i > firstTenHomeMaxIndex, 'first batch processing should wait for all 10 homepages');
    assert.equal(closesBeforeEleventh.length, 10, 'all first-batch tabs close before batch 2 opens');
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol lowers batch concurrency when free memory is low', async () => {
  const accounts = [];
  for (let i = 0; i < 4; i++) {
    accounts.push(upsertAccount({
      platform: 'xiaohongshu',
      nickname: `低内存账号${i}`,
      homepage_url: `https://www.xiaohongshu.com/user/profile/low-memory-${i}`,
      priority: `C${String(i).padStart(3, '0')}`,
      monitor_enabled: true,
    }));
  }
  const shared = { clients: [], closed: [], events: [] };
  const primary = new BatchOrderedClient(shared, 'primary');
  let seq = 0;

  try {
    const result = await runPatrol(primary, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      maxCandidatesPerAccount: 1,
      maxTabsPerBatch: 10,
      freeMemoryBytes: 2 * 1024 * 1024 * 1024,
      clientFactory: async () => new BatchOrderedClient(shared, `lowmem-${++seq}`),
    });

    assert.equal(result.maxTabsPerBatch, 2);
    const firstBatchHomeGotos = shared.events
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.type === 'goto' && /low-memory-[01]/.test(e.url));
    const thirdHome = shared.events
      .map((e, i) => ({ ...e, i }))
      .find((e) => e.type === 'goto' && e.url.includes('low-memory-2'));
    const closesBeforeThird = shared.events
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.type === 'close' && e.i < thirdHome.i);
    assert.equal(firstBatchHomeGotos.length, 2);
    assert.equal(closesBeforeThird.length, 2);
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol keeps mixed account order in single-tab fallback', async () => {
  const accounts = [
    upsertAccount({
      platform: 'douyin',
      nickname: '单标签抖音',
      homepage_url: 'https://www.douyin.com/user/single-douyin',
      priority: 'D001',
      monitor_enabled: true,
    }),
    upsertAccount({
      platform: 'xiaohongshu',
      nickname: '单标签小红书',
      homepage_url: 'https://www.xiaohongshu.com/user/profile/single-xhs',
      priority: 'D002',
      monitor_enabled: true,
    }),
  ];
  const shared = { clients: [], closed: [], events: [] };
  const client = new OrderedClient(shared, 'single', {
    xhsPostCandidates: [xhsCandidate('https://www.xiaohongshu.com/explore/single-no-like', { likeRaw: null, likeCount: null })],
    douyinPostUrls: ['https://www.douyin.com/video/single-douyin-new'],
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['douyin', 'xiaohongshu'],
      maxCandidatesPerAccount: 1,
    });

    const firstXhsGoto = shared.events.findIndex((e) => e.type === 'goto' && e.url.includes('xiaohongshu.com/user/profile/single-xhs'));
    const firstDouyinGoto = shared.events.findIndex((e) => e.type === 'goto' && e.url.includes('douyin.com/user/single-douyin'));
    assert.equal(result.success, 2);
    assert.ok(firstXhsGoto > -1);
    assert.ok(firstDouyinGoto > -1);
    assert.ok(firstDouyinGoto < firstXhsGoto, 'single-tab fallback should follow mixed account order');
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol filters Xiaohongshu pinned, low-like, and unknown-like cards before clicking qualified cards', async () => {
  const q1 = 'https://www.xiaohongshu.com/explore/filter-qualified-one';
  const q2 = 'https://www.xiaohongshu.com/explore/filter-qualified-two';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '筛选账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/filter-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate('https://www.xiaohongshu.com/explore/filter-pinned', { isPinned: true, cardText: '置顶 笔记', likeRaw: '9999', likeCount: 9999 }),
      xhsCandidate('https://www.xiaohongshu.com/explore/filter-low', { likeRaw: '999', likeCount: 999 }),
      xhsCandidate('https://www.xiaohongshu.com/explore/filter-unknown', { likeRaw: null, likeCount: null }),
      xhsCandidate(q1, { likeRaw: '1000+', likeCount: 1000 }),
      xhsCandidate(q2, { likeRaw: '2.2万', likeCount: 22000 }),
    ],
    clickLandingUrls: [q1, q2],
    titleByUrl: {
      [q1]: '筛选达标一 - 小红书',
      [q2]: '筛选达标二 - 小红书',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 2);
    assert.equal(client.clicks.length, 2);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [q1, q2]);
    const reasons = result.details[0].skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('pinned'));
    assert.ok(reasons.includes('below_threshold'));
    assert.ok(reasons.includes('unknown_like'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol skips a non-pinned candidate when detail title matches a skipped pinned title', async () => {
  const pinnedUrl = 'https://www.xiaohongshu.com/explore/title-pinned-old';
  const candidateUrl = 'https://www.xiaohongshu.com/explore/title-mismatch-new';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '标题错配账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/title-mismatch-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(pinnedUrl, { isPinned: true, titleRaw: '旧置顶爆款标题', cardText: '置顶 旧置顶爆款标题', likeRaw: '9999', likeCount: 9999 }),
      xhsCandidate(candidateUrl, { titleRaw: '真正最新标题', likeRaw: '2001', likeCount: 2001 }),
    ],
    clickLandingUrls: [candidateUrl],
    titleByUrl: {
      [candidateUrl]: '旧置顶爆款标题 - 小红书',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 0);
    assert.equal(client.clicks.length, 1);
    assert.equal(client.gotos.includes(pinnedUrl), false);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'pinned' && s.title.includes('旧置顶爆款标题')));
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'title_mismatch'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol does not save detail pages with unknown publish time', async () => {
  const url = 'https://www.xiaohongshu.com/explore/unknown-time-detail';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '未知时间账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/unknown-time-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(url, { publishRaw: null, publishTime: null, titleRaw: '未知时间候选' }),
    ],
    clickLandingUrls: [url],
    titleByUrl: {
      [url]: '未知时间候选 - 小红书',
    },
    pubTimeByUrl: {
      [url]: '',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 0);
    assert.equal(client.clicks.length, 1);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'unknown_time'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol stops Xiaohongshu account when it reaches already-seen content', async () => {
  const oldUrl = 'https://www.xiaohongshu.com/explore/already-seen-stop';
  const nextUrl = 'https://www.xiaohongshu.com/explore/should-not-open-after-seen';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '已采集停止账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/already-stop-account',
    monitor_enabled: true,
  });
  upsertCapture({
    url: oldUrl,
    platform: 'xiaohongshu',
    content_type: 'article',
    author_name: '已采集停止账号',
    title: '已采集内容',
    metrics_source: 'manual',
    metrics_raw: { like: '2000', favorite: '2000' },
    publish_time: new Date().toISOString(),
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(oldUrl),
      xhsCandidate(nextUrl),
    ],
    clickLandingUrls: [nextUrl],
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    assert.equal(result.success, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(client.clicks.length, 0);
    assert.equal(result.details[0].items[0].duplicate, true);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'already_seen'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol stops Xiaohongshu account when card publish time is outside the window', async () => {
  const oldUrl = 'https://www.xiaohongshu.com/explore/out-of-window-card';
  const nextUrl = 'https://www.xiaohongshu.com/explore/should-not-open-after-old-card';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '超窗停止账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/out-window-card-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(oldUrl, { publishRaw: '2026-05-20', publishTime: '2026-05-20T00:00:00.000Z' }),
      xhsCandidate(nextUrl),
    ],
    clickLandingUrls: [nextUrl],
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowStartISO: '2026-05-30T00:00:00.000Z',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 0);
    assert.equal(client.clicks.length, 0);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'out_of_window'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol clicks unknown-time qualified Xiaohongshu card but stops if detail is outside the window', async () => {
  const oldUrl = 'https://www.xiaohongshu.com/explore/out-of-window-detail';
  const nextUrl = 'https://www.xiaohongshu.com/explore/should-not-open-after-old-detail';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '详情超窗账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/out-window-detail-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(oldUrl, { publishRaw: null, publishTime: null }),
      xhsCandidate(nextUrl),
    ],
    clickLandingUrls: [oldUrl, nextUrl],
    pubTimeByUrl: {
      [oldUrl]: '2026-05-20',
      [nextUrl]: '2小时前',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowStartISO: '2026-05-30T00:00:00.000Z',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 0);
    assert.equal(client.clicks.length, 1);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'out_of_window'));
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

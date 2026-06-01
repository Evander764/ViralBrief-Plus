import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-patrol-'));

const { upsertAccount, upsertCapture, getContent, beijingDayStartISO } = await import('../server/store.js');
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
    this.xhsPostCandidatesByHomepage = opts.xhsPostCandidatesByHomepage || null;
    this.postCandidates = opts.postCandidates || null;
    this.clickLandingUrls = [...(opts.clickLandingUrls || [])];
    this.clicks = [];
    this.wheels = [];
    this.lastXhsHomepage = null;
    this.closedDetails = 0;
    this.searchHitUrl = opts.searchHitUrl || null;
    this.searchHitText = opts.searchHitText || '主页搜索账号 小红书号';
    this.titleByUrl = opts.titleByUrl || {};
    this.pubTimeByUrl = opts.pubTimeByUrl || {};
    this.layoutPubTimeByUrl = opts.layoutPubTimeByUrl || {};
    this.bodyByUrl = opts.bodyByUrl || {};
    this.hashtagsByUrl = opts.hashtagsByUrl || {};
    this.dataByUrl = opts.dataByUrl || {};
    this.pauseCalls = 0;
  }

  async goto(url) {
    this.url = url;
    this.gotos.push(url);
    if (url.includes('xiaohongshu.com/user/profile')) this.lastXhsHomepage = url;
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
    const isXhsClose = this.url.includes('xiaohongshu.com/explore/') && x <= 220 && y <= 180;
    this.clicks.push({ x, y, options, from: this.url, kind: isXhsClose ? 'xhs-close' : 'card' });
    if (isXhsClose) {
      this.closedDetails++;
      this.url = this.lastXhsHomepage || 'https://www.xiaohongshu.com/user/profile/fake-home';
      return;
    }
    if (this.url.includes('xiaohongshu.com/user/profile') && this.clickLandingUrls.length > 0) {
      this.url = this.clickLandingUrls.shift();
      return;
    }
    if (this.url.includes('douyin.com/user/') && this.clickLandingUrls.length > 0) {
      this.url = this.clickLandingUrls.shift();
    }
  }
  async mouseWheel(deltaX, deltaY, x, y) {
    this.wheels.push({ deltaX, deltaY, x, y, from: this.url });
  }

  async evaluate(expr) {
    if (expr.includes('vbp-douyin-pause-video')) {
      this.pauseCalls++;
      return { videoCount: 1, pausedCount: 1 };
    }
    if (expr.includes('vbp-douyin-layout-publish-time')) {
      const value = this.layoutPubTimeByUrl[this.url];
      return value ? { time: value, score: 300, text: `发布时间：${value}` } : null;
    }
    if (expr.includes('vbp-xhs-layout-publish-time')) {
      const value = this.layoutPubTimeByUrl[this.url];
      return value ? { time: value, score: 300, text: value } : null;
    }
    if (expr.includes('vbp-xhs-close-button')) {
      return this.url.includes('xiaohongshu.com/explore/')
        ? { x: 44, y: 48, width: 1280, height: 800, score: 200 }
        : null;
    }
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
        const homepageCandidates = this.xhsPostCandidatesByHomepage?.[this.lastXhsHomepage || this.url] || null;
        if (homepageCandidates) return filterCandidatesForScript(expr, homepageCandidates);
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
      const bodyText = this.bodyByUrl[this.url] || (isXhs ? '小红书正文 #小红书标签 #AI选题' : '抖音正文 #抖音标签 #AI选题');
      const dataBlob = this.dataByUrl[this.url] || (isXhs
        ? { note: { interactInfo: { liked_count: '2001', collected_count: '3002', comment_count: '88' } } }
        : { statistics: { diggCount: 3001, collectCount: 3002, shareCount: 3003, commentCount: 88 } });
      return {
        dataBlobs: [JSON.stringify(dataBlob)],
        domTexts: {},
        textSample: bodyText,
        pageUrl: this.url,
        title: this.titleByUrl[this.url] || (isXhs ? '新笔记 - 小红书' : '新视频 - 抖音'),
        bodyText,
        hashtags: this.hashtagsByUrl[this.url],
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
  async mouseClick(x, y, options) {
    const before = this.url;
    await super.mouseClick(x, y, options);
    if (before === this.url && before.includes('xiaohongshu.com/user/profile/')) {
      const id = before.split('/').filter(Boolean).pop() || this.id;
      this.url = `https://www.xiaohongshu.com/explore/${id}-no-like`;
    }
  }

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
        dataBlobs: [JSON.stringify({ statistics: { diggCount: 3001, collectCount: 3002, shareCount: 3003, commentCount: 88 } })],
        domTexts: {},
        textSample: `抖音候选正文 ${id} #抖音批次`,
        pageUrl: this.url,
        title: `抖音候选 ${id}`,
        bodyText: `抖音候选正文 ${id} #抖音批次`,
        hashtags: ['#抖音批次'],
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

function cardClicks(client) {
  return client.clicks.filter((click) => click.kind !== 'xhs-close');
}

function closeClicks(client) {
  return client.clicks.filter((click) => click.kind === 'xhs-close');
}

test('runPatrol stops before account work without marking the account as patrolled today', async () => {
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '停止未跑账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/stop-before-work',
    monitor_enabled: true,
  });

  try {
    const result = await runPatrol(new FakeClient(), {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      shouldStop: () => true,
    });

    assert.equal(result.total, 1);
    assert.equal(result.stopped, true);
    assert.equal(result.success, 0);
    const saved = get('SELECT last_patrolled_at FROM accounts WHERE id = ?', [acc.id]);
    assert.equal(saved.last_patrolled_at, null);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol defaults to skipping accounts already patrolled today unless explicitly included', async () => {
  const homepage = 'https://www.douyin.com/user/repatrol-today';
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '当天复巡账号',
    homepage_url: homepage,
    monitor_enabled: true,
    last_patrolled_at: new Date(Date.parse(beijingDayStartISO()) + 60_000).toISOString(),
  });

  try {
    const skippedClient = new FakeClient({ douyinPostUrls: ['https://www.douyin.com/video/repatrol-skip'] });
    const skipped = await runPatrol(skippedClient, {
      discoverFollows: false,
      platforms: ['douyin'],
    });
    assert.equal(skipped.total, 0);
    assert.equal(skipped.skippedToday, 1);
    assert.deepEqual(skippedClient.gotos, []);

    const includedClient = new FakeClient({ douyinPostUrls: ['https://www.douyin.com/video/repatrol-include'] });
    const included = await runPatrol(includedClient, {
      discoverFollows: false,
      platforms: ['douyin'],
      includePatrolledToday: true,
    });
    assert.equal(included.total, 1);
    assert.equal(included.skippedToday, 0);
    assert.equal(includedClient.gotos[0], homepage);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

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
    assert.equal(saved.eligible_reason, '点赞 3001，收藏 3002，转发/分享 3003 均达标');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol pauses Douyin video detail and saves body hashtags', async () => {
  const postUrl = 'https://www.douyin.com/video/body-tags-new';
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '抖音正文账号',
    homepage_url: 'https://www.douyin.com/user/douyin-body-tags',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    douyinPostUrls: [postUrl],
    bodyByUrl: { [postUrl]: '抖音正文信息 #选题洞察 #成交转化' },
    hashtagsByUrl: { [postUrl]: ['#选题洞察', '#成交转化'] },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 1,
    });

    assert.equal(result.newItems, 1);
    assert.equal(client.pauseCalls, 1, 'Douyin video should be paused before extraction');
    const saved = getContent(result.details[0].item.id);
    assert.match(saved.body_excerpt, /抖音正文信息/);
    assert.match(saved.body_excerpt, /#选题洞察/);
    assert.match(saved.body_excerpt, /#成交转化/);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol opens first Douyin candidate by clicking the homepage card', async () => {
  const postUrl = 'https://www.douyin.com/video/home-card-click-new';
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '抖音主页卡片账号',
    homepage_url: 'https://www.douyin.com/user/douyin-home-card',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postCandidates: [{
      url: postUrl,
      rect: { left: 240, top: 260, width: 180, height: 240 },
      viewport: { width: 1280, height: 800 },
      titleRaw: '抖音主页卡片视频',
      publishRaw: '2小时前',
    }],
    clickLandingUrls: [postUrl],
    titleByUrl: { [postUrl]: '抖音主页卡片视频 - 抖音' },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 1,
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.equal(result.details[0].item.url, postUrl);
    assert.equal(client.gotos.includes(postUrl), false, 'first Douyin candidate should be opened by homepage card click');
    assert.ok(client.clicks.some((click) => click.from === acc.homepage_url && click.kind === 'card'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol falls back to the Douyin detail URL when homepage card click opens the wrong video', async () => {
  const postUrl = 'https://www.douyin.com/video/home-card-fallback-new';
  const wrongUrl = 'https://www.douyin.com/video/home-card-fallback-wrong';
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '抖音卡片兜底账号',
    homepage_url: 'https://www.douyin.com/user/douyin-home-card-fallback',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postCandidates: [{
      url: postUrl,
      rect: { left: 220, top: 240, width: 190, height: 250 },
      viewport: { width: 1280, height: 800 },
      titleRaw: '抖音卡片兜底视频',
      publishRaw: '2小时前',
    }],
    clickLandingUrls: [wrongUrl],
    titleByUrl: {
      [postUrl]: '抖音卡片兜底视频 - 抖音',
      [wrongUrl]: '抖音错误落点视频 - 抖音',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 1,
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.equal(result.details[0].item.url, postUrl);
    assert.ok(client.clicks.some((click) => click.from === acc.homepage_url && click.kind === 'card'));
    assert.ok(client.gotos.includes(postUrl), 'wrong card landing should fall back to direct detail URL');
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

test('runPatrol saves out-of-window Douyin detail and stops the account', async () => {
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '抖音超窗账号',
    homepage_url: 'https://www.douyin.com/user/douyin-out-window',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postCandidates: [
      { url: 'https://www.douyin.com/video/out-window-old', publishRaw: '2026-05-20', publishTime: '2026-05-20T00:00:00.000Z' },
      { url: 'https://www.douyin.com/video/out-window-next', publishRaw: '2小时前' },
    ],
    pubTimeByUrl: {
      'https://www.douyin.com/video/out-window-old': '举报 2026年5月20日',
    },
    titleByUrl: {
      'https://www.douyin.com/video/out-window-old': '抖音超窗旧视频',
      'https://www.douyin.com/video/out-window-next': '抖音超窗后一条新视频',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 2,
      windowStartISO: '2026-05-30T00:00:00.000Z',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [
      'https://www.douyin.com/video/out-window-old',
    ]);
    assert.ok(client.gotos.includes('https://www.douyin.com/video/out-window-old'));
    assert.equal(client.gotos.includes('https://www.douyin.com/video/out-window-next'), false);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'out_of_window'));
    const saved = getContent(result.details[0].item.id);
    assert.equal(saved.publish_time.slice(0, 10), '2026-05-20');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol reads Douyin layout publish time before deciding account exit', async () => {
  const oldUrl = 'https://www.douyin.com/video/layout-publish-old';
  const nextUrl = 'https://www.douyin.com/video/layout-publish-next';
  const acc = upsertAccount({
    platform: 'douyin',
    nickname: '抖音布局时间账号',
    homepage_url: 'https://www.douyin.com/user/douyin-layout-time',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postCandidates: [
      { url: oldUrl, publishRaw: '2小时前' },
      { url: nextUrl, publishRaw: '2小时前' },
    ],
    pubTimeByUrl: {
      [oldUrl]: '2小时前',
    },
    layoutPubTimeByUrl: {
      [oldUrl]: '发布时间：2026-05-01 06:15',
    },
    titleByUrl: {
      [oldUrl]: '抖音布局时间旧视频',
      [nextUrl]: '抖音布局时间下一条',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['douyin'],
      maxCandidatesPerAccount: 2,
      windowStartISO: '2026-05-30T00:00:00.000Z',
    });

    assert.equal(result.success, 1);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [oldUrl]);
    assert.ok(client.gotos.includes(oldUrl));
    assert.equal(client.gotos.includes(nextUrl), false);
    const saved = getContent(result.details[0].item.id);
    const savedTime = new Date(saved.publish_time);
    assert.equal(savedTime.getFullYear(), 2026);
    assert.equal(savedTime.getMonth(), 4);
    assert.equal(savedTime.getDate(), 1);
    assert.equal(savedTime.getHours(), 6);
    assert.equal(savedTime.getMinutes(), 15);
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

test('runPatrol scans Xiaohongshu cards left-to-right before moving down', async () => {
  const leftUrl = 'https://www.xiaohongshu.com/explore/order-left';
  const rightUrl = 'https://www.xiaohongshu.com/explore/order-right';
  const lowerUrl = 'https://www.xiaohongshu.com/explore/order-lower';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '排序账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/order-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(lowerUrl, { rect: { left: 100, top: 430, width: 220, height: 160 }, viewport: { width: 1280, height: 800 }, titleRaw: '下方候选' }),
      xhsCandidate(rightUrl, { rect: { left: 390, top: 180, width: 220, height: 160 }, viewport: { width: 1280, height: 800 }, titleRaw: '右侧候选' }),
      xhsCandidate(leftUrl, { rect: { left: 100, top: 170, width: 220, height: 160 }, viewport: { width: 1280, height: 800 }, titleRaw: '左侧候选' }),
    ],
    clickLandingUrls: [leftUrl, rightUrl, lowerUrl],
    titleByUrl: {
      [leftUrl]: '左侧候选 - 小红书',
      [rightUrl]: '右侧候选 - 小红书',
      [lowerUrl]: '下方候选 - 小红书',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    const clicks = cardClicks(client);
    assert.equal(result.newItems, 3);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [leftUrl, rightUrl, lowerUrl]);
    assert.ok(clicks[0].x >= 100 && clicks[0].x <= 320);
    assert.ok(clicks[1].x >= 390 && clicks[1].x <= 610);
    assert.ok(clicks[2].y >= 430 && clicks[2].y <= 590);
    assert.ok(client.wheels.length >= 1, 'should scroll after finishing the first visible row');
    assert.equal(client.wheels[0].deltaY, 180, 'Xiaohongshu row scroll should be half of the old 360px distance');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol applies maxCandidatesPerAccount to Xiaohongshu before moving to the next account', async () => {
  const accounts = [
    upsertAccount({
      platform: 'xiaohongshu',
      nickname: '小红书上限账号一',
      homepage_url: 'https://www.xiaohongshu.com/user/profile/xhs-limit-one',
      priority: 'S',
      monitor_enabled: true,
    }),
    upsertAccount({
      platform: 'xiaohongshu',
      nickname: '小红书上限账号二',
      homepage_url: 'https://www.xiaohongshu.com/user/profile/xhs-limit-two',
      priority: 'A',
      monitor_enabled: true,
    }),
  ];
  const firstCandidates = Array.from({ length: 6 }, (_, i) => xhsCandidate(
    `https://www.xiaohongshu.com/explore/xhs-limit-one-${i}`,
    { rect: { left: 120 + i * 160, top: 180, width: 120, height: 140 } },
  ));
  const secondUrl = 'https://www.xiaohongshu.com/explore/xhs-limit-two-0';
  const client = new FakeClient({
    xhsPostCandidatesByHomepage: {
      'https://www.xiaohongshu.com/user/profile/xhs-limit-one': firstCandidates,
      'https://www.xiaohongshu.com/user/profile/xhs-limit-two': [
        xhsCandidate(secondUrl, { rect: { left: 120, top: 180, width: 120, height: 140 } }),
      ],
    },
    clickLandingUrls: [
      'https://www.xiaohongshu.com/explore/xhs-limit-one-0',
      'https://www.xiaohongshu.com/explore/xhs-limit-one-1',
      secondUrl,
    ],
    titleByUrl: {
      'https://www.xiaohongshu.com/explore/xhs-limit-one-0': '上限账号一第一条 - 小红书',
      'https://www.xiaohongshu.com/explore/xhs-limit-one-1': '上限账号一第二条 - 小红书',
      [secondUrl]: '上限账号二第一条 - 小红书',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      maxCandidatesPerAccount: 2,
    });

    assert.equal(result.success, 2);
    assert.equal(result.newItems, 3);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [
      'https://www.xiaohongshu.com/explore/xhs-limit-one-0',
      'https://www.xiaohongshu.com/explore/xhs-limit-one-1',
    ]);
    assert.deepEqual(result.details[1].items.map((item) => item.url), [secondUrl]);
    assert.equal(cardClicks(client).length, 3);
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
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
    assert.equal(cardClicks(client).length, 1);
    assert.equal(closeClicks(client).length, 1);
    assert.equal(client.gotos.filter((url) => url === acc.homepage_url).length, 1, 'detail close should keep homepage state without reopening it');
    assert.ok(cardClicks(client)[0].x > rect.left && cardClicks(client)[0].x < rect.left + rect.width);
    assert.ok(cardClicks(client)[0].y > rect.top && cardClicks(client)[0].y < rect.top + rect.height);
    assert.ok(cardClicks(client)[0].options.holdMs >= 140 && cardClicks(client)[0].options.holdMs <= 340);
    const saved = getContent(result.details[0].item.id);
    assert.equal(saved.like_count, 2001);
    assert.equal(saved.favorite_count, 3002);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol saves Xiaohongshu body text and hashtags from detail page', async () => {
  const postUrl = 'https://www.xiaohongshu.com/explore/body-tags-new';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '小红书正文账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/xhs-body-tags',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    postCandidates: [xhsCandidate(postUrl, { titleRaw: '正文标签候选' })],
    clickLandingUrls: [postUrl],
    titleByUrl: { [postUrl]: '正文标签候选 - 小红书' },
    bodyByUrl: { [postUrl]: '小红书正文内容 #选题雷达 #爆款拆解' },
    hashtagsByUrl: { [postUrl]: ['#选题雷达', '#爆款拆解'] },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      maxCandidatesPerAccount: 1,
    });

    assert.equal(result.newItems, 1);
    const saved = getContent(result.details[0].item.id);
    assert.match(saved.body_excerpt, /小红书正文内容/);
    assert.match(saved.body_excerpt, /#选题雷达/);
    assert.match(saved.body_excerpt, /#爆款拆解/);
    assert.equal(closeClicks(client).length, 1);
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
    assert.equal(cardClicks(client).length, 2);
    assert.equal(closeClicks(client).length, 1);
    assert.ok(client.gotos.filter((url) => url === acc.homepage_url).length >= 2, 'should return to the homepage before trying the next card');
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol finishes Xiaohongshu batches before opening Douyin batches', async () => {
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
    const xhsHome = homeGotos.find((e) => e.url.includes('xiaohongshu.com/user/profile/'));
    const firstDouyinHome = homeGotos.find((e) => e.url.includes('douyin.com/user/'));
    const firstDouyinVideo = events.find((e) => e.type === 'goto' && e.url.includes('/video/'));
    const closesBeforeDouyin = events.filter((e) => e.type === 'close' && e.i < firstDouyinHome.i);

    assert.equal(result.success, 3);
    assert.equal(result.maxTabsPerBatch, 2);
    assert.ok(xhsHome.i < firstDouyinHome.i, 'Xiaohongshu should open before Douyin even if requested second');
    assert.equal(closesBeforeDouyin.length, 1, 'Xiaohongshu tab should close before Douyin starts');
    assert.ok(firstDouyinVideo.i > Math.max(...homeGotos.filter((e) => e.url.includes('douyin.com/user/')).map((e) => e.i)), 'Douyin content processing starts after Douyin homepages in the batch are open');
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol defaults to batches of 6 and keeps platforms separated', async () => {
  const accounts = [];
  for (let i = 0; i < 12; i++) {
    const isDouyin = i % 2 === 0;
    accounts.push(upsertAccount({
      platform: isDouyin ? 'douyin' : 'xiaohongshu',
      nickname: `六个一批账号${i}`,
      homepage_url: isDouyin
        ? `https://www.douyin.com/user/batch5-${i}`
        : `https://www.xiaohongshu.com/user/profile/batch5-${i}`,
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
      clientFactory: async () => new BatchOrderedClient(shared, `batch5-${++seq}`),
    });

    const events = shared.events.map((e, i) => ({ ...e, i }));
    const homeGotos = events.filter((e) => e.type === 'goto' && /batch5-\d+/.test(e.url) && !e.url.includes('/video/'));
    const firstSixHomes = homeGotos.slice(0, 6);
    const seventhHome = homeGotos[6];
    const firstDouyinHome = homeGotos.find((e) => e.url.includes('douyin.com/user/'));
    const closesBeforeSeventh = events.filter((e) => e.type === 'close' && e.i < seventhHome.i);
    const closesBeforeDouyin = events.filter((e) => e.type === 'close' && e.i < firstDouyinHome.i);

    assert.equal(result.total, 12);
    assert.equal(result.maxTabsPerBatch, 6);
    assert.equal(homeGotos.length, 12);
    assert.ok(firstSixHomes.every((e) => e.url.includes('xiaohongshu.com/user/profile/')));
    assert.ok(seventhHome.url.includes('douyin.com/user/'), 'after six Xiaohongshu accounts, Douyin starts');
    assert.equal(closesBeforeSeventh.length, 6, 'all first-batch tabs close before Douyin starts');
    assert.equal(closesBeforeDouyin.length, 6, 'all Xiaohongshu tabs close before Douyin starts');
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol can reduce to one tab when free memory guard applies', async () => {
  const accounts = [];
  for (let i = 0; i < 6; i++) {
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

    assert.equal(result.maxTabsPerBatch, 1);
    const homeGotos = shared.events
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.type === 'goto' && e.url.includes('low-memory-'));
    const secondHome = homeGotos[1];
    const closesBeforeSecond = shared.events
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.type === 'close' && e.i < secondHome.i);
    assert.equal(homeGotos.length, 6);
    assert.equal(closesBeforeSecond.length, 1);
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol keeps platform order in single-tab fallback', async () => {
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
    clickLandingUrls: ['https://www.xiaohongshu.com/explore/single-no-like'],
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
    assert.ok(firstXhsGoto < firstDouyinGoto, 'single-tab fallback should finish Xiaohongshu before Douyin');
  } finally {
    for (const acc of accounts) {
      upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, priority: acc.priority, monitor_enabled: false });
    }
  }
});

test('runPatrol skips Xiaohongshu pinned cards but saves all usable detail metrics', async () => {
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
      xhsCandidate('https://www.xiaohongshu.com/explore/filter-pinned', { isPinned: true, cardText: '置顶 笔记', likeRaw: '9999', likeCount: 9999, rect: { left: 120, top: 180, width: 180, height: 160 } }),
      xhsCandidate('https://www.xiaohongshu.com/explore/filter-low', { likeRaw: '999', likeCount: 999, rect: { left: 320, top: 180, width: 180, height: 160 } }),
      xhsCandidate('https://www.xiaohongshu.com/explore/filter-unknown', { likeRaw: null, likeCount: null, rect: { left: 520, top: 180, width: 180, height: 160 } }),
      xhsCandidate(q1, { likeRaw: '1000+', likeCount: 1000, rect: { left: 720, top: 180, width: 180, height: 160 } }),
      xhsCandidate(q2, { likeRaw: '2.2万', likeCount: 22000, rect: { left: 920, top: 180, width: 180, height: 160 } }),
    ],
    clickLandingUrls: [
      'https://www.xiaohongshu.com/explore/filter-low',
      'https://www.xiaohongshu.com/explore/filter-unknown',
      q1,
      q2,
    ],
    titleByUrl: {
      'https://www.xiaohongshu.com/explore/filter-low': '低互动候选 - 小红书',
      'https://www.xiaohongshu.com/explore/filter-unknown': '未知卡片候选 - 小红书',
      [q1]: '筛选达标一 - 小红书',
      [q2]: '筛选达标二 - 小红书',
    },
    dataByUrl: {
      'https://www.xiaohongshu.com/explore/filter-low': { note: { interactInfo: { liked_count: '999', collected_count: '3002', comment_count: '8' } } },
      'https://www.xiaohongshu.com/explore/filter-unknown': { note: { interactInfo: { liked_count: '2001', collected_count: '999', comment_count: '8' } } },
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 4);
    assert.equal(cardClicks(client).length, 4);
    assert.equal(closeClicks(client).length, 4);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [
      'https://www.xiaohongshu.com/explore/filter-low',
      'https://www.xiaohongshu.com/explore/filter-unknown',
      q1,
      q2,
    ]);
    assert.equal(getContent(result.details[0].items[0].id).data_status, 'below_threshold');
    assert.equal(getContent(result.details[0].items[1].id).data_status, 'below_threshold');
    const reasons = result.details[0].skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('pinned'));
    assert.equal(reasons.includes('below_platform_threshold'), false);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol records a non-pinned detail even when its title matches a skipped pinned title', async () => {
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
    assert.equal(result.newItems, 1);
    assert.equal(result.details[0].item.url, candidateUrl);
    assert.equal(cardClicks(client).length, 1);
    assert.equal(closeClicks(client).length, 1);
    assert.equal(client.gotos.includes(pinnedUrl), false);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'pinned' && s.title.includes('旧置顶爆款标题')));
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'title_mismatch'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol saves detail pages with unknown publish time for later review', async () => {
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
    assert.equal(result.newItems, 1);
    assert.equal(cardClicks(client).length, 1);
    assert.equal(closeClicks(client).length, 1);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'unknown_time'));
    const saved = getContent(result.details[0].item.id);
    assert.equal(saved.publish_time, null);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol reads Xiaohongshu edited publish time from the detail layout', async () => {
  const url = 'https://www.xiaohongshu.com/explore/edited-time-detail';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '编辑时间账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/edited-time-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(url, { publishRaw: null, publishTime: null, titleRaw: '编辑时间候选' }),
    ],
    clickLandingUrls: [url],
    titleByUrl: {
      [url]: '编辑时间候选 - 小红书',
    },
    pubTimeByUrl: {
      [url]: '',
    },
    layoutPubTimeByUrl: {
      [url]: '编辑于 2026-05-31 10:20',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowStartISO: '2026-05-30T00:00:00.000Z',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    const saved = getContent(result.details[0].item.id);
    const savedTime = new Date(saved.publish_time);
    assert.equal(savedTime.getFullYear(), 2026);
    assert.equal(savedTime.getMonth(), 4);
    assert.equal(savedTime.getDate(), 31);
    assert.equal(savedTime.getHours(), 10);
    assert.equal(savedTime.getMinutes(), 20);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol records detail publish time before handling duplicate detail pages', async () => {
  const cardUrl = 'https://www.xiaohongshu.com/explore/detail-duplicate-card';
  const detailUrl = 'https://www.xiaohongshu.com/explore/detail-duplicate-existing';
  const nextUrl = 'https://www.xiaohongshu.com/explore/detail-duplicate-next';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '详情重复账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/detail-duplicate-account',
    monitor_enabled: true,
  });
  upsertCapture({
    url: detailUrl,
    platform: 'xiaohongshu',
    content_type: 'article',
    author_name: '详情重复账号',
    title: '已存在详情',
    metrics_source: 'manual',
    metrics_raw: { like: '2000', favorite: '2000' },
    publish_time: new Date().toISOString(),
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(cardUrl, { titleRaw: '详情重复候选', rect: { left: 120, top: 180, width: 180, height: 160 } }),
      xhsCandidate(nextUrl, { titleRaw: '详情重复后一条', rect: { left: 340, top: 180, width: 180, height: 160 } }),
    ],
    clickLandingUrls: [detailUrl, nextUrl],
    titleByUrl: {
      [detailUrl]: '详情重复候选 - 小红书',
      [nextUrl]: '详情重复后一条 - 小红书',
    },
    pubTimeByUrl: {
      [detailUrl]: '2小时前',
      [nextUrl]: '2小时前',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    assert.equal(result.success, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.newItems, 1);
    assert.equal(cardClicks(client).length, 2);
    assert.equal(closeClicks(client).length, 2);
    assert.equal(result.details[0].items[0].duplicate, true);
    assert.equal(result.details[0].items[1].url, nextUrl);
    assert.ok(result.details[0].items[0].publishTime, 'duplicate detail item should carry the normalized publish time');
    const savedAccount = get('SELECT last_seen_publish_time FROM accounts WHERE id = ?', [acc.id]);
    assert.equal(savedAccount.last_seen_publish_time, result.details[0].items[0].publishTime);
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol continues after already-seen Xiaohongshu content when publish time is still in window', async () => {
  const oldUrl = 'https://www.xiaohongshu.com/explore/already-seen-in-window';
  const nextUrl = 'https://www.xiaohongshu.com/explore/should-open-after-seen';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '已采集继续账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/already-continue-account',
    monitor_enabled: true,
  });
  upsertCapture({
    url: oldUrl,
    platform: 'xiaohongshu',
    content_type: 'article',
    author_name: '已采集继续账号',
    title: '已采集内容',
    metrics_source: 'manual',
    metrics_raw: { like: '2000', favorite: '2000' },
    publish_time: new Date().toISOString(),
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(oldUrl, { rect: { left: 120, top: 180, width: 180, height: 160 } }),
      xhsCandidate(nextUrl, { rect: { left: 340, top: 180, width: 180, height: 160 } }),
    ],
    clickLandingUrls: [oldUrl, nextUrl],
    titleByUrl: {
      [oldUrl]: '已采集内容 - 小红书',
      [nextUrl]: '已采集后一条 - 小红书',
    },
    pubTimeByUrl: {
      [oldUrl]: '2小时前',
      [nextUrl]: '2小时前',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowType: 'last_7_days',
    });

    assert.equal(result.success, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.newItems, 1);
    assert.equal(cardClicks(client).length, 2);
    assert.equal(closeClicks(client).length, 2);
    assert.equal(result.details[0].items[0].duplicate, true);
    assert.equal(result.details[0].items[1].url, nextUrl);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'already_seen'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol stops already-seen Xiaohongshu content only after publish time is out of window', async () => {
  const oldUrl = 'https://www.xiaohongshu.com/explore/already-seen-out-window';
  const nextUrl = 'https://www.xiaohongshu.com/explore/should-not-open-after-out-window-seen';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '已采集超窗账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/already-out-window-account',
    monitor_enabled: true,
  });
  upsertCapture({
    url: oldUrl,
    platform: 'xiaohongshu',
    content_type: 'article',
    author_name: '已采集超窗账号',
    title: '已采集旧内容',
    metrics_source: 'manual',
    metrics_raw: { like: '2000', favorite: '2000' },
    publish_time: '2026-05-20T00:00:00.000Z',
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(oldUrl, { rect: { left: 120, top: 180, width: 180, height: 160 } }),
      xhsCandidate(nextUrl, { rect: { left: 340, top: 180, width: 180, height: 160 } }),
    ],
    clickLandingUrls: [oldUrl, nextUrl],
    titleByUrl: {
      [oldUrl]: '已采集旧内容 - 小红书',
      [nextUrl]: '已采集超窗后一条 - 小红书',
    },
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
    assert.equal(result.duplicates, 1);
    assert.equal(result.newItems, 0);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [oldUrl]);
    assert.equal(cardClicks(client).length, 1);
    assert.equal(closeClicks(client).length, 0);
    assert.equal(client.gotos.includes(nextUrl), false);
    const reasons = result.details[0].skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('already_seen'));
    assert.ok(reasons.includes('out_of_window'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol saves out-of-window Xiaohongshu detail and stops the current account', async () => {
  const oldUrl = 'https://www.xiaohongshu.com/explore/out-of-window-card';
  const nextUrl = 'https://www.xiaohongshu.com/explore/should-open-after-old-card';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '超窗停止账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/out-window-card-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(oldUrl, { publishRaw: '2026-05-20', publishTime: '2026-05-20T00:00:00.000Z', rect: { left: 120, top: 180, width: 180, height: 160 } }),
      xhsCandidate(nextUrl, { rect: { left: 340, top: 180, width: 180, height: 160 } }),
    ],
    clickLandingUrls: [oldUrl, nextUrl],
    pubTimeByUrl: {
      [oldUrl]: '2026-05-20',
    },
    titleByUrl: {
      [oldUrl]: '超窗旧笔记 - 小红书',
      [nextUrl]: '超窗后一条新笔记 - 小红书',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowStartISO: '2026-05-30T00:00:00.000Z',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [oldUrl]);
    assert.equal(cardClicks(client).length, 1);
    assert.equal(closeClicks(client).length, 0);
    assert.equal(client.gotos.includes(nextUrl), false);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'out_of_window'));
  } finally {
    upsertAccount({ id: acc.id, platform: acc.platform, nickname: acc.nickname, homepage_url: acc.homepage_url, monitor_enabled: false });
  }
});

test('runPatrol uses Xiaohongshu edited time to stop when card time was unknown', async () => {
  const oldUrl = 'https://www.xiaohongshu.com/explore/out-of-window-detail';
  const nextUrl = 'https://www.xiaohongshu.com/explore/should-open-after-old-detail';
  const acc = upsertAccount({
    platform: 'xiaohongshu',
    nickname: '详情超窗账号',
    homepage_url: 'https://www.xiaohongshu.com/user/profile/out-window-detail-account',
    monitor_enabled: true,
  });
  const client = new FakeClient({
    xhsPostCandidates: [
      xhsCandidate(oldUrl, { publishRaw: null, publishTime: null, rect: { left: 120, top: 180, width: 180, height: 160 } }),
      xhsCandidate(nextUrl, { rect: { left: 340, top: 180, width: 180, height: 160 } }),
    ],
    clickLandingUrls: [oldUrl, nextUrl],
    pubTimeByUrl: {
      [oldUrl]: '',
      [nextUrl]: '2小时前',
    },
    layoutPubTimeByUrl: {
      [oldUrl]: '编辑于 2026-05-20',
    },
    titleByUrl: {
      [oldUrl]: '详情超窗旧笔记 - 小红书',
      [nextUrl]: '详情超窗后一条新笔记 - 小红书',
    },
  });

  try {
    const result = await runPatrol(client, {
      discoverFollows: false,
      platforms: ['xiaohongshu'],
      windowStartISO: '2026-05-30T00:00:00.000Z',
    });

    assert.equal(result.success, 1);
    assert.equal(result.newItems, 1);
    assert.deepEqual(result.details[0].items.map((item) => item.url), [oldUrl]);
    assert.equal(cardClicks(client).length, 1);
    assert.equal(closeClicks(client).length, 0);
    assert.equal(client.gotos.includes(nextUrl), false);
    assert.ok(result.details[0].skipReasons.some((s) => s.reason === 'out_of_window'));
    const saved = getContent(result.details[0].item.id);
    assert.equal(saved.publish_time.slice(0, 10), '2026-05-20');
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
      freeMemoryBytes: 20 * 1024 * 1024 * 1024,
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, detectPlatform } from '../server/ingest/scrape.js';

test('detectPlatform 按域名识别', () => {
  assert.equal(detectPlatform('https://www.douyin.com/video/123'), 'douyin');
  assert.equal(detectPlatform('https://www.xiaohongshu.com/explore/abc?xsec_token=x'), 'xiaohongshu');
  assert.equal(detectPlatform('https://mp.weixin.qq.com/s/abc'), 'wechat_article');
  assert.equal(detectPlatform('https://example.com/xx'), 'other');
  assert.equal(detectPlatform('https://example.com/x'), 'other');
  assert.equal(detectPlatform('not a url'), 'other');
});

test('小红书风格：从 __INITIAL_STATE__ 抓到 interactInfo（camelCase 也命中）', () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="我的爆款笔记" />
    <meta property="og:description" content="一些描述" />
    <title>小红书</title></head><body>
    <script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc":{"note":{"user":{"nickname":"增长小李"},"interactInfo":{"likedCount":"23000","collectedCount":"8901","commentCount":"1200","shareCount":"3400"}}}}}}</script>
    </body></html>`;
  const r = extractFromHtml(html, 'https://www.xiaohongshu.com/explore/abc?xsec_token=t');
  assert.equal(r.platform, 'xiaohongshu');
  assert.equal(r.title, '我的爆款笔记');
  assert.equal(r.author_name, '增长小李');
  assert.equal(r.metrics_raw.like, 23000);
  assert.equal(r.metrics_raw.favorite, 8901);
  assert.equal(r.metrics_raw.comment, 1200);
  assert.equal(r.metrics_raw.share, 3400);
  assert.deepEqual(r.found.sort(), ['comment', 'favorite', 'like', 'share']);
});

test('抖音风格：RENDER_DATA(URL编码) 里的 statistics', () => {
  const inner = JSON.stringify({ aweme: { detail: { statistics: { diggCount: 456000, shareCount: 12000, commentCount: 3200, collectCount: 6700, playCount: 9999999 } } } });
  const html = `<html><head><meta property="og:title" content="30万还原镜头"/></head><body>
    <script id="RENDER_DATA" type="application/json">${encodeURIComponent(inner)}</script>
    </body></html>`;
  const r = extractFromHtml(html, 'https://www.douyin.com/video/123');
  assert.equal(r.platform, 'douyin');
  assert.equal(r.metrics_raw.like, 456000);
  assert.equal(r.metrics_raw.share, 12000);
  // playCount 不被误当指标
});

test('诚实：纯 JS 外壳（无内嵌数据）→ 标题有，指标全 null', () => {
  const html = `<html><head><meta property="og:title" content="某视频"/></head>
    <body><div id="root"></div><script src="/app.js"></script></body></html>`;
  const r = extractFromHtml(html, 'https://www.douyin.com/video/999');
  assert.equal(r.title, '某视频');
  assert.deepEqual(r.metrics_raw, { like: null, share: null, comment: null, favorite: null });
  assert.deepEqual(r.found, []);
});

test('诚实：验证页 → blocked=true', () => {
  const html = `<html><body>请完成安全验证 captcha 滑块</body></html>`;
  const r = extractFromHtml(html, 'https://www.douyin.com/video/999');
  assert.equal(r.blocked, true);
  assert.deepEqual(r.found, []);
});

test('公众号文章：抽取标题、作者、正文和北京时间发布时间，指标未知保持 null', () => {
  const html = `<!doctype html><html><head><title>备用标题</title></head><body>
    <h1 id="activity-name">增长复盘 &amp; 选题观察</h1>
    <span id="publish_time" class="rich_media_meta rich_media_meta_text">2026年06月03日 08:30</span>
    <a id="js_name">公众号作者</a>
    <div id="js_content">
      <p>第一段正文。</p>
      <p>第二段正文，包含 &amp; HTML 实体。</p>
    </div>
    <script>var appmsg_token = "x";</script>
  </body></html>`;

  const r = extractFromHtml(html, 'https://mp.weixin.qq.com/s/article1');
  assert.equal(r.platform, 'wechat_article');
  assert.equal(r.content_type, 'article');
  assert.equal(r.title, '增长复盘 & 选题观察');
  assert.equal(r.author_name, '公众号作者');
  assert.match(r.body_excerpt, /第一段正文/);
  assert.match(r.body_excerpt, /第二段正文，包含 & HTML 实体/);
  assert.equal(r.publish_time, '2026-06-03T00:30:00.000Z');
  assert.deepEqual(r.metrics_raw, { like: null, share: null, comment: null, favorite: null });
  assert.deepEqual(r.found, []);
});

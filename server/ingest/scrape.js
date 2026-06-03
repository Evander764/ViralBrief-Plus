/**
 * URL 抓取入库（服务端 fetch + 解析）。
 *
 * 诚实边界（务必读）：
 * - 纯 HTTP 抓取这些平台「尽力而为」：小红书有时把数据放在 __INITIAL_STATE__ /
 *   抖音放在 RENDER_DATA，能抓到；但很多时候只拿到 JS 外壳或反爬验证页，抓不到数字。
 * - 抓到的数字一律 metrics_source='scraped' → 进 needs_review（待复核），不自动入榜。
 *   原因：平台可能返回 0 / 假数据 / 验证页，关键数据必须经人确认才可信（项目铁律）。
 * - 不做：验证码识别、签名伪造、代理池、登录态盗用——那是军备竞赛，且越界。
 * - 解析复用已测的 extension/extract-core.js，不重复造轮子。
 */
import { METRIC_KEYS, parseCount, deriveMetrics } from '../../extension/extract-core.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function detectPlatform(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'other'; }
  if (host.includes('douyin.com') || host.includes('iesdouyin.com')) return 'douyin';
  if (host.includes('xiaohongshu.com') || host.includes('xhslink')) return 'xiaohongshu';
  if (host.includes('mp.weixin.qq.com')) return 'wechat_article';
  if (host.includes('weixin.qq.com')) return 'wechat_article';
  return 'other';
}

const tag = (html, re) => { const m = html.match(re); return m ? m[1].trim() : null; };
const metaContent = (html, name) => tag(html,
  new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'))
  || tag(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'));
const decodeHtml = (s) => String(s || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
  })
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    const code = Number.parseInt(n, 16);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
  });
const cleanText = (s) => decodeHtml(s).replace(/\s+/g, ' ').trim();
const textById = (html, id) => tag(html, new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'));

/** 直接对原始（可能不是合法 JSON 的）文本按字段名正则取值——比 JSON.parse 更耐脏。 */
function pickByKeyRegex(text) {
  const out = { like: null, share: null, comment: null, favorite: null };
  if (!text) return out;
  for (const [metric, keys] of Object.entries(METRIC_KEYS)) {
    for (const k of keys) {
      // "i" 让 diggcount 也能匹配 "diggCount"
      const m = text.match(new RegExp(`["']${k}["']\\s*:\\s*["']?([0-9][0-9.,]*\\s*[wWkK万千]?)["']?`, 'i'));
      if (m) { const n = parseCount(m[1]); if (n !== null) { out[metric] = n; break; } }
    }
  }
  return out;
}

const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .slice(0, 8000);

function stripTagsClean(html, limit = 1000) {
  return cleanText(stripTags(html)).slice(0, limit);
}

function parseWechatPublishTime(html) {
  const seconds = tag(html, /\b(?:ct|createTime|publish_time|publishTime)\b\s*[:=]\s*["']?(\d{10,13})["']?/i);
  if (seconds) {
    const n = Number(seconds);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const visible = cleanText(textById(html, 'publish_time') || tag(html, /class=["'][^"']*rich_media_meta_text[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i) || '');
  const m = visible.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  // 公众号发布时间展示按北京时间处理，避免受本机时区影响。
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(s))).toISOString();
}

function extractWechatArticleFields(html) {
  const bodyHtml = tag(html, /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<script|<\/body>|<\/html>)/i)
    || tag(html, /<article[^>]*>([\s\S]*?)<\/article>/i)
    || '';
  return {
    title: cleanText(textById(html, 'activity-name') || metaContent(html, 'og:title') || tag(html, /<title[^>]*>([^<]+)<\/title>/i) || ''),
    author_name: cleanText(textById(html, 'js_name') || tag(html, /class=["'][^"']*account_nickname_inner[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)
      || metaContent(html, 'og:author') || metaContent(html, 'author') || ''),
    body_excerpt: stripTagsClean(bodyHtml || metaContent(html, 'og:description') || metaContent(html, 'description') || '', 1000),
    publish_time: parseWechatPublishTime(html),
  };
}

/**
 * 纯函数：从一段 HTML 里尽力抽取信息。无网络，可单测。
 * @returns {{platform, content_type, title, author_name, body_excerpt, metrics_raw, found:string[], blocked:boolean}}
 */
export function extractFromHtml(html, url) {
  const platform = detectPlatform(url);
  const content_type = platform === 'douyin' ? 'video' : 'article';
  const wechatArticle = platform === 'wechat_article' ? extractWechatArticleFields(html) : null;

  const title = wechatArticle?.title || metaContent(html, 'og:title') || tag(html, /<title[^>]*>([^<]+)<\/title>/i) || '';
  const author = metaContent(html, 'og:author') || metaContent(html, 'author')
    || tag(html, /["']nickname["']\s*:\s*["']([^"']{1,40})["']/);
  const body = wechatArticle?.body_excerpt || (metaContent(html, 'og:description') || metaContent(html, 'description') || '').slice(0, 1000);

  // 候选数据块：含指标字段名的 <script>，外加抖音 RENDER_DATA（URL 编码）
  const blobs = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const t = m[1];
    if (t && t.length > 30 && /(diggCount|liked_count|like_count|likeCount|shareCount|share_count|commentCount|collectCount|interactInfo|statistics)/i.test(t)) {
      blobs.push(t);
    }
  }
  const renderData = tag(html, /<script[^>]*id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i);
  if (renderData) { try { blobs.push(decodeURIComponent(renderData)); } catch { blobs.push(renderData); } }

  const visibleText = stripTags(html);

  // 1) 按字段名正则（最稳，对脏 JSON 也有效）
  const byKey = pickByKeyRegex(blobs.join('\n'));
  // 2) 结构化 + 正文兜底（复用 extract-core 的已测逻辑）
  const derived = deriveMetrics({
    dataBlobs: blobs.map((b) => { const i = b.indexOf('{'); const j = b.lastIndexOf('}'); return i !== -1 && j > i ? b.slice(i, j + 1) : b; }),
    domTexts: {},
    textSample: visibleText,
  });

  const metrics_raw = {};
  const found = [];
  for (const k of ['like', 'share', 'comment', 'favorite']) {
    const v = byKey[k] !== null ? byKey[k] : derived[k];
    metrics_raw[k] = v;
    if (v !== null) found.push(k);
  }

  // 反爬/验证页启发式：没抓到任何指标且页面像验证/登录页
  const blocked = found.length === 0 && /(验证码|滑块|安全验证|请完成验证|verify|captcha|login|登录后查看|帮你识别)/i.test(visibleText);

  return {
    platform,
    content_type,
    title: cleanText(title),
    author_name: wechatArticle?.author_name || cleanText(author || ''),
    body_excerpt: body,
    publish_time: wechatArticle?.publish_time || null,
    metrics_raw,
    found,
    blocked,
  };
}

/** 抓取一个 URL 并解析。网络失败/超时返回 { ok:false, note }。 */
export async function fetchAndExtract(url, { timeoutMs = 15000 } = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, note: 'URL 格式不合法' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, note: '只支持 http/https 链接' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    const html = await res.text();
    const extracted = extractFromHtml(html, url);
    const ok = res.ok;
    let note = '';
    if (!ok) note = `平台返回 HTTP ${res.status}`;
    else if (extracted.blocked) note = '疑似被反爬/验证页拦截，未取到指标——请改用插件在登录后的页面采集，或手动补录。';
    else if (extracted.found.length === 0) note = '页面已抓取，但未在 HTML 中找到点赞/转发数（多为 JS 动态渲染）。标题等已带回，指标请手动补录。';
    else if (!extracted.found.includes('like') || !extracted.found.includes('share')) note = '部分指标已抓到，点赞或转发仍缺，请补录后再确认。';
    return { ok: true, httpStatus: res.status, url, ...extracted, note };
  } catch (e) {
    const msg = /aborted|abort/i.test(String(e.message)) ? `抓取超时（>${timeoutMs}ms）` : `抓取失败：${e.message}`;
    return { ok: false, url, note: msg };
  } finally {
    clearTimeout(timer);
  }
}

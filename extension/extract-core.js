/**
 * 采集解析核心（纯函数，可在 Node 里单测；浏览器里由 popup.js import）。
 *
 * 设计：注入页面的 pageExtract 只负责「采集原料」（候选 JSON 字符串、DOM 文本、
 * aria 标签、正文样本），真正「从原料里挑出 点赞/转发/评论/收藏」的逻辑放这里，
 * 这样能脱离浏览器单测。
 *
 * 为什么这样更稳：各平台改版时 CSS class 经常变，但接口/内嵌数据里的字段名
 * （diggCount / liked_count / share_count …）相对稳定。优先读这些结构化数据，
 * 读不到再退回 DOM、再退回正文正则。
 */

// 各指标对应的「精确字段名」候选（小写比较）。放精确名是为了避免把
// 播放量 playCount / 粉丝数 followerCount 之类误当成点赞。
const METRIC_KEYS = {
  like: ['diggcount', 'digg_count', 'likedcount', 'liked_count', 'likecount', 'like_count', 'praisenum', 'praise_num'],
  share: ['sharecount', 'share_count', 'sharednum', 'shared_count', 'forwardcount', 'forward_count', 'transpond_count'],
  comment: ['commentcount', 'comment_count', 'commentscount', 'comments_count', 'commentnum', 'comment_num'],
  favorite: ['collectcount', 'collect_count', 'collectedcount', 'collected_count', 'favoritecount', 'favorite_count', 'collectnum'],
};

/**
 * 把展示文本/数字解析成整数。识别不到返回 null（未知，绝不当 0）。
 * 与服务端 normalize.js 同源逻辑，但这里独立实现（插件不依赖服务端代码）。
 */
export function parseCount(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  let s = String(raw).trim();
  if (!s) return null;
  // 全角转半角
  s = s.replace(/[０-９．＋，]/g, (c) => '0123456789.+,'['０１２３４５６７８９．＋，'.indexOf(c)] || c);
  const m = s.match(/(\d[\d,]*\.?\d*)\s*([kKwWmM千万亿]?)/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = { k: 1e3, K: 1e3, 千: 1e3, w: 1e4, W: 1e4, 万: 1e4, m: 1e6, M: 1e6, 亿: 1e8 }[m[2]] || 1;
  return Math.round(num * unit);
}

/** 递归遍历对象，按精确字段名收集各指标的「第一个合理值」。 */
export function pickMetricsFromObject(obj, found = { like: null, share: null, comment: null, favorite: null }, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return found;
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (v && typeof v === 'object') {
      pickMetricsFromObject(v, found, depth + 1);
    } else {
      for (const metric of ['like', 'share', 'comment', 'favorite']) {
        if (found[metric] === null && METRIC_KEYS[metric].includes(key)) {
          const n = parseCount(v);
          if (n !== null) found[metric] = n;
        }
      }
    }
  }
  return found;
}

/** 从一段 JSON 字符串里尽量解析出指标（解析失败返回全 null）。 */
export function pickMetricsFromJsonString(str) {
  const empty = { like: null, share: null, comment: null, favorite: null };
  if (!str || typeof str !== 'string') return empty;
  try {
    return pickMetricsFromObject(JSON.parse(str));
  } catch {
    return empty;
  }
}

/** 从任意文本里「关键词 + 数字」就近匹配某个指标。 */
export function findMetricInText(text, keywords) {
  if (!text) return null;
  // 关键词在数字前（赞 1.2万）或数字在关键词前（1.2万 赞）都试。
  const kw = keywords.join('|');
  const before = new RegExp(`(?:${kw})\\s*[:：]?\\s*([\\d.,]+\\s*[万千wkWK]?\\+?)`, 'i');
  const after = new RegExp(`([\\d.,]+\\s*[万千wkWK]?\\+?)\\s*(?:${kw})`, 'i');
  const hit = text.match(before) || text.match(after);
  return hit ? parseCount(hit[1]) : null;
}

function strongestConfidence(evidence) {
  const rank = { structured: 3, dom: 2, text: 1 };
  let best = null;
  for (const e of Object.values(evidence)) {
    if (!e?.source) continue;
    if (!best || rank[e.source] > rank[best]) best = e.source;
  }
  return best || 'none';
}

const KW = {
  like: ['赞', '点赞', 'like', 'likes', 'digg'],
  share: ['转发', '分享', 'share', 'shares', '转'],
  comment: ['评论', 'comment', 'comments'],
  favorite: ['收藏', 'collect', 'favorite', 'saved'],
};

/**
 * 汇总：从「采集原料」推导最终指标。优先级：
 *   内嵌结构化数据(dataBlobs) > DOM/aria 文本(domTexts) > 正文正则(textSample)。
 * 每个指标独立取值；任一来源拿到就锁定，绝不被后续较弱来源覆盖。
 * 返回 { like, share, comment, favorite }，值为整数或 null。
 */
export function deriveMetrics(raw = {}) {
  return deriveMetricsWithEvidence(raw).metrics;
}

export function deriveMetricsWithEvidence(raw = {}) {
  const out = { like: null, share: null, comment: null, favorite: null };
  const evidence = { like: null, share: null, comment: null, favorite: null };
  const fill = (src, source, rawText = {}) => {
    for (const m of ['like', 'share', 'comment', 'favorite']) {
      if (out[m] === null && src[m] !== null && src[m] !== undefined) {
        out[m] = src[m];
        evidence[m] = {
          source,
          raw: rawText[m] ?? src[m],
          value: src[m],
        };
      }
    }
  };

  // 1) 结构化内嵌数据（最稳）
  for (const blob of raw.dataBlobs || []) {
    fill(pickMetricsFromJsonString(blob), 'structured');
    if (out.like !== null && out.share !== null && out.comment !== null && out.favorite !== null) break;
  }

  // 2) DOM/aria 文本（popup 已就近取好的字符串）
  if (raw.domTexts) {
    fill({
      like: parseCount(raw.domTexts.like),
      share: parseCount(raw.domTexts.share),
      comment: parseCount(raw.domTexts.comment),
      favorite: parseCount(raw.domTexts.favorite),
    }, 'dom', raw.domTexts);
  }

  // 3) 正文/aria 正则兜底
  const text = raw.textSample || '';
  fill({
    like: findMetricInText(text, KW.like),
    share: findMetricInText(text, KW.share),
    comment: findMetricInText(text, KW.comment),
    favorite: findMetricInText(text, KW.favorite),
  }, 'text');

  return { metrics: out, evidence, confidence: strongestConfidence(evidence) };
}

export { METRIC_KEYS, KW };

/**
 * 指标标准化 —— 把平台上五花八门的展示文本统一转成整数。
 *
 * 这是「关键数据绝不出错」的第一道关口，因此：
 *   - 纯确定性逻辑，不经过 AI；
 *   - 「无法识别」一律返回 value=null（表示「未知/缺失」），
 *     而不是 0。null 与 0 的区别决定了内容是进入 missing_share（待补录）
 *     还是 below_threshold（确定不达标），二者绝不能混淆。
 *   - 永远保留原始文本 raw，便于人工复核与审计。
 *
 * 覆盖：1k / 1.2k / 1w / 1.2w / 1万 / 1.5万 / 1000+ / 1万+ / 12,300 / 全角数字 等。
 */

const FULLWIDTH = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '．': '.', '＋': '+', '，': ',',
};

function toHalfWidth(s) {
  return s.replace(/[０-９．＋，]/g, (ch) => FULLWIDTH[ch] || ch);
}

// 单位倍率。中英文混排都覆盖。
const UNIT = {
  k: 1e3, K: 1e3, '千': 1e3,
  w: 1e4, W: 1e4, '万': 1e4,
  m: 1e6, M: 1e6,
  '亿': 1e8,
};

/**
 * @param {string|number|null|undefined} raw 原始展示值
 * @returns {{raw: string|null, value: number|null}}
 */
export function normalizeMetric(raw) {
  if (raw === null || raw === undefined) return { raw: null, value: null };

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { raw: String(raw), value: null };
    return { raw: String(raw), value: Math.round(raw) };
  }

  const original = String(raw);
  const s = toHalfWidth(original).trim();
  if (!s) return { raw: original, value: null };

  // 抓取第一个数字（允许千分位逗号与小数点），后面可选紧跟一个单位字符。
  const m = s.match(/(\d[\d,]*\.?\d*)\s*([kKwWmM千万亿]?)/);
  if (!m) return { raw: original, value: null };

  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return { raw: original, value: null };

  const mult = m[2] ? (UNIT[m[2]] || 1) : 1;
  return { raw: original, value: Math.round(num * mult) };
}

/**
 * 批量标准化一组指标。输入形如 { like: '1.2w', share: '1500' }。
 * 返回 { like: {raw, value}, share: {raw, value}, ... }。
 */
export function normalizeMetrics(metricsRaw = {}) {
  const out = {};
  for (const [key, val] of Object.entries(metricsRaw)) {
    out[key] = normalizeMetric(val);
  }
  return out;
}

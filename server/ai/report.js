/**
 * 日报内容归类数据生成（母题 + 改写标题 + 承接建议）。
 *
 * 反幻觉是分层的，且全部确定性、可单测（见 skills/report-guard）：
 *  - validateReportData：拒绝「引用不存在的编号」「文本里编造的数字」「少样本结论性措辞」→ 触发带原因重试
 *  - normalizeReportData：确定性补「可能原因：/建议方向：」前缀、截断超量标题（零 token、幂等）
 *  - temperature 0.15：降低随机编造
 *  - 少样本独立 prompt + 强制样本量警告
 *
 * 编造数字的判据：AI 文本里任何 ≥1000 且不在「真实指标 ∪ 源标题数字 ∪ 条数」中的数字，都判为编造。
 * 源标题数字算合法，是因为 rewrite_titles 会正当地复述原标题里的数字。
 */
import { loadConfig } from '../config.js';
import { callJSON } from './client.js';
import {
  SYSTEM_REPORT, SYSTEM_REPORT_FEW, SYSTEM_REPORT_WECHAT, SYSTEM_REPORT_FEW_WECHAT, buildReportUser,
} from './prompts.js';
import { windowLabel } from '../filter.js';

const LOW_SAMPLE_FORBIDDEN_TERMS = ['趋势', '聚焦', '集中', '呈现出', '反映出', '表明'];

/** 收集「合法数字」集合：真实指标 + 源标题里出现的数字 + 条数。 */
export function collectRealNumbers(items) {
  const real = new Set();
  const addFromText = (s) => {
    for (const m of String(s ?? '').matchAll(/[\d,]+/g)) {
      const n = Number(m[0].replace(/,/g, ''));
      if (!Number.isNaN(n)) real.add(n);
    }
  };
  for (const it of items) {
    for (const v of [it.like_count, it.share_count, it.comment_count, it.favorite_count]) {
      if (v != null) real.add(Number(v));
    }
    addFromText(it.title); // 改写标题会复述源标题里的数字，这些是合法的
  }
  real.add(items.length); // 条数也合法
  return real;
}

/** 在一段文本里找出第一个「编造的」数字（≥1000 且不在 real 集合）。找不到返回 null。 */
export function findFabricatedNumber(text, real) {
  if (!text) return null;
  for (const m of String(text).matchAll(/[\d,]+/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (n >= 1000 && !real.has(n)) return n;
  }
  return null;
}

/** 收集一份日报数据里所有「会被渲染给用户」的 AI 自由文本（数字扫描的范围）。 */
function renderedTexts(json) {
  const texts = [];
  if (json.daily_summary) texts.push(json.daily_summary);
  for (const c of json.top_topic_clusters || []) {
    if (c.cluster_name) texts.push(c.cluster_name);
    if (c.why_it_spread) texts.push(c.why_it_spread);
    for (const t of c.rewrite_titles || []) if (t) texts.push(String(t));
  }
  for (const a of json.recommended_actions || []) if (a) texts.push(String(a));
  for (const w of json.data_warnings || []) if (w) texts.push(String(w));
  return texts;
}

function lowSampleConclusionTexts(json) {
  const texts = [];
  if (json.daily_summary) texts.push(json.daily_summary);
  for (const c of json.top_topic_clusters || []) {
    if (c.cluster_name) texts.push(c.cluster_name);
    if (c.why_it_spread) texts.push(c.why_it_spread);
  }
  for (const a of json.recommended_actions || []) if (a) texts.push(String(a));
  for (const w of json.data_warnings || []) if (w) texts.push(String(w));
  return texts;
}

/** 纯函数校验：结构 / 引用编号 / 编造数字 / 少样本措辞。返回错误原因字符串，或 null 表示通过。 */
export function validateReportData(json, { items, isFewShot }) {
  if (!json || typeof json !== 'object') return '不是对象';
  if (!Array.isArray(json.top_topic_clusters)) return '缺少 top_topic_clusters 数组';

  const validRefs = new Set(items.map((_, i) => `C${i + 1}`));
  if (isFewShot && json.top_topic_clusters.length > items.length) {
    return `少样本模式下 cluster 数量（${json.top_topic_clusters.length}）不应超过内容条数（${items.length}）`;
  }
  for (const c of json.top_topic_clusters) {
    const refs = c.representative_content_ids || c.representative_contents || [];
    for (const r of refs) {
      if (!validRefs.has(String(r))) return `引用了不存在的编号 ${r}`;
    }
    if (c.cluster_name && c.cluster_name.length > 30) {
      return `cluster_name 过长（${c.cluster_name.length}字），请控制在 15 字以内`;
    }
  }

  // 数字反幻觉：扫描所有会被渲染的 AI 文本，任何编造的 ≥1000 数字都拒绝。
  const real = collectRealNumbers(items);
  for (const t of renderedTexts(json)) {
    const bad = findFabricatedNumber(t, real);
    if (bad != null) {
      return `AI 文本出现了不在达标清单中的数字 ${bad}；所有数字由系统从数据库渲染，请移除文本里的全部具体数字`;
    }
  }

  if (items.length <= 3) {
    for (const t of lowSampleConclusionTexts(json)) {
      const term = LOW_SAMPLE_FORBIDDEN_TERMS.find((word) => String(t).includes(word));
      if (term) {
        return `样本量仅 ${items.length} 条，AI 文本不得使用结论性措辞「${term}」`;
      }
    }
  }
  return null;
}

/** 确定性归一：截断超量改写标题 + 强制认知前缀。不调用 AI、零 token、幂等。 */
export function normalizeReportData(json) {
  const ensurePrefix = (s, prefix) => {
    const t = String(s).trim();
    return t.startsWith(prefix) ? t : prefix + t;
  };
  for (const c of json.top_topic_clusters || []) {
    if (Array.isArray(c.rewrite_titles) && c.rewrite_titles.length > 5) {
      c.rewrite_titles = c.rewrite_titles.slice(0, 5);
    }
    // why_it_spread 是推测不是事实，强制「可能原因：」前缀，杜绝把猜测写成定论。
    if (c.why_it_spread) c.why_it_spread = ensurePrefix(c.why_it_spread, '可能原因：');
  }
  if (Array.isArray(json.recommended_actions)) {
    json.recommended_actions = json.recommended_actions
      .filter(Boolean)
      .map((a) => ensurePrefix(a, '建议方向：'));
  }
  return json;
}

export async function generateReportData({ windowType, items, analyses, reportType = 'web' }) {
  const cfg = loadConfig();

  // 少样本（≤2 条）使用精简 prompt，不做方向推断
  const isFewShot = items.length <= 2;
  const isWechat = reportType === 'wechat';
  const systemPrompt = isWechat
    ? (isFewShot ? SYSTEM_REPORT_FEW_WECHAT : SYSTEM_REPORT_WECHAT)
    : (isFewShot ? SYSTEM_REPORT_FEW : SYSTEM_REPORT);

  const { json, model } = await callJSON({
    system: systemPrompt,
    user: buildReportUser(windowLabel(windowType), items, analyses, { reportType }),
    model: cfg.reportModel || cfg.model,
    task: 'report',
    // 降低 temperature 以减少随机编造（0.15 比 0.4 显著降低幻觉率）
    temperature: 0.15,
    maxTokens: 4000,
    validate: (j) => validateReportData(j, { items, isFewShot }),
  });

  // 确定性归一（前缀 + 截断）
  normalizeReportData(json);

  // 后处理：确保 data_warnings 包含少样本提示
  if (isFewShot) {
    json.data_warnings = json.data_warnings || [];
    if (!json.data_warnings.some((w) => w.includes('样本'))) {
      json.data_warnings.unshift(`样本量极少（仅 ${items.length} 条），不做方向结论。`);
    }
  }

  return { data: json, model };
}

/**
 * 筛选引擎 —— 平台必需互动指标 + 时间窗口 + 数据状态分层。
 *
 * 全部为确定性逻辑，不经过 AI。是否「达标入榜」完全由这里决定，
 * 因此关键判定不可能因为模型幻觉而出错。
 */

export const THRESHOLD = 1000;
export const ELIGIBLE_TYPES = ['video', 'article'];
export const ELIGIBLE_PLATFORMS = ['douyin', 'xiaohongshu'];
export const QUALIFYING_METRICS = ['like', 'share', 'favorite'];
export const PLATFORM_REQUIRED_METRICS = {
  xiaohongshu: ['like', 'favorite'],
  douyin: ['like', 'favorite', 'share'],
};

/**
 * 平台常用第二指标的兼容辅助。当前入选口径由
 * PLATFORM_REQUIRED_METRICS 决定；这里保留给旧调用方和平台展示逻辑使用。
 */
export const SECOND_METRIC = { douyin: 'share', xiaohongshu: 'favorite', wechat_channels: 'share' };
export function secondMetric(platform) { return SECOND_METRIC[platform] || 'share'; }
/** 该平台第二指标对应的数据库列名。 */
export function secondMetricCol(platform) {
  return secondMetric(platform) === 'favorite' ? 'favorite_count' : 'share_count';
}

/** 人工/授权/稳定页面证据被视为可信；OCR 或弱文本推断需人工确认后才可信。 */
export function isTrustedSource(src, confidence = null) {
  if (src === 'manual' || src === 'authorized') return true;
  if ((src === 'rpa' || src === 'rpa_structured' || src === 'rpa_dom')
      && ['structured', 'dom'].includes(confidence)) return true;
  return false;
}

const known = (v) => v !== null && v !== undefined && v !== '';
const hasPlus = (v) => /\+/.test(String(v ?? ''));
const trustedConfidence = (v) => ['structured', 'dom', 'manual'].includes(String(v || ''));

function metricValue(c, metric) {
  return c[`${metric}_count`];
}

function metricRaw(c, metric) {
  return c[`${metric}_raw`];
}

function metricEvidence(c, metric) {
  try {
    const evidence = typeof c.metrics_evidence_json === 'string'
      ? JSON.parse(c.metrics_evidence_json)
      : c.metrics_evidence_json;
    return evidence?.[metric] || null;
  } catch {
    return null;
  }
}

export function metricExceedsThreshold(c, metric) {
  const value = metricValue(c, metric);
  if (!known(value)) return false;
  if (Number(value) > THRESHOLD) return true;
  return Number(value) >= THRESHOLD && (hasPlus(metricRaw(c, metric)) || hasPlus(metricEvidence(c, metric)?.raw));
}

export function qualifyingMetrics(c) {
  return QUALIFYING_METRICS.filter((metric) => metricExceedsThreshold(c, metric));
}

function metricConfidence(c, metric) {
  return metricEvidence(c, metric)?.source || c.metrics_confidence || null;
}

export function trustedQualifyingMetrics(c) {
  if (c.user_confirmed === 1 || c.user_confirmed === true || ['manual', 'authorized'].includes(c.metrics_source)) {
    return qualifyingMetrics(c);
  }
  return QUALIFYING_METRICS.filter((metric) => (
    metricExceedsThreshold(c, metric)
    && metricIsTrusted(c, metric)
  ));
}

export function requiredMetricsForPlatform(platform) {
  return PLATFORM_REQUIRED_METRICS[platform] || QUALIFYING_METRICS;
}

export function trustedRequiredMetrics(c) {
  return requiredMetricsForPlatform(c.platform).filter((metric) => (
    metricExceedsThreshold(c, metric)
    && (
      c.user_confirmed === 1
      || c.user_confirmed === true
      || ['manual', 'authorized'].includes(c.metrics_source)
      || metricIsTrusted(c, metric)
    )
  ));
}

export function platformThresholdMet(c) {
  const required = requiredMetricsForPlatform(c.platform);
  const met = trustedRequiredMetrics(c);
  return required.every((metric) => met.includes(metric));
}

function requiredMetricKnown(c, metric) {
  return known(metricValue(c, metric));
}

function metricIsTrusted(c, metric) {
  const evidence = metricEvidence(c, metric);
  if (evidence?.source) return trustedConfidence(evidence.source);
  return isTrustedSource(c.metrics_source, c.metrics_confidence);
}

export function eligibleReason(c) {
  const labels = { like: '点赞', share: '转发/分享', favorite: '收藏' };
  const parts = trustedRequiredMetrics(c).map((metric) => {
    const raw = metricRaw(c, metric) || metricEvidence(c, metric)?.raw;
    const value = metricValue(c, metric);
    return `${labels[metric]} ${raw || value}`;
  });
  return parts.length ? `${parts.join('，')} 均达标` : null;
}

/**
 * 计算单条内容的 data_status。优先级经过精心设计：
 *   duplicate > archived > monitoring(未确认且 24h 内)
 *   > needs_review(未确认自动数据/缺关键值) > confirmed / below_threshold
 *
 * 关键原则「无法确认就不入榜」：只有 confirmed 才能进入正式日报。
 */
export function computeDataStatus(c) {
  if (c.is_duplicate === 1 || c.is_duplicate === true) return 'duplicate';
  if (c.archived === 1 || c.archived === true) return 'archived';

  const trusted =
    c.user_confirmed === 1 || c.user_confirmed === true || isTrustedSource(c.metrics_source, c.metrics_confidence);

  // 自动弱识别的数据在用户确认前一律视为需复核，绝不自动当作达标。
  if (!trusted) {
    if (c.publish_time) {
      const pubTime = new Date(c.publish_time).getTime();
      if (!Number.isNaN(pubTime)) {
        const ageHours = (Date.now() - pubTime) / (1000 * 60 * 60);
        if (ageHours < 24) return 'monitoring';
      }
    }
    return 'needs_review';
  }

  if (platformThresholdMet(c)) return 'confirmed';

  const required = requiredMetricsForPlatform(c.platform);
  if (required.some((metric) => metricExceedsThreshold(c, metric) && !trustedRequiredMetrics(c).includes(metric))) {
    return 'needs_review';
  }

  const hasAllRequired = required.every((metric) => requiredMetricKnown(c, metric));
  return hasAllRequired ? 'below_threshold' : 'needs_review';
}

/**
 * 从 'last_N_day(s)' 解析出天数。解析不出则按 1 天兜底。
 * 单复数都接受（last_1_day / last_1_days / last_20_days）。
 */
export function windowDays(windowType) {
  const m = String(windowType).match(/^last_(\d+)_days?$/);
  const days = m ? Number(m[1]) : 1;
  return days >= 1 ? days : 1;
}

/** 规范化窗口字符串：任意输入 → 'last_N_days'（统一复数，避免单复数两套格式不一致）。 */
export function normalizeWindowType(windowType) {
  return `last_${windowDays(windowType)}_days`;
}

/** 窗口的中文标签：动态生成「最近 N 天」，支持任意天数（不再依赖硬编码表）。 */
export function windowLabel(windowType) {
  return `最近 ${windowDays(windowType)} 天`;
}

/**
 * 滚动时间窗口的起点（ISO 字符串，UTC）。
 * 支持任意天数：'last_N_days' 格式（如 last_1_day、last_5_days、last_14_days）。
 * @param {string} windowType  形如 'last_N_day(s)'
 */
export function windowStartISO(windowType, now = new Date()) {
  const ms = windowDays(windowType) * 24 * 3600 * 1000;
  return new Date(now.getTime() - ms).toISOString();
}

/**
 * 最终入选判定（防御性二次校验）。
 * data_status === 'confirmed' 已经隐含了平台所需指标达标，但这里再显式核一遍，
 * 宁可多写几行也要保证「绝不把不达标的算成达标」。
 */
export function isEligible(c) {
  return (
    c.data_status === 'confirmed' &&
    ELIGIBLE_PLATFORMS.includes(c.platform) &&
    known(c.account_id) &&
    ELIGIBLE_TYPES.includes(c.content_type) &&
    platformThresholdMet(c)
  );
}

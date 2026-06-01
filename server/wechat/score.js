/**
 * 视频号 / 公众号「热点」时间衰减评分 —— 纯确定性逻辑，不经过 AI。
 *
 * 思路（对应用户规格「如果在多少小时以内，数据达到多少，就如何如何；
 * 如果超过了某个临界点，那就正常判断各项数据」）：
 *   - 早窗口（发布 ≤ earlyWindowHours 小时）：用较低的「早期阈值」判断是否爆发，
 *     因为刚发不久就冲到这个量，往往是潜在爆款 → tier='early_breakout'。
 *   - 成熟期（超过临界点）：用常规阈值判断各项数据 → 'qualified' / 'watch' / 'below'。
 *   - 发布时间未知：无法奖励「上升速度」，退回常规阈值判断。
 *
 * 注意：这里只对「已经在 DB 里的数字」打分。数字是否可信由 metrics_source 决定
 * （视觉读出的是 desktop_agent → needs_review）。评分是建议性的热度信号，
 * 不写回 data_status，也不影响正式日报（不变量 #4）。
 */

/** 各档热度（用于排序：越靠前越热）。 */
export const TIER_RANK = {
  early_breakout: 4,
  qualified: 3,
  watch: 2,
  below: 1,
  unknown: 0,
};

/**
 * 默认阈值。数字是经验默认值，全部可在 config.wechat 覆盖。
 * - article（公众号）：主信号是阅读量 read，辅以点赞 like、收藏 favorite。
 * - channels（视频号）：无阅读量，主信号是赞 like、收藏 favorite、转发 share。
 */
export const WECHAT_SCORE_DEFAULTS = {
  window: 'last_7_days',
  maxVideosPerCreator: 3,
  earlyWindowHours: 24,
  article: {
    earlyRead: 5000, earlyLike: 100,
    normalRead: 10000, normalLike: 200,
    watchReadRatio: 0.5,
  },
  channels: {
    earlyLike: 1000, earlyFavorite: 200,
    normalLike: 3000, normalFavorite: 500,
    watchRatio: 0.5,
  },
};

/** 把用户配置浅合并到默认值之上（含两层 article / channels）。 */
export function wechatScoreConfig(cfg = {}) {
  const w = cfg && cfg.wechat ? cfg.wechat : cfg;
  const src = w && typeof w === 'object' ? w : {};
  return {
    ...WECHAT_SCORE_DEFAULTS,
    ...src,
    article: { ...WECHAT_SCORE_DEFAULTS.article, ...(src.article || {}) },
    channels: { ...WECHAT_SCORE_DEFAULTS.channels, ...(src.channels || {}) },
  };
}

/** 发布至今的小时数；时间未知或非法返回 null（绝不瞎猜）。 */
export function ageHoursOf(publishTime, now = new Date()) {
  if (!publishTime) return null;
  const t = new Date(publishTime).getTime();
  if (Number.isNaN(t)) return null;
  const hours = (now.getTime() - t) / 3_600_000;
  return hours >= 0 ? hours : 0;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const atLeast = (v, threshold) => v !== null && Number.isFinite(v) && v >= threshold;

/**
 * 对单条内容打分。
 * @param {object} content  contents 行（含 read_count/like_count/favorite_count/share_count/publish_time/platform）
 * @param {object} [cfg]    完整 config 或 config.wechat
 * @returns {{platform:string, tier:string, hot:boolean, ageHours:number|null, rank:number, reasons:string[], signals:object}}
 */
export function scoreWechatContent(content = {}, cfg) {
  const conf = wechatScoreConfig(cfg);
  const platform = content.platform;
  const ageHours = ageHoursOf(content.publish_time);
  const inEarlyWindow = ageHours !== null && ageHours <= conf.earlyWindowHours;

  const signals = {
    read: num(content.read_count),
    like: num(content.like_count),
    favorite: num(content.favorite_count),
    share: num(content.share_count),
    comment: num(content.comment_count),
  };

  const result = platform === 'wechat_article'
    ? scoreArticle(signals, conf.article, inEarlyWindow)
    : scoreChannels(signals, conf.channels, inEarlyWindow);

  return {
    platform,
    ageHours,
    inEarlyWindow,
    rank: TIER_RANK[result.tier] ?? 0,
    signals,
    ...result,
  };
}

function scoreArticle(s, t, inEarlyWindow) {
  const hasAnySignal = s.read !== null || s.like !== null;
  if (!hasAnySignal) {
    return { tier: 'unknown', hot: false, reasons: ['阅读/点赞均未知，待补录'] };
  }
  if (inEarlyWindow) {
    if (atLeast(s.read, t.earlyRead) || atLeast(s.like, t.earlyLike)) {
      const why = [];
      if (atLeast(s.read, t.earlyRead)) why.push(`早窗口阅读 ${s.read} ≥ ${t.earlyRead}`);
      if (atLeast(s.like, t.earlyLike)) why.push(`早窗口点赞 ${s.like} ≥ ${t.earlyLike}`);
      return { tier: 'early_breakout', hot: true, reasons: why };
    }
  }
  if (atLeast(s.read, t.normalRead) && atLeast(s.like, t.normalLike)) {
    return { tier: 'qualified', hot: true, reasons: [`阅读 ${s.read} ≥ ${t.normalRead}，点赞 ${s.like} ≥ ${t.normalLike}`] };
  }
  if (atLeast(s.read, Math.round(t.normalRead * t.watchReadRatio))) {
    return { tier: 'watch', hot: false, reasons: [`阅读接近达标（${s.read}），继续观察`] };
  }
  return { tier: 'below', hot: false, reasons: ['未达常规阈值'] };
}

function scoreChannels(s, t, inEarlyWindow) {
  const hasAnySignal = s.like !== null || s.favorite !== null || s.share !== null;
  if (!hasAnySignal) {
    return { tier: 'unknown', hot: false, reasons: ['赞/收藏/转发均未知，待补录'] };
  }
  if (inEarlyWindow) {
    if (atLeast(s.like, t.earlyLike) || atLeast(s.favorite, t.earlyFavorite)) {
      const why = [];
      if (atLeast(s.like, t.earlyLike)) why.push(`早窗口赞 ${s.like} ≥ ${t.earlyLike}`);
      if (atLeast(s.favorite, t.earlyFavorite)) why.push(`早窗口收藏 ${s.favorite} ≥ ${t.earlyFavorite}`);
      return { tier: 'early_breakout', hot: true, reasons: why };
    }
  }
  if (atLeast(s.like, t.normalLike) && atLeast(s.favorite, t.normalFavorite)) {
    return { tier: 'qualified', hot: true, reasons: [`赞 ${s.like} ≥ ${t.normalLike}，收藏 ${s.favorite} ≥ ${t.normalFavorite}`] };
  }
  if (atLeast(s.like, Math.round(t.normalLike * t.watchRatio))) {
    return { tier: 'watch', hot: false, reasons: [`赞接近达标（${s.like}），继续观察`] };
  }
  return { tier: 'below', hot: false, reasons: ['未达常规阈值'] };
}

/** 给一组热点行批量叠加评分，并按热度（rank）→ 采集时间降序排好。 */
export function scoreAndSortHotspots(rows = [], cfg) {
  return rows
    .map((row) => ({ ...row, score: scoreWechatContent(row, cfg) }))
    .sort((a, b) => {
      if (b.score.rank !== a.score.rank) return b.score.rank - a.score.rank;
      return String(b.captured_at || '').localeCompare(String(a.captured_at || ''));
    });
}

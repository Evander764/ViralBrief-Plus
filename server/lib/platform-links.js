/**
 * 平台链接工具（确定性，不经过 AI）。
 *
 * 为什么需要它：LLM 无法知道某个博主的精确主页 URL（抖音/小红书的主页地址里
 * 含不可猜测的用户 ID，如 douyin.com/user/MS4wLjABAAAA...）。让 AI 填主页链接，
 * 结果要么编造一个打不开的死链（用户反馈的「主页链接经常失效」），要么留空。
 *
 * 正确做法：用昵称在代码里拼出各平台的「搜索链接」——它一定能打开，
 * 落到该平台搜索结果页，用户一键就能找到并进入真实主页。
 * 同时校验 AI 给的链接是否像真实主页，是才保留，否则丢弃换成搜索链接。
 */

/** 各平台「按关键词搜索」的 URL 模板（公开搜索页，稳定可用）。 */
export function platformSearchUrl(platform, nickname) {
  const q = encodeURIComponent(String(nickname || '').trim());
  if (!q) return '';
  switch (platform) {
    case 'douyin':
      return `https://www.douyin.com/search/${q}?type=user`;
    case 'xiaohongshu':
      return `https://www.xiaohongshu.com/search_result?keyword=${q}&type=user`;
    case 'wechat_channels':
      // 视频号没有稳定的网页搜索入口，退而用通用搜索帮用户定位
      return `https://www.google.com/search?q=${q}+微信视频号`;
    default:
      return `https://www.google.com/search?q=${q}`;
  }
}

const HOST_OK = {
  douyin: ['douyin.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
  wechat_channels: ['weixin.qq.com', 'channels.weixin.qq.com'],
};

/**
 * 判断 AI 给的链接是否像「该平台的真实主页/内容链接」。
 * 只有 host 命中且看起来像个人主页（带 user/profile/finder 等路径或较长 ID）才认。
 * 拿不准一律返回 false，交给搜索链接兜底——宁可给可用搜索页，也不给死链。
 */
export function looksLikeRealProfile(platform, url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url.trim()); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const hosts = HOST_OK[platform] || [];
  const host = u.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  // 主页/内容链接必须有真实 ID；/user/profile 这种半截地址会直接 404。
  const path = u.pathname.replace(/\/+$/, '');
  if (!path || path === '') return false;
  // 含明显占位/示例字样的视为编造。
  if (/example|xxx|abcdef|your[-_]?id|placeholder|123456/i.test(url)) return false;
  if (platform === 'douyin') {
    return /^\/user\/(?!self$)[^/?#]+$/i.test(path) || /^\/video\/[^/?#]+$/i.test(path);
  }
  if (platform === 'xiaohongshu') {
    return /^\/user\/profile\/[^/?#]+$/i.test(path)
      || /^\/explore\/[^/?#]+$/i.test(path)
      || /^\/discovery\/item\/[^/?#]+$/i.test(path);
  }
  return /(finder|channels|u)\//i.test(url) || path.length >= 8;
}

/**
 * 给一条 AI 建议补上「可用链接」：
 *  - AI 链接像真实主页 → 保留为 homepage_url；
 *  - 否则 → homepage_url 留空，但给出 search_url（一定能打开）。
 * 返回新对象，不改原对象。
 */
export function withUsableLink(suggestion) {
  const platform = suggestion.platform;
  const real = looksLikeRealProfile(platform, suggestion.homepage_url);
  return {
    ...suggestion,
    homepage_url: real ? suggestion.homepage_url.trim() : '',
    search_url: platformSearchUrl(platform, suggestion.nickname),
    link_verified: real, // true=AI 给的真实主页；false=用搜索链接兜底
  };
}

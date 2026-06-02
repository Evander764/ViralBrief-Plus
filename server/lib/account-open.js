const OPEN_PLATFORM_ALIASES = new Map([
  ['xiaohongshu', 'xiaohongshu'],
  ['小红书', 'xiaohongshu'],
  ['xhs', 'xiaohongshu'],
  ['red', 'xiaohongshu'],
  ['douyin', 'douyin'],
  ['抖音', 'douyin'],
  ['dy', 'douyin'],
  ['wechat_channels', 'wechat_channels'],
  ['视频号', 'wechat_channels'],
  ['微信视频号', 'wechat_channels'],
  ['channels', 'wechat_channels'],
]);

export function normalizeOpenPlatform(platform) {
  return OPEN_PLATFORM_ALIASES.get(String(platform || '').trim().toLowerCase()) || '';
}

export function isPlatformHomepageUrl(platform, rawUrl) {
  const normalizedPlatform = normalizeOpenPlatform(platform);
  if (!normalizedPlatform || !rawUrl || typeof rawUrl !== 'string') return false;
  let u;
  try { u = new URL(rawUrl.trim()); } catch { return false; }
  if (!['https:', 'http:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  if (normalizedPlatform === 'xiaohongshu') {
    return (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com'))
      && /^\/user\/profile\/[^/?#]+$/i.test(path);
  }
  if (normalizedPlatform === 'douyin') {
    return (host === 'douyin.com' || host.endsWith('.douyin.com'))
      && /^\/user\/(?!self$)[^/?#]+$/i.test(path);
  }
  if (normalizedPlatform === 'wechat_channels') {
    const isWechatHost = host === 'channels.weixin.qq.com'
      || host.endsWith('.channels.weixin.qq.com')
      || host === 'weixin.qq.com'
      || host.endsWith('.weixin.qq.com');
    const text = `${u.pathname}${u.search}`;
    return isWechatHost
      && (/finder(username)?=|profile|creator|author|user|channels|finder/i.test(text) || path.length >= 8)
      && !/feed_id=|object_id=|objectId=|exportkey=|\/feed\b|\/video\b/i.test(text);
  }
  return false;
}

export function accountOpenUrlsForPlatform(accounts, platform) {
  const normalizedPlatform = normalizeOpenPlatform(platform);
  if (!normalizedPlatform) {
    return { platform: '', urls: [], skippedCount: 0 };
  }

  const urls = [];
  const seen = new Set();
  let skippedCount = 0;

  for (const account of accounts || []) {
    if (normalizeOpenPlatform(account?.platform) !== normalizedPlatform) continue;
    const url = String(account?.homepage_url || '').trim();
    if (!isPlatformHomepageUrl(normalizedPlatform, url) || seen.has(url)) {
      skippedCount++;
      continue;
    }
    seen.add(url);
    urls.push(url);
  }

  return { platform: normalizedPlatform, urls, skippedCount };
}

/**
 * 去重 —— 同一链接 / 同一(平台+作者+标题) 视为同一条内容。
 * 确定性逻辑，不经过 AI。
 */

import { createHash } from 'node:crypto';

// 这些查询参数通常是分享/追踪用的，不影响内容身份，归一化时去掉。
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'share_token', 'shareredId', 'share_id', 'shareId', 'app_platform',
  'apptime', 'share_from', 'from', 'timestamp', 'wxshare_count', 'web_redirect',
  'scene', 'clicktime', 'enterid', 'finder_share', 'spm', 'extra_params',
]);

/** 归一化 URL：小写主机、去 fragment、去追踪参数、去末尾斜杠。 */
export function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(String(rawUrl).trim());
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    for (const p of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(p)) u.searchParams.delete(p);
    }
    // 稳定排序剩余参数，保证同一链接归一化结果一致。
    u.searchParams.sort();
    let s = u.toString();
    s = s.replace(/\/$/, ''); // 去末尾斜杠
    return s;
  } catch {
    // 不是合法 URL，就用原始字符串做最小归一化。
    return String(rawUrl).trim().toLowerCase().replace(/\/$/, '') || null;
  }
}

const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));

/** 内容指纹：用于「平台+作者+标题」的二次去重。 */
export function contentFingerprint({ platform, author_name, title }) {
  const basis = [norm(platform), norm(author_name), norm(title)].join('');
  return createHash('sha1').update(basis).digest('hex');
}

/**
 * 在已有内容中查找重复项。
 * @param {object} incoming 新内容 { url, platform, author_name, title }
 * @param {(urlKey:string, fp:string)=>object|undefined} lookup 由调用方提供的查库函数
 * @returns {{ duplicate: boolean, existing?: object, reason?: 'url'|'fingerprint' }}
 */
export function findDuplicate(incoming, lookup) {
  const urlKey = normalizeUrl(incoming.url);
  const fp = contentFingerprint(incoming);
  const existing = lookup(urlKey, fp);
  if (!existing) return { duplicate: false };
  const reason = urlKey && existing.url_key === urlKey ? 'url' : 'fingerprint';
  return { duplicate: true, existing, reason };
}

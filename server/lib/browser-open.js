import { execFile } from 'node:child_process';

const ALLOWED_HOSTS = [
  'douyin.com',
  'xiaohongshu.com',
  'xhslink.com',
  'google.com',
];

function hostMatches(host, root) {
  return host === root || host.endsWith(`.${root}`);
}

export function isAllowedBrowserOpenUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let u;
  try { u = new URL(rawUrl.trim()); } catch { return false; }
  if (!['https:', 'http:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.some((root) => hostMatches(host, root))) return false;
  if (hostMatches(host, 'google.com')) return u.pathname === '/search';
  return true;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function normalizeBrowserOpenUrls(rawUrls) {
  const input = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
  const urls = [];
  const seen = new Set();
  for (const raw of input) {
    const url = String(raw || '').trim();
    if (!isAllowedBrowserOpenUrl(url)) {
      throw new Error('只允许打开抖音、小红书或已配置的平台搜索链接');
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (urls.length === 0) {
    throw new Error('只允许打开抖音、小红书或已配置的平台搜索链接');
  }
  return urls;
}

export async function openExternalBrowserUrls(rawUrls, { platform = process.platform, runner = run } = {}) {
  const urls = normalizeBrowserOpenUrls(rawUrls);

  if (platform === 'darwin') {
    try {
      await runner('open', ['-a', 'Google Chrome', ...urls]);
    } catch {
      await runner('open', urls);
    }
    return { openedCount: urls.length, urls };
  }
  if (platform === 'win32') {
    await Promise.all(urls.map((url) => runner('rundll32.exe', ['url.dll,FileProtocolHandler', url])));
    return { openedCount: urls.length, urls };
  }
  await Promise.all(urls.map((url) => runner('xdg-open', [url])));
  return { openedCount: urls.length, urls };
}

export async function openExternalBrowser(rawUrl, opts = {}) {
  return openExternalBrowserUrls(rawUrl, opts);
}

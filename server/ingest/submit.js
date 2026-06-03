import { fetchAndExtract } from './scrape.js';
import { getContent, markAccountSeen, upsertCapture } from '../store.js';

const MAX_BATCH_URLS = 50;

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function compactUrls(input) {
  const raw = Array.isArray(input) ? input : [input];
  return raw.map((url) => String(url || '').trim()).filter(Boolean);
}

function invalidUrlResult(url) {
  return { ok: false, url: String(url || '').trim(), note: '请提供合法的 http(s) 链接' };
}

function capturePayloadFromExtracted(r) {
  return {
    url: r.url,
    platform: r.platform,
    content_type: r.content_type,
    title: r.title,
    author_name: r.author_name,
    body_excerpt: r.body_excerpt,
    publish_time: r.publish_time,
    metrics_source: 'scraped',
    metrics_raw: r.metrics_raw,
  };
}

function resultFromCapture({ extracted, captureResult }) {
  const content = getContent(captureResult.id);
  if (content?.platform === 'wechat_article' && content.account_id) {
    markAccountSeen(content.account_id, {
      lastSeenUrl: content.url || extracted.url,
      lastSeenPublishTime: content.publish_time || extracted.publish_time,
    });
  }
  const status = content?.data_status || captureResult.status || null;
  return {
    ok: true,
    id: captureResult.id,
    duplicate: captureResult.duplicate,
    status,
    platform: extracted.platform,
    title: extracted.title,
    author_name: extracted.author_name,
    publish_time: content?.publish_time || extracted.publish_time || null,
    account_id: content?.account_id || null,
    accountMatched: !!content?.account_id,
    metrics: extracted.metrics_raw,
    found: extracted.found,
    note: extracted.note,
    url: extracted.url,
  };
}

export async function ingestOneUrl(url, { extractor = fetchAndExtract } = {}) {
  const normalizedUrl = String(url || '').trim();
  if (!isHttpUrl(normalizedUrl)) return invalidUrlResult(normalizedUrl);

  const extracted = await extractor(normalizedUrl);
  if (!extracted.ok) {
    return { ok: false, url: normalizedUrl, note: extracted.note || '抓取失败' };
  }

  const captureResult = upsertCapture(capturePayloadFromExtracted(extracted));
  return resultFromCapture({ extracted, captureResult });
}

export async function ingestPayload(body = {}, opts = {}) {
  if (Array.isArray(body.urls)) {
    const urls = compactUrls(body.urls);
    if (urls.length === 0) return { httpStatus: 400, body: { error: '请提供至少一个 http(s) 链接' } };
    if (urls.length > MAX_BATCH_URLS) return { httpStatus: 400, body: { error: `一次最多导入 ${MAX_BATCH_URLS} 个链接` } };

    const results = [];
    for (const url of urls) {
      results.push(await ingestOneUrl(url, opts));
    }
    const success = results.filter((r) => r.ok).length;
    return {
      httpStatus: 200,
      body: {
        ok: success > 0,
        total: results.length,
        success,
        duplicates: results.filter((r) => r.ok && r.duplicate).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      },
    };
  }

  const url = String(body.url || '').trim();
  if (!isHttpUrl(url)) return { httpStatus: 400, body: { error: '请提供合法的 http(s) 链接' } };
  const result = await ingestOneUrl(url, opts);
  if (!result.ok) return { httpStatus: 200, body: { ok: false, url: result.url, note: result.note } };
  return { httpStatus: 200, body: result };
}

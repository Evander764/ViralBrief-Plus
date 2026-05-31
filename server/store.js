/**
 * 仓储层 —— 所有对数据库的读写都集中在这里。
 * 把「关键数据绝不出错」的确定性逻辑（标准化 / 去重 / 状态判定）
 * 在写入时就强制执行。
 */
import { randomUUID } from 'node:crypto';
import { run, get, all } from './db.js';
import { normalizeMetric } from './normalize.js';
import { normalizeUrl, contentFingerprint } from './dedup.js';
import { computeDataStatus, ELIGIBLE_PLATFORMS, eligibleReason } from './filter.js';

const nowISO = () => new Date().toISOString();
const METRICS = ['like', 'share', 'comment', 'favorite'];

const cleanId = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const cleanText = (v) => String(v || '').trim().toLowerCase();

/** 尽量把各种发布时间表示解析为 ISO；解析不了返回 null（绝不瞎猜）。 */
export function parsePublishTime(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === 'number') {
    const ms = raw < 1e12 ? raw * 1000 : raw; // 容忍秒级时间戳
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ----------------------------------------------------------------------------
// contents
// ----------------------------------------------------------------------------

const CONTENT_COLS = [
  'id', 'platform', 'content_type', 'url', 'url_key', 'fingerprint', 'account_id',
  'author_name', 'title', 'body_excerpt', 'publish_time', 'captured_at',
  'like_count', 'share_count', 'comment_count', 'favorite_count',
  'like_raw', 'share_raw', 'comment_raw', 'favorite_raw',
  'metrics_source', 'metrics_confidence', 'metrics_evidence_json', 'eligible_reason',
  'data_status', 'user_confirmed', 'is_duplicate', 'duplicate_of',
  'archived', 'screenshot_path', 'created_at', 'updated_at',
];

function insertContentRow(row) {
  const placeholders = CONTENT_COLS.map(() => '?').join(', ');
  run(
    `INSERT INTO contents (${CONTENT_COLS.join(', ')}) VALUES (${placeholders})`,
    CONTENT_COLS.map((c) => row[c]),
  );
}

function updateContentRow(id, patch) {
  const keys = Object.keys(patch).filter((k) => CONTENT_COLS.includes(k));
  if (keys.length === 0) return;
  patch.updated_at = nowISO();
  if (!keys.includes('updated_at')) keys.push('updated_at');
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  run(`UPDATE contents SET ${setSql} WHERE id = ?`, [...keys.map((k) => patch[k]), id]);
}

export function getContent(id) {
  return get('SELECT * FROM contents WHERE id = ?', [id]);
}

/** 重新计算并落库某条内容的 data_status（确定性，零 token）。 */
export function recomputeStatus(id) {
  const c = getContent(id);
  if (!c) return null;
  const status = computeDataStatus(c);
  const reason = eligibleReason(c);
  if (status !== c.data_status || reason !== c.eligible_reason) {
    updateContentRow(id, { data_status: status, eligible_reason: reason });
  }
  return status;
}

/** 把窗口内（或全部）内容的 data_status 重新算一遍，确保新鲜。 */
export function recomputeAll(windowStartISO = null) {
  const rows = windowStartISO
    ? all('SELECT id FROM contents WHERE publish_time IS NULL OR publish_time >= ?', [windowStartISO])
    : all('SELECT id FROM contents');
  for (const r of rows) recomputeStatus(r.id);
  return rows.length;
}

function lookupDuplicate(urlKey, fp) {
  if (urlKey) {
    const byUrl = get('SELECT * FROM contents WHERE url_key = ? AND is_duplicate = 0 LIMIT 1', [urlKey]);
    if (byUrl) return byUrl;
  }
  if (fp) {
    const byFp = get('SELECT * FROM contents WHERE fingerprint = ? AND is_duplicate = 0 LIMIT 1', [fp]);
    if (byFp) return byFp;
  }
  return undefined;
}

function findAccountForCapture(payload = {}) {
  const explicit = cleanId(payload.account_id);
  if (explicit) {
    const byId = get('SELECT id FROM accounts WHERE id = ?', [explicit]);
    if (byId) return byId.id;
    return explicit;
  }

  const platform = cleanText(payload.platform);
  const author = cleanText(payload.author_name);
  if (platform && author) {
    const byName = get(
      'SELECT id FROM accounts WHERE lower(trim(platform)) = ? AND lower(trim(nickname)) = ? LIMIT 1',
      [platform, author],
    );
    if (byName) return byName.id;
  }

  const homepage = normalizeUrl(payload.account_homepage_url || payload.homepage_url);
  if (platform && homepage) {
    const rows = all('SELECT id, homepage_url FROM accounts WHERE lower(trim(platform)) = ?', [platform]);
    const byHome = rows.find((a) => normalizeUrl(a.homepage_url) === homepage);
    if (byHome) return byHome.id;
  }

  return null;
}

/**
 * 采集入口：插件 POST 来的内容在这里落库。
 * 自动去重；重复时只「补缺」不覆盖已确认的可信值。
 */
export function upsertCapture(payload) {
  const metricsRaw = payload.metrics_raw || {};
  const norm = {};
  for (const m of METRICS) norm[m] = normalizeMetric(metricsRaw[m]);

  const urlKey = normalizeUrl(payload.url);
  const fp = contentFingerprint({
    platform: payload.platform,
    author_name: payload.author_name,
    title: payload.title,
  });

  const existing = lookupDuplicate(urlKey, fp);
  const source = payload.metrics_source || 'page_text';

  if (existing) {
    // 合并：只填补现有为空的指标，不覆盖用户已确认的可信数据。
    const patch = {};
    const accountId = findAccountForCapture(payload);
    if (!existing.account_id && accountId) patch.account_id = accountId;
    for (const m of METRICS) {
      const col = `${m}_count`;
      if ((existing[col] === null || existing[col] === undefined) && norm[m].value !== null) {
        patch[col] = norm[m].value;
        patch[`${m}_raw`] = norm[m].raw;
      }
    }
    if (!existing.screenshot_path && payload.screenshot_path) patch.screenshot_path = payload.screenshot_path;
    if (!existing.body_excerpt && payload.body_excerpt) patch.body_excerpt = payload.body_excerpt;
    if (!existing.metrics_confidence && payload.metrics_confidence) patch.metrics_confidence = payload.metrics_confidence;
    if (!existing.metrics_evidence_json && payload.metrics_evidence) patch.metrics_evidence_json = JSON.stringify(payload.metrics_evidence);
    if (!existing.publish_time && payload.publish_time) {
      patch.publish_time = parsePublishTime(payload.publish_time);
    }
    if (Object.keys(patch).length > 0) {
      updateContentRow(existing.id, patch);
      recomputeStatus(existing.id);
    }
    return { id: existing.id, duplicate: true, reason: existing.url_key === urlKey ? 'url' : 'fingerprint' };
  }

  const id = randomUUID();
  const ts = nowISO();
  const row = {
    id,
    platform: payload.platform || 'other',
    content_type: payload.content_type || 'article',
    url: payload.url || null,
    url_key: urlKey,
    fingerprint: fp,
    account_id: payload.account_id || null,
    author_name: payload.author_name || null,
    title: payload.title || null,
    body_excerpt: payload.body_excerpt || null,
    publish_time: parsePublishTime(payload.publish_time),
    captured_at: ts,
    like_count: norm.like.value,
    share_count: norm.share.value,
    comment_count: norm.comment.value,
    favorite_count: norm.favorite.value,
    like_raw: norm.like.raw,
    share_raw: norm.share.raw,
    comment_raw: norm.comment.raw,
    favorite_raw: norm.favorite.raw,
    metrics_source: source,
    metrics_confidence: payload.metrics_confidence || null,
    metrics_evidence_json: payload.metrics_evidence ? JSON.stringify(payload.metrics_evidence) : null,
    eligible_reason: null,
    data_status: null,
    user_confirmed: source === 'manual' ? 1 : 0,
    is_duplicate: 0,
    duplicate_of: null,
    archived: 0,
    screenshot_path: payload.screenshot_path || null,
    created_at: ts,
    updated_at: ts,
  };
  row.account_id = findAccountForCapture(payload);
  row.data_status = computeDataStatus(row);
  row.eligible_reason = eligibleReason(row);
  insertContentRow(row);
  return { id, duplicate: false, status: row.data_status };
}

/**
 * 人工确认 / 修正指标。这是弱证据转为可信数据的关键人工动作。
 * 修正后强制 metrics_source = manual、user_confirmed = 1（文档 11.3）。
 */
export function confirmContent(id, patch = {}) {
  const c = getContent(id);
  if (!c) return null;
  const update = {};
  for (const m of METRICS) {
    const col = `${m}_count`;
    if (col in patch) {
      const n = normalizeMetric(patch[col]);
      update[col] = n.value;
      update[`${m}_raw`] = n.raw;
    }
  }
  for (const f of ['title', 'author_name', 'platform', 'content_type', 'body_excerpt']) {
    if (f in patch) update[f] = patch[f];
  }
  if ('account_id' in patch) update.account_id = cleanId(patch.account_id);
  if ('publish_time' in patch) update.publish_time = parsePublishTime(patch.publish_time);
  if ('archived' in patch) update.archived = patch.archived ? 1 : 0;

  update.metrics_source = 'manual';
  update.metrics_confidence = 'manual';
  update.user_confirmed = 1;
  updateContentRow(id, update);
  recomputeStatus(id);
  return getContent(id);
}

export function archiveContent(id) {
  updateContentRow(id, { archived: 1 });
  recomputeStatus(id);
  return getContent(id);
}

export function deleteContent(id) {
  run('DELETE FROM ai_analysis WHERE content_id = ?', [id]);
  return run('DELETE FROM contents WHERE id = ?', [id]);
}

export function listContents({ status, platform, window: windowStart, q, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('data_status = ?'); params.push(status); }
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (windowStart) { where.push('publish_time IS NOT NULL AND publish_time >= ?'); params.push(windowStart); }
  if (q) {
    where.push('(title LIKE ? OR author_name LIKE ? OR body_excerpt LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const sql = `SELECT * FROM contents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY captured_at DESC LIMIT ?`;
  params.push(limit);
  return all(sql, params);
}

/** 取达标内容（账号池小红书/抖音 + confirmed + video/article + 任一互动指标 > 1000 + 在窗口内）。 */
export function getEligible(windowStartISO) {
  const platformPlaceholders = ELIGIBLE_PLATFORMS.map(() => '?').join(',');
  return all(
    `SELECT c.*, a.nickname AS account_nickname, a.category AS account_category, a.priority AS account_priority
     FROM contents c
     JOIN accounts a ON a.id = c.account_id
     WHERE c.data_status = 'confirmed'
       AND c.platform IN (${platformPlaceholders})
       AND c.content_type IN ('video','article')
       AND (
         c.like_count > 1000 OR c.share_count > 1000 OR c.favorite_count > 1000
         OR (c.like_count >= 1000 AND c.like_raw LIKE '%+%')
         OR (c.share_count >= 1000 AND c.share_raw LIKE '%+%')
         OR (c.favorite_count >= 1000 AND c.favorite_raw LIKE '%+%')
       )
       AND c.publish_time IS NOT NULL AND c.publish_time >= ?
     ORDER BY MAX(COALESCE(c.like_count, 0), COALESCE(c.share_count, 0), COALESCE(c.favorite_count, 0)) DESC`,
    [...ELIGIBLE_PLATFORMS, windowStartISO],
  );
}

export function countsByStatus() {
  const rows = all('SELECT data_status, COUNT(*) AS n FROM contents GROUP BY data_status');
  const out = {};
  for (const r of rows) out[r.data_status] = r.n;
  return out;
}

// ----------------------------------------------------------------------------
// accounts（账号池）
// ----------------------------------------------------------------------------

export function listAccounts() {
  return all('SELECT * FROM accounts ORDER BY priority ASC, created_at DESC');
}

function normalizePlatformInput(v) {
  const s = String(v || '').trim().toLowerCase();
  if (['douyin', '抖音', 'dy'].includes(s)) return 'douyin';
  if (['xiaohongshu', '小红书', 'xhs', 'red'].includes(s)) return 'xiaohongshu';
  if (['wechat_channels', '视频号', '微信视频号', 'channels'].includes(s)) return 'wechat_channels';
  if (['wechat_article', '公众号', '公众号文章'].includes(s)) return 'wechat_article';
  return s || 'other';
}

function normalizePriority(v) {
  const s = String(v || 'B').trim().toUpperCase();
  return ['S', 'A', 'B'].includes(s) ? s : 'B';
}

export function upsertAccount(a) {
  const platform = normalizePlatformInput(a.platform);
  const nickname = String(a.nickname || '').trim();
  const id = cleanId(a.id);
  const platformUserId = cleanId(a.platform_user_id);
  let existing = id ? get('SELECT * FROM accounts WHERE id = ?', [id]) : null;
  if (!existing && platformUserId) {
    existing = get(
      'SELECT * FROM accounts WHERE lower(trim(platform)) = ? AND platform_user_id = ? LIMIT 1',
      [platform, platformUserId],
    );
  }
  if (!existing && nickname) {
    existing = get('SELECT * FROM accounts WHERE lower(trim(platform)) = ? AND lower(trim(nickname)) = ? LIMIT 1', [platform, nickname.toLowerCase()]);
  }
  const accountId = existing?.id || id || randomUUID();
  const ts = nowISO();
  const homepage = String(a.homepage_url ?? existing?.homepage_url ?? '').trim();
  const category = String(a.category ?? existing?.category ?? '').trim();
  const priority = normalizePriority(a.priority ?? existing?.priority);
  const enabled = a.monitor_enabled === undefined ? (existing?.monitor_enabled ?? 0) : (a.monitor_enabled ? 1 : 0);
  const discoverySource = String(a.discovery_source || a.discovered_source || existing?.discovery_source || '').trim() || null;
  const discoveredAt = existing?.discovered_at || a.discovered_at || (discoverySource ? ts : null);
  const lastDiscoveredAt = a.last_discovered_at || (discoverySource ? ts : existing?.last_discovered_at || null);
  const lastPatrolledAt = a.last_patrolled_at || existing?.last_patrolled_at || null;
  const lastSeenUrl = a.last_seen_url || existing?.last_seen_url || null;
  const lastSeenPublishTime = a.last_seen_publish_time || existing?.last_seen_publish_time || null;
  if (existing) {
    run(
      `UPDATE accounts
       SET platform=?, nickname=?, homepage_url=?, platform_user_id=?, category=?, priority=?, monitor_enabled=?,
           discovery_source=?, discovered_at=?, last_discovered_at=?, last_patrolled_at=?,
           last_seen_url=?, last_seen_publish_time=?
       WHERE id=?`,
      [platform, nickname || existing.nickname, homepage, platformUserId || existing.platform_user_id,
        category, priority, enabled, discoverySource, discoveredAt, lastDiscoveredAt,
        lastPatrolledAt, lastSeenUrl, lastSeenPublishTime, accountId],
    );
  } else {
    run(
      `INSERT INTO accounts (
         id, platform, nickname, homepage_url, platform_user_id, category, priority, monitor_enabled,
         discovery_source, discovered_at, last_discovered_at, last_patrolled_at,
         last_seen_url, last_seen_publish_time, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, platform, nickname, homepage, platformUserId, category, priority, enabled,
        discoverySource, discoveredAt, lastDiscoveredAt, lastPatrolledAt,
        lastSeenUrl, lastSeenPublishTime, ts],
    );
  }
  return get('SELECT * FROM accounts WHERE id = ?', [accountId]);
}

export function markAccountPatrolled(id, { lastSeenUrl = null, lastSeenPublishTime = null } = {}) {
  const patch = { last_patrolled_at: nowISO() };
  if (lastSeenUrl) patch.last_seen_url = lastSeenUrl;
  if (lastSeenPublishTime) patch.last_seen_publish_time = lastSeenPublishTime;
  const keys = Object.keys(patch);
  run(`UPDATE accounts SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map((k) => patch[k]), id]);
  return get('SELECT * FROM accounts WHERE id = ?', [id]);
}

export function contentExistsByUrl(url) {
  const urlKey = normalizeUrl(url);
  if (!urlKey) return false;
  return !!get('SELECT id FROM contents WHERE url_key = ? AND is_duplicate = 0 LIMIT 1', [urlKey]);
}

export function deleteAccount(id) {
  return run('DELETE FROM accounts WHERE id = ?', [id]);
}

/** 极简 CSV 解析（支持双引号包裹的字段）。表头：platform,nickname,homepage_url,category,priority,monitor_enabled */
export function importAccountsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { imported: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let imported = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const rec = {};
    header.forEach((h, idx) => { rec[h] = (cells[idx] ?? '').trim(); });
    if (!rec.nickname && !rec.homepage_url) continue;
    upsertAccount({
      platform: rec.platform || 'other',
      nickname: rec.nickname,
      homepage_url: rec.homepage_url,
      category: rec.category,
      priority: rec.priority || 'B',
      monitor_enabled: /^(1|true|yes|是)$/i.test(rec.monitor_enabled || ''),
    });
    imported++;
  }
  return { imported };
}

/** 手动多行导入：一行一个账号，格式：平台,昵称,主页链接,分类,优先级,是否巡检。 */
export function importAccountsLines(text) {
  const rows = parseCsv(String(text || '').replace(/\t/g, ','));
  let imported = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => c.trim());
    if (cells.length === 1 && cells[0] === '') { skipped++; continue; }
    if (i === 0 && ['platform', '平台'].includes(cells[0]?.toLowerCase())) continue;
    const [platform, nickname, homepage_url = '', category = '商业', priority = 'B', monitorRaw = 'true'] = cells;
    if (!platform || !nickname) {
      skipped++;
      errors.push(`第 ${i + 1} 行缺少平台或昵称`);
      continue;
    }
    upsertAccount({
      platform,
      nickname,
      homepage_url,
      category,
      priority,
      monitor_enabled: !/^(0|false|no|否)$/i.test(monitorRaw || ''),
    });
    imported++;
  }
  return { imported, skipped, errors };
}

function parseCsv(text) {
  const out = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); out.push(row); }
  return out;
}

// ----------------------------------------------------------------------------
// ai_analysis（单条分析缓存）
// ----------------------------------------------------------------------------

export function getAnalysis(contentId) {
  return get('SELECT * FROM ai_analysis WHERE content_id = ?', [contentId]);
}

export function getAnalysesForContents(ids) {
  const map = {};
  for (const id of ids) {
    const a = getAnalysis(id);
    if (a) map[id] = a;
  }
  return map;
}

export function upsertAnalysis(contentId, data, model) {
  const existing = getAnalysis(contentId);
  const id = existing ? existing.id : randomUUID();
  const fields = {
    summary: data.summary || '',
    extracted_topic: data.extracted_topic || '',
    topic_cluster: data.topic_cluster || '',
    hook_type: data.hook_type || '',
    pain_point: data.pain_point || '',
    why_viral: data.why_viral || '',
    target_audience: data.target_audience || '',
    rewrite_titles_json: JSON.stringify(data.rewrite_titles || []),
    business_value: Number.isFinite(data.business_value_score) ? data.business_value_score : 0,
    monetization_json: JSON.stringify(data.monetization_paths || []),
    model: model || '',
    created_at: nowISO(),
  };
  if (existing) {
    const keys = Object.keys(fields);
    run(`UPDATE ai_analysis SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`,
      [...keys.map((k) => fields[k]), id]);
  } else {
    run(
      `INSERT INTO ai_analysis (id, content_id, summary, extracted_topic, topic_cluster, hook_type, pain_point, why_viral, target_audience, rewrite_titles_json, business_value, monetization_json, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, contentId, fields.summary, fields.extracted_topic, fields.topic_cluster, fields.hook_type,
        fields.pain_point, fields.why_viral, fields.target_audience, fields.rewrite_titles_json,
        fields.business_value, fields.monetization_json, fields.model, fields.created_at],
    );
  }
  return getAnalysis(contentId);
}

// ----------------------------------------------------------------------------
// agent_observations（视觉观察缓存）
// ----------------------------------------------------------------------------

export function getObservation(contentId) {
  return get('SELECT * FROM agent_observations WHERE content_id = ?', [contentId]);
}

export function upsertObservation(contentId, data, model) {
  const existing = getObservation(contentId);
  const id = existing ? existing.id : randomUUID();
  const fields = {
    observed_activity: data.observed_activity || '',
    topic_category: data.topic_category || '',
    scene: data.scene || '',
    people_objects: data.people_objects || '',
    text_on_screen: data.text_on_screen || '',
    call_to_action: data.call_to_action || null,
    confidence: Number.isFinite(data.confidence) ? data.confidence : 0,
    evidence_notes: data.evidence_notes || '',
    model: model || '',
    created_at: nowISO(),
  };
  if (existing) {
    const keys = Object.keys(fields);
    run(`UPDATE agent_observations SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`,
      [...keys.map((k) => fields[k]), id]);
  } else {
    run(
      `INSERT INTO agent_observations (id, content_id, observed_activity, topic_category, scene, people_objects, text_on_screen, call_to_action, confidence, evidence_notes, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, contentId, fields.observed_activity, fields.topic_category, fields.scene,
        fields.people_objects, fields.text_on_screen, fields.call_to_action,
        fields.confidence, fields.evidence_notes, fields.model, fields.created_at],
    );
  }
  return getObservation(contentId);
}

// ----------------------------------------------------------------------------
// daily_reports
// ----------------------------------------------------------------------------

export function insertReport(r) {
  const id = r.id || randomUUID();
  run(
    `INSERT INTO daily_reports (id, report_date, window_type, eligible_count, report_json, report_markdown, export_md_path, export_html_path, export_csv_path, export_zip_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, r.report_date, r.window_type, r.eligible_count, r.report_json, r.report_markdown,
      r.export_md_path, r.export_html_path, r.export_csv_path, r.export_zip_path, nowISO()],
  );
  return getReport(id);
}

export function listReports(limit = 60) {
  return all('SELECT id, report_date, window_type, eligible_count, export_md_path, export_html_path, export_csv_path, export_zip_path, created_at FROM daily_reports ORDER BY created_at DESC LIMIT ?', [limit]);
}

export function getReport(id) {
  return get('SELECT * FROM daily_reports WHERE id = ?', [id]);
}

export function deleteReport(id) {
  const r = getReport(id);
  if (!r) return null;
  run('DELETE FROM daily_reports WHERE id = ?', [id]);
  return r;
}

// ----------------------------------------------------------------------------
// usage（token 用量）
// ----------------------------------------------------------------------------

export function addUsage({ task, model, input = 0, output = 0, cached = 0 }) {
  const day = new Date().toISOString().slice(0, 10);
  run(
    'INSERT INTO usage_log (day, task, model, input_tokens, output_tokens, cached_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [day, task, model, input, output, cached, nowISO()],
  );
}

export function getUsageForDay(day = new Date().toISOString().slice(0, 10)) {
  const r = get(
    'SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cached_tokens),0) AS cached, COUNT(*) AS calls FROM usage_log WHERE day = ?',
    [day],
  );
  return { day, input: r.input, output: r.output, cached: r.cached, total: r.input + r.output, calls: r.calls };
}

// ----------------------------------------------------------------------------
// meta（键值）
// ----------------------------------------------------------------------------

export function metaGet(k) {
  const r = get('SELECT v FROM meta WHERE k = ?', [k]);
  return r ? r.v : null;
}
export function metaSet(k, v) {
  run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, String(v)]);
}

/**
 * SQLite 本地数据库（Node 内置 node:sqlite，零原生依赖）。
 * 字段设计对应文档第 7 章，并补充了去重/确认/审计所需的少量列。
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from './lib/paths.js';

ensureDirs();

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT,
  nickname TEXT,
  homepage_url TEXT,
  platform_user_id TEXT,
  category TEXT,
  priority TEXT,
  monitor_enabled INTEGER DEFAULT 0,
  discovery_source TEXT,
  discovered_at TEXT,
  last_discovered_at TEXT,
  last_patrolled_at TEXT,
  last_seen_url TEXT,
  last_seen_publish_time TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  platform TEXT,
  content_type TEXT,
  url TEXT,
  url_key TEXT,
  fingerprint TEXT,
  account_id TEXT,
  author_name TEXT,
  title TEXT,
  body_excerpt TEXT,
  publish_time TEXT,
  captured_at TEXT,
  like_count INTEGER,
  share_count INTEGER,
  comment_count INTEGER,
  favorite_count INTEGER,
  like_raw TEXT,
  share_raw TEXT,
  comment_raw TEXT,
  favorite_raw TEXT,
  metrics_source TEXT,
  metrics_confidence TEXT,
  metrics_evidence_json TEXT,
  eligible_reason TEXT,
  data_status TEXT,
  user_confirmed INTEGER DEFAULT 0,
  is_duplicate INTEGER DEFAULT 0,
  duplicate_of TEXT,
  archived INTEGER DEFAULT 0,
  screenshot_path TEXT,
  cover_url TEXT,
  duration_text TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contents_urlkey ON contents(url_key);
CREATE INDEX IF NOT EXISTS idx_contents_fp ON contents(fingerprint);
CREATE INDEX IF NOT EXISTS idx_contents_status ON contents(data_status);
CREATE INDEX IF NOT EXISTS idx_contents_publish ON contents(publish_time);

CREATE TABLE IF NOT EXISTS ai_analysis (
  id TEXT PRIMARY KEY,
  content_id TEXT UNIQUE,
  summary TEXT,
  extracted_topic TEXT,
  topic_cluster TEXT,
  hook_type TEXT,
  pain_point TEXT,
  why_viral TEXT,
  target_audience TEXT,
  rewrite_titles_json TEXT,
  business_value INTEGER,
  monetization_json TEXT,
  model TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_reports (
  id TEXT PRIMARY KEY,
  report_type TEXT DEFAULT 'web',
  report_date TEXT,
  window_type TEXT,
  eligible_count INTEGER,
  report_json TEXT,
  report_markdown TEXT,
  export_md_path TEXT,
  export_html_path TEXT,
  export_csv_path TEXT,
  export_zip_path TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT,
  task TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_log(day);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS agent_observations (
  id TEXT PRIMARY KEY,
  content_id TEXT UNIQUE,
  observed_activity TEXT,
  topic_category TEXT,
  scene TEXT,
  people_objects TEXT,
  text_on_screen TEXT,
  call_to_action TEXT,
  confidence REAL,
  evidence_notes TEXT,
  model TEXT,
  created_at TEXT
);
`;

db.exec(SCHEMA);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('daily_reports', 'export_zip_path', 'export_zip_path TEXT');
ensureColumn('daily_reports', 'report_type', "report_type TEXT DEFAULT 'web'");
ensureColumn('accounts', 'platform_user_id', 'platform_user_id TEXT');
ensureColumn('accounts', 'discovery_source', 'discovery_source TEXT');
ensureColumn('accounts', 'discovered_at', 'discovered_at TEXT');
ensureColumn('accounts', 'last_discovered_at', 'last_discovered_at TEXT');
ensureColumn('accounts', 'last_patrolled_at', 'last_patrolled_at TEXT');
ensureColumn('accounts', 'last_seen_url', 'last_seen_url TEXT');
ensureColumn('accounts', 'last_seen_publish_time', 'last_seen_publish_time TEXT');
ensureColumn('contents', 'metrics_confidence', 'metrics_confidence TEXT');
ensureColumn('contents', 'metrics_evidence_json', 'metrics_evidence_json TEXT');
ensureColumn('contents', 'eligible_reason', 'eligible_reason TEXT');
ensureColumn('contents', 'cover_url', 'cover_url TEXT');
ensureColumn('contents', 'duration_text', 'duration_text TEXT');

/** node:sqlite 只接受 null/number/bigint/string/Uint8Array。统一清洗参数。 */
export function sanitize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function run(sql, params = []) {
  return db.prepare(sql).run(...params.map(sanitize));
}
export function get(sql, params = []) {
  return db.prepare(sql).get(...params.map(sanitize));
}
export function all(sql, params = []) {
  return db.prepare(sql).all(...params.map(sanitize));
}

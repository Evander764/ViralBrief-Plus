/**
 * 配置中心。负责 config.json 的读写，以及 API Key 的加密存取与脱敏。
 * 桌面端保存 Key，浏览器插件绝不保存（文档 6.3）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CONFIG_PATH } from './lib/paths.js';
import { encryptSecret, decryptSecret } from './lib/secret.js';
import { addRedaction, clearRedaction } from './lib/log.js';

const DEFAULTS = {
  provider: 'openai',          // 'openai' | 'openai-compatible' | 'anthropic'
  baseUrl: '',                 // 留空则用 provider 默认地址
  model: 'gpt-4o-mini',        // 默认便宜模型，用户可改
  reportModel: '',             // 日报可单独配更强模型；留空则与 model 相同
  temperature: 0.3,
  timeoutMs: 60000,
  retries: 2,
  budgetDailyTokens: 0,        // 0 = 不限制，仅记录用量
  schedule: { enabled: false, time: '09:00', window: 'last_1_day', catchUp: true },
  pairingToken: '',
  apiKeyEnc: null,
  apiKeyEnc2: null,
  apiKeyUpdatedAt: null,
  apiKey2UpdatedAt: null,
};

/**
 * 根据 Key 前缀和 baseUrl 自动推断 provider。
 * - anthropic：Key 以 sk-ant- 开头，或 baseUrl 含 'anthropic'
 * - openai：官方 OpenAI（baseUrl 留空或含 'openai.com'）
 * - openai-compatible：设了自定义 baseUrl 的第三方兼容接口（DeepSeek、硅基流动、通义等）
 *   关键区别：openai 会发 response_format:json_object，openai-compatible 不发（靠提示词兜底）。
 */
function inferProvider(key, baseUrl) {
  const base = (baseUrl || '').toLowerCase();
  if ((key && key.startsWith('sk-ant-')) || base.includes('anthropic')) return 'anthropic';
  if (base && !base.includes('openai.com')) return 'openai-compatible';
  return 'openai';
}

let cache = null;

function readRaw() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeRaw(obj) {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function refreshRedaction() {
  clearRedaction();
  const k = getApiKey();
  if (k) addRedaction(k);
  const k2 = getApiKey2();
  if (k2) addRedaction(k2);
}

export function loadConfig() {
  if (cache) return cache;
  const raw = readRaw();
  const cfg = {
    ...DEFAULTS,
    ...raw,
    schedule: { ...DEFAULTS.schedule, ...(raw.schedule || {}) },
  };
  let changed = false;
  if (!cfg.pairingToken) { cfg.pairingToken = randomBytes(24).toString('hex'); changed = true; }
  
  // 动态推断 provider：anthropic / openai（官方）/ openai-compatible（第三方）
  const key = decryptSecret(cfg.apiKeyEnc);
  const newProvider = inferProvider(key, cfg.baseUrl);
  if (cfg.provider !== newProvider) {
    cfg.provider = newProvider;
    changed = true;
  }

  cache = cfg;
  if (changed) writeRaw(cfg);
  refreshRedaction();
  return cfg;
}

export function saveConfig(patch = {}) {
  const cfg = loadConfig();
  const {
    apiKeyEnc, apiKeyEnc2, apiKey, apiKeyUpdatedAt, apiKey2UpdatedAt, pairingToken, provider, ...safe
  } = patch; // 过滤掉 provider / Key 相关字段，不允许手动指定
  Object.assign(cfg, safe);
  if (patch.schedule) cfg.schedule = { ...cfg.schedule, ...patch.schedule };
  
  // 重新推断并保存
  const key = getApiKey();
  cfg.provider = inferProvider(key, cfg.baseUrl);

  writeRaw(cfg);
  return getPublicConfig();
}

export function getApiKey() {
  const cfg = cache || readMerged();
  return decryptSecret(cfg.apiKeyEnc);
}
// 仅供 getApiKey 在 cache 未建立时使用，避免与 loadConfig 的 refreshRedaction 互相递归
function readMerged() {
  const raw = readRaw();
  return { ...DEFAULTS, ...raw, schedule: { ...DEFAULTS.schedule, ...(raw.schedule || {}) } };
}

export function setApiKey(plain) {
  const cfg = loadConfig();
  cfg.apiKeyEnc = encryptSecret(plain);
  cfg.apiKeyUpdatedAt = plain ? new Date().toISOString() : null;
  // 换 Key 后必须立刻重新推断供应商：否则同一进程内贴了 Anthropic Key
  // 仍按 openai 走 /chat/completions，导致「测试调用」误判失败（需重启才好）。
  cfg.provider = inferProvider(plain, cfg.baseUrl);
  writeRaw(cfg);
  refreshRedaction();
}
export function clearApiKey() { setApiKey(null); }
export function hasApiKey() { return !!getApiKey(); }

export function getApiKey2() {
  const cfg = cache || readMerged();
  return decryptSecret(cfg.apiKeyEnc2);
}
export function setApiKey2(plain) {
  const cfg = loadConfig();
  cfg.apiKeyEnc2 = encryptSecret(plain);
  cfg.apiKey2UpdatedAt = plain ? new Date().toISOString() : null;
  writeRaw(cfg);
  refreshRedaction();
}
export function clearApiKey2() { setApiKey2(null); }
export function hasApiKey2() { return !!getApiKey2(); }

export function regeneratePairingToken() {
  const cfg = loadConfig();
  cfg.pairingToken = randomBytes(24).toString('hex');
  writeRaw(cfg);
  return cfg.pairingToken;
}

/** 对外暴露的配置：绝不含 apiKeyEnc / 明文 Key，只给末 4 位用于展示。 */
export function getPublicConfig() {
  const cfg = loadConfig();
  const key = getApiKey();
  const key2 = getApiKey2();
  const { apiKeyEnc, apiKeyEnc2, ...rest } = cfg;
  return {
    ...rest,
    hasApiKey: !!key, apiKeyLast4: key ? key.slice(-4) : null,
    hasApiKey2: !!key2, apiKey2Last4: key2 ? key2.slice(-4) : null,
  };
}

/** 解析有效的 base URL（按 provider 给默认值）。 */
export function effectiveBaseUrl() {
  const cfg = loadConfig();
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, '');
  if (cfg.provider === 'anthropic') return 'https://api.anthropic.com';
  return 'https://api.openai.com/v1';
}

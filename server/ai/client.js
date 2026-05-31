/**
 * AI 调用客户端 —— 供应商无关（OpenAI / OpenAI 兼容 / Anthropic），
 * 用内置 fetch，无需任何 SDK 依赖。
 *
 * Token 策略落地在这里：
 *  - 省：系统提示词稳定且靠前，Anthropic 显式打 prompt cache，OpenAI 自动命中前缀缓存。
 *  - 准（宁可多花）：返回的 JSON 强制校验，失败就带着「上次哪里错了」重试，
 *    直到拿到合法结构为止——绝不把脏数据吞下去。
 */
import { loadConfig, getApiKey, getApiKey2 } from '../config.js';
import { addUsage } from '../store.js';
import { log } from '../lib/log.js';

export class AIError extends Error {}

/** 从模型文本里稳健地抽出 JSON 对象。 */
export function extractJson(text) {
  if (!text || !text.trim()) throw new AIError('模型返回为空');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* 继续兜底 */ }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* 落到报错 */ }
  }
  throw new AIError('模型返回不是有效 JSON');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const VALID_PROVIDERS = new Set(['openai', 'openai-compatible', 'anthropic']);

function trimTrailingSlashes(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

function usesMoonshotFixedParams(provider, baseUrl, model) {
  const base = String(baseUrl || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  return provider === 'openai-compatible'
    && /moonshot|kimi/.test(base)
    && /^kimi-k2\.(5|6)\b/.test(m);
}

/**
 * 把用户填写的 Base URL 解析成真正请求的 endpoint。
 * 用户可能填根地址、/v1，也可能直接填完整接口路径；这里统一兜住。
 */
export function endpointForProvider(provider, baseUrl = '') {
  const p = VALID_PROVIDERS.has(provider) ? provider : 'openai-compatible';
  if (p === 'anthropic') {
    const base = trimTrailingSlashes(baseUrl) || 'https://api.anthropic.com';
    if (/\/v1\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  const base = trimTrailingSlashes(baseUrl) || 'https://api.openai.com/v1';
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/** 真正打一次模型，返回 { text, usage }。usage 统一为 {input, output, cached}。 */
function baseUrlForProvider(provider, cfg, providerOverride) {
  // 备用 Key 可能属于另一家供应商。跨供应商 fallback 时不能沿用主 Key 的
  // baseUrl，否则会出现「主 Key 401 后，备用 Anthropic Key 被发到 DeepSeek」
  // 这类偶发失败。
  if (!providerOverride || providerOverride === cfg.provider) {
    if (cfg.baseUrl) return trimTrailingSlashes(cfg.baseUrl);
    if (provider === 'anthropic') return 'https://api.anthropic.com';
    return 'https://api.openai.com/v1';
  }
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  return (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
}

async function callRaw({ system, user, model, temperature, maxTokens, key, cfg, providerOverride, jsonMode = true, images }) {
  const provider = providerOverride || cfg.provider;
  const base = baseUrlForProvider(provider, cfg, providerOverride);
  const url = endpointForProvider(provider, base);

  if (provider === 'anthropic') {
    // 用户消息：文本在前，图片在后（视觉模型要求）
    let userContent = user;
    if (images && images.length > 0) {
      userContent = [
        { type: 'text', text: user },
        ...images.map((img) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.media_type || 'image/png',
            data: img.data,  // 纯 base64 字符串，不含 data: 前缀
          },
        })),
      ];
    }
    const body = {
      model,
      max_tokens: maxTokens || 2048,
      temperature,
      // 把稳定的系统提示词打上 ephemeral 缓存标记，重复调用省 token。
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    };
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }, cfg.timeoutMs);
    if (!res.ok) throw new AIError(`Anthropic 请求失败 ${res.status}: ${(await safeText(res)).slice(0, 500)}`);
    const data = await res.json();
    if (!Array.isArray(data.content)) throw new AIError('Anthropic 响应缺少 content');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const u = data.usage || {};
    return {
      text,
      usage: {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cached: (u.cache_read_input_tokens || 0),
      },
    };
  }

  // OpenAI / OpenAI 兼容
  let userContent = user;
  if (images && images.length > 0) {
    userContent = [
      { type: 'text', text: user },
      ...images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.media_type || 'image/png'};base64,${img.data}` },
      })),
    ];
  }
  const fixedParams = usesMoonshotFixedParams(provider, base, model);
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  };
  if (fixedParams) {
    // Kimi K2.6/K2.5 对 temperature/top_p 等采样参数要求固定值。
    // 这里关闭 thinking 并省略 temperature，避免连通性测试和日报调用被参数校验拒绝。
    body.thinking = { type: 'disabled' };
  } else {
    body.temperature = temperature;
  }
  // 仅官方 OpenAI 强制 JSON 模式；兼容端点未必支持，靠提示词 + 兜底解析。
  if (provider === 'openai' && jsonMode) body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, cfg.timeoutMs);
  if (!res.ok) throw new AIError(`AI 请求失败 ${res.status}: ${(await safeText(res)).slice(0, 500)}`);
  const data = await res.json();
  if (!Array.isArray(data.choices)) throw new AIError('AI 响应缺少 choices');
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  return {
    text,
    usage: {
      input: u.prompt_tokens || 0,
      output: u.completion_tokens || 0,
      cached: u.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

async function callRawWithNetworkRetry(args, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await callRaw(args);
    } catch (e) {
      lastErr = e;
      // 鉴权类错误别重试，直接抛
      if (/ 401| 403/.test(e.message)) throw e;
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function inferTestProvider({ provider, apiKey, baseUrl, fallbackProvider }) {
  if (VALID_PROVIDERS.has(provider)) return provider;
  const base = String(baseUrl || '').toLowerCase();
  if ((apiKey && apiKey.startsWith('sk-ant-')) || base.includes('anthropic')) return 'anthropic';
  if (base && !base.includes('openai.com')) return 'openai-compatible';
  return VALID_PROVIDERS.has(fallbackProvider) ? fallbackProvider : 'openai';
}

function classifyTestError(e) {
  const msg = String(e?.message || e);
  if (/未配置 API Key/.test(msg)) return { stage: 'config', error: msg };
  if (/AbortError|aborted|timeout|超时/i.test(msg)) {
    return { stage: 'timeout', error: 'AI 请求超时。请检查网络、代理或接口地址，必要时调大超时时间。' };
  }
  const status = Number(msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] || 0) || undefined;
  if (status === 401 || status === 403) {
    return { stage: 'auth', status, error: 'API Key 无效或无权访问该供应商。请确认 Key 属于当前选择的平台。' };
  }
  if (status === 404) {
    return { stage: 'model', status, error: '模型不存在、不可用，或 Base URL 路径不正确。请检查模型名和接口地址。' };
  }
  if (status === 429) {
    return { stage: 'rate_limit', status, error: '接口限流或额度不足（429）。请稍后重试或更换额度充足的 Key。' };
  }
  if (status) return { stage: 'request', status, error: `接口请求失败（HTTP ${status}）。请检查供应商、Base URL 和模型名。` };
  if (/JSON|不是有效|未返回|响应缺少|Unexpected token|Unexpected end/i.test(msg)) return { stage: 'json', error: '接口已返回，但响应不是预期 JSON。请确认该模型支持聊天补全并可正常输出。' };
  return { stage: 'request', error: msg || 'AI 测试请求失败。' };
}

/**
 * 调用模型并返回校验过的 JSON。
 * @param {object} o
 * @param {string} o.system 系统提示词（稳定，利于缓存）
 * @param {string} o.user 用户内容
 * @param {string} [o.model]
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {string} [o.task] 用量归类
 * @param {(json:any)=>(string|null)} [o.validate] 返回 null 表示通过，返回字符串表示错误原因
 */
const isAuthError = (msg) => / 401| 403/.test(String(msg));

/** 把底层错误转成对用户可读、可行动的提示。 */
export function friendlyError(e) {
  const m = String(e?.message || e);
  if (isAuthError(m)) {
    return new AIError('API Key 无效或认证失败（401/403）。请到「设置」检查并重新保存 Key，再点「测试调用」。');
  }
  if (/AbortError|aborted|timeout/i.test(m)) {
    return new AIError('AI 请求超时。请检查网络或代理，或在「设置」调大超时时间后重试。');
  }
  if (/ 429/.test(m)) {
    return new AIError('AI 接口限流（429）。请稍后重试，或更换额度充足的 Key。');
  }
  return e instanceof AIError ? e : new AIError(m);
}

export async function callJSON({ system, user, model, temperature, maxTokens, task = 'ai', validate, images }) {
  const cfg = loadConfig();
  const key = getApiKey();
  if (!key) throw new AIError('未配置 API Key，请在「设置」里填写。');

  const useModel = model || cfg.model;
  const jsonRetries = cfg.retries ?? 2;
  let lastErr;
  let extra = '';

  for (let attempt = 0; attempt <= jsonRetries; attempt++) {
    const userMsg = extra ? `${user}\n\n${extra}` : user;
    let raw;
    try {
      raw = await callRawWithNetworkRetry({
        system, user: userMsg, model: useModel,
        temperature: temperature ?? cfg.temperature, maxTokens, key, cfg, images,
      }, cfg.retries ?? 2);
    } catch (netErr) {
      // 网络/鉴权类错误：先尝试备用 Key，再决定是否抛出。
      lastErr = netErr;
      if (isAuthError(netErr.message)) {
        const viaBackup = await tryBackupKey({ system, user, model: useModel, temperature, maxTokens, task, validate, cfg });
        if (viaBackup) return viaBackup;
      }
      throw friendlyError(netErr);
    }

    // 用量始终记账（即便这次 JSON 不合法，token 也确实花了）
    addUsage({ task, model: useModel, input: raw.usage.input, output: raw.usage.output, cached: raw.usage.cached });

    try {
      const json = extractJson(raw.text);
      if (validate) {
        const err = validate(json);
        if (err) {
          lastErr = new AIError(`校验未通过：${err}`);
          extra = `上次输出有问题（${err}）。请只返回一个严格合法的 JSON 对象，不要任何额外文字或代码块。`;
          log.warn(`[${task}] JSON 校验失败，重试 ${attempt + 1}/${jsonRetries}: ${err}`);
          continue;
        }
      }
      return { json, usage: raw.usage, model: useModel };
    } catch (e) {
      lastErr = e;
      extra = '上次输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块或解释。';
      log.warn(`[${task}] JSON 解析失败，重试 ${attempt + 1}/${jsonRetries}`);
    }
  }
  throw friendlyError(lastErr || new AIError('AI 调用失败'));
}

/** 主 Key 鉴权失败时用备用 Key 重试一次。成功返回结果对象，否则返回 null。 */
async function tryBackupKey({ system, user, model, temperature, maxTokens, task, validate, cfg }) {
  const backupKey = getApiKey2();
  if (!backupKey) return null;
  log.info('[备用Key] 主 Key 鉴权失败，尝试备用 Key…');
  const base = (cfg.baseUrl || '').toLowerCase();
  const backupProvider = backupKey.startsWith('sk-ant-') ? 'anthropic'
    : (base && !base.includes('openai.com')) ? 'openai-compatible' : 'openai';
  try {
    const raw = await callRawWithNetworkRetry({
      system, user, model,
      temperature: temperature ?? cfg.temperature, maxTokens, key: backupKey, cfg,
      providerOverride: backupProvider,
    }, cfg.retries ?? 2);
    addUsage({ task, model, input: raw.usage.input, output: raw.usage.output, cached: raw.usage.cached });
    const json = extractJson(raw.text);
    if (validate) {
      const err = validate(json);
      if (err) throw new AIError(`备用 Key 校验未通过：${err}`);
    }
    log.info('[备用Key] 成功。');
    return { json, usage: raw.usage, model };
  } catch (e2) {
    log.warn(`[备用Key] 也失败了：${e2.message}`);
    return null;
  }
}

/** 配置页的「测试调用」用：用最小代价验证 Key/模型可用。 */
export async function testConnection(overrides = {}) {
  const saved = loadConfig();
  const tempKey = typeof overrides.apiKey === 'string' ? overrides.apiKey.trim() : '';
  const keySlot = overrides.keySlot === 'backup' ? 'backup' : 'primary';
  const savedKey = keySlot === 'backup' ? getApiKey2() : getApiKey();
  const key = tempKey || savedKey;
  const baseUrl = Object.hasOwn(overrides, 'baseUrl') ? String(overrides.baseUrl || '').trim() : saved.baseUrl;
  const provider = inferTestProvider({
    provider: overrides.provider,
    apiKey: key,
    baseUrl,
    fallbackProvider: saved.provider,
  });
  const model = String(overrides.model || saved.model || '').trim();
  const cfg = { ...saved, provider, baseUrl, model };
  const endpoint = endpointForProvider(provider, baseUrl);

  if (!key) {
    const label = keySlot === 'backup' ? '备用 API Key' : 'API Key';
    return { ok: false, stage: 'config', keySlot, provider, model, endpoint, error: `未配置${label}。请粘贴 Key 后测试，或先保存 Key。` };
  }
  if (!model) {
    return { ok: false, stage: 'config', keySlot, provider, model, endpoint, error: '未填写模型名。请选择供应商后填写模型。' };
  }

  try {
    const raw = await callRawWithNetworkRetry({
      system: '你是一个连通性测试器。请用最短内容回复。',
      user: '请回复 OK',
      model,
      temperature: 0,
      maxTokens: 50,
      key,
      cfg,
      jsonMode: false,
    }, 0);
    addUsage({ task: 'test', model, input: raw.usage.input, output: raw.usage.output, cached: raw.usage.cached });
    return { ok: true, keySlot, provider, model, endpoint, usage: raw.usage };
  } catch (e) {
    return { ok: false, keySlot, provider, model, endpoint, ...classifyTestError(e) };
  }
}

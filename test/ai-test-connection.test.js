import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-ai-test-'));

const { saveConfig, setApiKey, getApiKey, setApiKey2, getApiKey2 } = await import('../server/config.js');
const { endpointForProvider, testConnection } = await import('../server/ai/client.js');

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

function response({ status = 200, body }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
}

function openAIJson(content = '{"ok":true}', usage = {}) {
  return {
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: usage.input || 3,
      completion_tokens: usage.output || 2,
      prompt_tokens_details: { cached_tokens: usage.cached || 0 },
    },
  };
}

test('endpointForProvider：兼容 OpenAI 根地址、/v1 和完整路径', () => {
  assert.equal(endpointForProvider('openai', ''), 'https://api.openai.com/v1/chat/completions');
  assert.equal(endpointForProvider('openai-compatible', 'https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(endpointForProvider('openai-compatible', 'https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
});

test('endpointForProvider：Anthropic 根地址、/v1 和完整路径', () => {
  assert.equal(endpointForProvider('anthropic', ''), 'https://api.anthropic.com/v1/messages');
  assert.equal(endpointForProvider('anthropic', 'https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');
  assert.equal(endpointForProvider('anthropic', 'https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1/messages');
});

test('testConnection：传入临时 Key 时只用于本次测试，不覆盖已保存 Key', async () => {
  saveConfig({ baseUrl: '', model: 'gpt-4o-mini' });
  setApiKey('sk-saved-111111');
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return response({ body: openAIJson() });
  };

  const r = await testConnection({
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-temp-222222',
  });

  assert.equal(r.ok, true);
  assert.equal(r.provider, 'openai-compatible');
  assert.equal(r.endpoint, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(seen.url, r.endpoint);
  assert.equal(seen.options.headers.authorization, 'Bearer sk-temp-222222');
  assert.equal(getApiKey(), 'sk-saved-111111');
});

test('testConnection：不传临时 Key 时使用已保存 Key', async () => {
  saveConfig({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' });
  setApiKey('sk-saved-333333');
  let auth;
  globalThis.fetch = async (_url, options) => {
    auth = options.headers.authorization;
    return response({ body: openAIJson() });
  };

  const r = await testConnection({ provider: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' });

  assert.equal(r.ok, true);
  assert.equal(auth, 'Bearer sk-saved-333333');
});

test('testConnection：备用 Key 可单独测试，传临时备用 Key 时不覆盖已保存备用 Key', async () => {
  saveConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
  setApiKey2('sk-backup-saved-555555');
  let auth;
  globalThis.fetch = async (_url, options) => {
    auth = options.headers.authorization;
    return response({ body: openAIJson() });
  };

  const r = await testConnection({
    keySlot: 'backup',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-backup-temp-666666',
  });

  assert.equal(r.ok, true);
  assert.equal(r.keySlot, 'backup');
  assert.equal(auth, 'Bearer sk-backup-temp-666666');
  assert.equal(getApiKey2(), 'sk-backup-saved-555555');
});

test('testConnection：备用 Key 不传临时 Key 时使用已保存备用 Key', async () => {
  setApiKey('sk-primary-777777');
  setApiKey2('sk-backup-saved-888888');
  let auth;
  globalThis.fetch = async (_url, options) => {
    auth = options.headers.authorization;
    return response({ body: openAIJson() });
  };

  const r = await testConnection({ keySlot: 'backup', provider: 'openai', model: 'gpt-4o-mini' });

  assert.equal(r.ok, true);
  assert.equal(r.keySlot, 'backup');
  assert.equal(auth, 'Bearer sk-backup-saved-888888');
  assert.equal(getApiKey(), 'sk-primary-777777');
});

test('testConnection：Anthropic 走 messages endpoint 和 x-api-key', async () => {
  setApiKey('sk-ant-api03-saved');
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return response({
      body: {
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
      },
    });
  };

  const r = await testConnection({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5' });

  assert.equal(r.ok, true);
  assert.equal(r.endpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.url, r.endpoint);
  assert.equal(seen.options.headers['x-api-key'], 'sk-ant-api03-saved');
});

test('testConnection：HTTP 错误会分类且不回显完整 Key', async () => {
  setApiKey('sk-secret-should-not-leak');
  globalThis.fetch = async () => response({ status: 401, body: { error: 'bad key sk-secret-should-not-leak' } });

  const r = await testConnection({ provider: 'openai', baseUrl: '', model: 'gpt-4o-mini' });

  assert.equal(r.ok, false);
  assert.equal(r.stage, 'auth');
  assert.equal(r.status, 401);
  assert.doesNotMatch(JSON.stringify(r), /sk-secret-should-not-leak/);
});

test('testConnection：OpenAI 兼容接口返回普通文本时也算连通成功', async () => {
  setApiKey('sk-status-plain-text');
  globalThis.fetch = async () => response({ body: openAIJson('OK') });

  const r = await testConnection({ provider: 'openai-compatible', model: 'plain-text-model' });

  assert.equal(r.ok, true);
  assert.equal(r.stage, undefined);
});

test('testConnection：Kimi K2.6 兼容固定采样参数', async () => {
  setApiKey('sk-kimi-262626');
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return response({ body: openAIJson('OK') });
  };

  const r = await testConnection({
    provider: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
  });

  assert.equal(r.ok, true);
  assert.equal(body.model, 'kimi-k2.6');
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.thinking, { type: 'disabled' });
});

test('testConnection：模型不存在、限流、响应结构异常分别给出阶段', async () => {
  setApiKey('sk-status-444444');
  globalThis.fetch = async () => response({ status: 404, body: { error: 'model not found' } });
  assert.equal((await testConnection({ provider: 'openai', model: 'wrong-model' })).stage, 'model');

  globalThis.fetch = async () => response({ status: 429, body: { error: 'rate limit' } });
  assert.equal((await testConnection({ provider: 'openai', model: 'gpt-4o-mini' })).stage, 'rate_limit');

  globalThis.fetch = async () => response({ body: { usage: {} } });
  assert.equal((await testConnection({ provider: 'openai', model: 'gpt-4o-mini' })).stage, 'json');
});

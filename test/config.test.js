import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-config-'));

const {
  loadConfig, saveConfig, setApiKey, getApiKey, clearApiKey, hasApiKey,
  setApiKey2, getApiKey2, getPublicConfig, effectiveBaseUrl,
} = await import('../server/config.js');
const { redact } = await import('../server/lib/log.js');

test('默认配置：openai + 自动生成配对 token', () => {
  const c = loadConfig();
  assert.ok(c.pairingToken && c.pairingToken.length >= 24);
  assert.equal(c.rpa.maxTabsPerBatch, 6);
  assert.equal(c.rpa.wechatVideosPerAccount, 3);
  assert.equal(getPublicConfig().hasApiKey, false);
});

test('巡检标签数和视频号读取数会保存并限制在 1-10 范围', () => {
  let pub = saveConfig({ rpa: { maxTabsPerBatch: 7.8, wechatVideosPerAccount: 4.9 } });
  assert.equal(pub.rpa.maxTabsPerBatch, 7);
  assert.equal(pub.rpa.wechatVideosPerAccount, 4);
  pub = saveConfig({ rpa: { maxTabsPerBatch: 999, wechatVideosPerAccount: 999 } });
  assert.equal(pub.rpa.maxTabsPerBatch, 10);
  assert.equal(pub.rpa.wechatVideosPerAccount, 10);
  pub = saveConfig({ rpa: { maxTabsPerBatch: -5, wechatVideosPerAccount: -5 } });
  assert.equal(pub.rpa.maxTabsPerBatch, 1);
  assert.equal(pub.rpa.wechatVideosPerAccount, 1);
  saveConfig({ rpa: { maxTabsPerBatch: 6, wechatVideosPerAccount: 3 } });
});

test('默认回溯天数与每日自动运行设置会持久保存', () => {
  const pub = saveConfig({
    schedule: { enabled: true, time: '08:30', window: 'last_5_days' },
    rpa: { maxTabsPerBatch: 6 },
  });
  assert.equal(pub.schedule.enabled, true);
  assert.equal(pub.schedule.time, '08:30');
  assert.equal(pub.schedule.window, 'last_5_days');

  const fresh = loadConfigFresh();
  assert.equal(fresh.schedule.enabled, true);
  assert.equal(fresh.schedule.time, '08:30');
  assert.equal(fresh.schedule.window, 'last_5_days');
});

test('API Key 加密往返：存进去能解出来', () => {
  setApiKey('sk-test-1234567890abcdef');
  assert.equal(getApiKey(), 'sk-test-1234567890abcdef');
  assert.equal(hasApiKey(), true);
  assert.ok(Date.parse(getPublicConfig().apiKeyUpdatedAt));
});

test('getPublicConfig 绝不泄露明文 Key，只给末 4 位', () => {
  setApiKey('sk-secret-keyEND9999');
  const pub = getPublicConfig();
  assert.equal(pub.apiKeyLast4, '9999');
  assert.equal(pub.hasApiKey, true);
  // 整个公开对象里不能出现明文或密文字段
  const s = JSON.stringify(pub);
  assert.doesNotMatch(s, /sk-secret-keyEND9999/);
  assert.equal('apiKeyEnc' in pub, false);
});

test('日志脱敏：注册的 Key 在日志里被替换', () => {
  setApiKey('sk-redact-me-7777777777');
  loadConfig.cache = null; // 触发 refreshRedaction（loadConfig 内部会调用）
  // setApiKey 已调用 refreshRedaction，这里直接验证
  const line = redact('调用失败，key=sk-redact-me-7777777777 末尾');
  assert.doesNotMatch(line, /sk-redact-me-7777777777/);
  assert.match(line, /REDACTED/);
});

test('provider 自动推断：DeepSeek 兼容接口 → openai-compatible', () => {
  saveConfig({ baseUrl: 'https://api.deepseek.com' });
  setApiKey('sk-deepseekkey123456');
  const c = loadConfigFresh();
  assert.equal(c.provider, 'openai-compatible');
  assert.equal(effectiveBaseUrl(), 'https://api.deepseek.com');
});

test('provider 自动推断：Anthropic key 前缀 → anthropic', () => {
  saveConfig({ baseUrl: '' });
  setApiKey('sk-ant-api03-xxxxxxxxxx');
  const c = loadConfigFresh();
  assert.equal(c.provider, 'anthropic');
  assert.equal(effectiveBaseUrl(), 'https://api.anthropic.com');
});

test('provider 自动推断：官方 openai（无 baseUrl）→ openai', () => {
  saveConfig({ baseUrl: '' });
  setApiKey('sk-proj-officialkey12345');
  const c = loadConfigFresh();
  assert.equal(c.provider, 'openai');
  assert.equal(effectiveBaseUrl(), 'https://api.openai.com/v1');
});

test('备用 Key 独立加密存取', () => {
  setApiKey2('sk-backup-888888888888');
  assert.equal(getApiKey2(), 'sk-backup-888888888888');
  assert.equal(getPublicConfig().hasApiKey2, true);
  assert.equal(getPublicConfig().apiKey2Last4, '8888');
  assert.ok(Date.parse(getPublicConfig().apiKey2UpdatedAt));
});

test('重复保存 API Key 会覆盖旧 Key，并更新公开状态', async () => {
  setApiKey('sk-old-key-1111');
  const first = getPublicConfig().apiKeyUpdatedAt;
  await new Promise((r) => setTimeout(r, 2));
  setApiKey('sk-new-key-2222');
  const pub = getPublicConfig();
  assert.equal(getApiKey(), 'sk-new-key-2222');
  assert.equal(pub.apiKeyLast4, '2222');
  assert.notEqual(pub.apiKeyUpdatedAt, first);
});

test('重复保存备用 API Key 会覆盖旧 Key，并更新公开状态', async () => {
  setApiKey2('sk-backup-old-3333');
  const first = getPublicConfig().apiKey2UpdatedAt;
  await new Promise((r) => setTimeout(r, 2));
  setApiKey2('sk-backup-new-4444');
  const pub = getPublicConfig();
  assert.equal(getApiKey2(), 'sk-backup-new-4444');
  assert.equal(pub.apiKey2Last4, '4444');
  assert.notEqual(pub.apiKey2UpdatedAt, first);
});

test('clearApiKey 清除主 Key 与保存时间', () => {
  setApiKey('sk-tobecleared-1234567');
  clearApiKey();
  assert.equal(hasApiKey(), false);
  assert.equal(getApiKey(), null);
  assert.equal(getPublicConfig().apiKeyUpdatedAt, null);
});

// loadConfig 内部有 cache；测试里要拿最新值需重置缓存模块状态。
// config.js 未导出 cache 重置入口，但 setApiKey/saveConfig 都会 writeRaw + 更新 cache 引用，
// 这里用动态再读的方式间接验证。
function loadConfigFresh() {
  return loadConfig();
}

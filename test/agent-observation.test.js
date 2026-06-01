import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// 每个测试文件用独立临时数据目录
process.env.VBP_DATA_DIR = mkdtempSync(join(tmpdir(), 'vbp-observation-test-'));

const { saveConfig, setApiKey } = await import('../server/config.js');
const { getObservation, upsertObservation } = await import('../server/store.js');
const { recognizePageState, observeVideo } = await import('../server/ai/observe.js');

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

function openAIMockResponse(jsonContent, usage = {}) {
  return {
    choices: [{ message: { content: JSON.stringify(jsonContent) } }],
    usage: {
      prompt_tokens: usage.input || 10,
      completion_tokens: usage.output || 5,
      prompt_tokens_details: { cached_tokens: usage.cached || 0 },
    },
  };
}

test('存储层: upsertObservation & getObservation 往返测试', () => {
  const contentId = 'test-content-123';
  const data = {
    observed_activity: '博主在展示AI工具',
    topic_category: 'AI 提效',
    scene: '办公室内',
    people_objects: '博主, 电脑',
    text_on_screen: '3步学会AI写代码',
    call_to_action: '点击下方链接试用',
    confidence: 0.95,
    evidence_notes: '画面有电脑和AI编辑器',
  };

  // 1. 插入观察数据
  const obs = upsertObservation(contentId, data, 'test-model');
  assert.ok(obs.id);
  assert.equal(obs.content_id, contentId);
  assert.equal(obs.observed_activity, data.observed_activity);
  assert.equal(obs.topic_category, data.topic_category);
  assert.equal(obs.confidence, 0.95);
  assert.equal(obs.model, 'test-model');

  // 2. 查询观察数据
  const queried = getObservation(contentId);
  assert.equal(queried.observed_activity, data.observed_activity);
  assert.equal(queried.confidence, 0.95);

  // 3. 更新观察数据
  const updatedData = { ...data, confidence: 0.99, observed_activity: '博主展示了Antigravity' };
  const updated = upsertObservation(contentId, updatedData, 'updated-model');
  assert.equal(updated.id, obs.id, '更新时 ID 应保持不变');
  assert.equal(updated.confidence, 0.99);
  assert.equal(updated.observed_activity, '博主展示了Antigravity');
});

test('observe 模块: recognizePageState 状态识别', async () => {
  saveConfig({ baseUrl: '', model: 'gpt-4o-mini' });
  setApiKey('sk-saved-key-observation');

  const pageStateMock = {
    page_type: 'creator_home',
    platform: 'douyin',
    confidence: 0.92,
    next_action: 'click_candidate',
    click_coords: { x: 200, y: 350 },
    elements: {
      latest_unpinned_card: { x: 200, y: 350 },
    },
  };

  globalThis.fetch = async () => {
    return response({ body: openAIMockResponse(pageStateMock) });
  };

  const { json, model } = await recognizePageState('dummy-b64-string', { platform: 'douyin', creator: '商业小王' });
  assert.equal(json.page_type, 'creator_home');
  assert.equal(json.confidence, 0.92);
  assert.deepEqual(json.elements.latest_unpinned_card, { x: 200, y: 350 });
  assert.equal(model, 'gpt-4o-mini');
});

test('observe 模块: observeVideo 观察详情页及缓存策略', async () => {
  saveConfig({ baseUrl: '', model: 'gpt-4o-mini' });
  setApiKey('sk-saved-key-observation');

  const contentId = 'uncached-content-id';
  const observationMock = {
    observed_activity: '博主在展示Antigravity agent',
    topic_category: 'AI 编码',
    scene: '室内',
    people_objects: '人, 屏幕',
    text_on_screen: 'AI编码助手',
    call_to_action: '关注点赞',
    confidence: 0.98,
    evidence_notes: '画面中央有 logo',
  };

  let apiCalled = 0;
  globalThis.fetch = async () => {
    apiCalled++;
    return response({ body: openAIMockResponse(observationMock) });
  };

  // 第一次：没有缓存，应调用 API
  const res1 = await observeVideo('dummy-b64-string', {
    content_id: contentId,
    platform: 'douyin',
    creator: '测试创作者',
  });

  assert.equal(res1.cached, false, '第一次应无缓存');
  assert.equal(res1.observation.observed_activity, '博主在展示Antigravity agent');
  assert.equal(apiCalled, 1);

  // 检查 DB 中是否已保存
  const saved = getObservation(contentId);
  assert.ok(saved);
  assert.equal(saved.observed_activity, '博主在展示Antigravity agent');

  // 第二次：命中缓存，不应调用 API
  const res2 = await observeVideo('dummy-b64-string', {
    content_id: contentId,
    platform: 'douyin',
    creator: '测试创作者',
  });

  assert.equal(res2.cached, true, '第二次应命中缓存');
  assert.equal(res2.observation.observed_activity, '博主在展示Antigravity agent');
  assert.equal(apiCalled, 1, 'API 调用次数不应增加');
});

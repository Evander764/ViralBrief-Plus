import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, AIError, friendlyError } from '../server/ai/client.js';
import { windowStartISO } from '../server/filter.js';

test('extractJson：纯 JSON', () => {
  assert.deepEqual(extractJson('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
});

test('extractJson：```json 代码块包裹', () => {
  const t = 'A bit of preface\n```json\n{"ok": true, "n": 3}\n```\nthanks';
  assert.deepEqual(extractJson(t), { ok: true, n: 3 });
});

test('extractJson：裸 ``` 代码块', () => {
  assert.deepEqual(extractJson('```\n{"x": 9}\n```'), { x: 9 });
});

test('extractJson：前后有解释文字，靠首尾大括号兜底', () => {
  const t = '这是结果：{"daily_summary":"abc","top_topic_clusters":[]} 以上。';
  const j = extractJson(t);
  assert.equal(j.daily_summary, 'abc');
  assert.deepEqual(j.top_topic_clusters, []);
});

test('extractJson：空/无 JSON → 抛 AIError', () => {
  assert.throws(() => extractJson(''), AIError);
  assert.throws(() => extractJson('完全没有 json'), AIError);
});

test('friendlyError：401/403 → 可读的 Key 失效提示', () => {
  const e = friendlyError(new AIError('AI 请求失败 401: {"error":"invalid key"}'));
  assert.match(e.message, /API Key 无效|认证失败|设置/);
  assert.doesNotMatch(e.message, /invalid key/); // 不回显底层细节
});

test('friendlyError：超时 / 429 各有针对性提示', () => {
  assert.match(friendlyError(new Error('The operation was aborted')).message, /超时/);
  assert.match(friendlyError(new AIError('AI 请求失败 429: rate limit')).message, /限流|429/);
});

test('friendlyError：普通错误原样透出', () => {
  assert.match(friendlyError(new AIError('模型返回不是有效 JSON')).message, /JSON/);
});

test('windowStartISO：兼容旧值 + 任意 last_N_days', () => {
  const now = new Date('2026-05-30T12:00:00.000Z');
  assert.equal(windowStartISO('last_3_days', now), '2026-05-27T12:00:00.000Z');
  assert.equal(windowStartISO('last_7_days', now), '2026-05-23T12:00:00.000Z');
  assert.equal(windowStartISO('last_1_day', now), '2026-05-29T12:00:00.000Z');
  assert.equal(windowStartISO('last_14_days', now), '2026-05-16T12:00:00.000Z');
});

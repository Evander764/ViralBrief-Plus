import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowDays, normalizeWindowType, windowLabel, windowStartISO } from '../server/filter.js';

test('windowDays 解析单复数与异常值', () => {
  assert.equal(windowDays('last_1_day'), 1);
  assert.equal(windowDays('last_1_days'), 1);
  assert.equal(windowDays('last_20_days'), 20);
  assert.equal(windowDays('garbage'), 1);
  assert.equal(windowDays(''), 1);
});

test('normalizeWindowType 统一成复数 last_N_days', () => {
  assert.equal(normalizeWindowType('last_1_day'), 'last_1_days');
  assert.equal(normalizeWindowType('last_1_days'), 'last_1_days');
  assert.equal(normalizeWindowType('last_3_days'), 'last_3_days');
  assert.equal(normalizeWindowType('last_14_days'), 'last_14_days');
});

test('关键修复：windowLabel 对任意天数都给中文标签（不再露出 last_N_days）', () => {
  assert.equal(windowLabel('last_1_day'), '最近 1 天');
  assert.equal(windowLabel('last_1_days'), '最近 1 天'); // 之前这里会显示 "last_1_days"
  assert.equal(windowLabel('last_2_days'), '最近 2 天');  // 之前会显示 "last_2_days"
  assert.equal(windowLabel('last_20_days'), '最近 20 天'); // 之前会显示 "last_20_days"
});

test('windowStartISO 任意天数', () => {
  const now = new Date('2026-05-30T12:00:00.000Z');
  assert.equal(windowStartISO('last_1_days', now), '2026-05-29T12:00:00.000Z');
  assert.equal(windowStartISO('last_20_days', now), '2026-05-10T12:00:00.000Z');
});

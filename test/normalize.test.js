import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMetric, normalizeMetrics } from '../server/normalize.js';

test('文档数据字典里的标准案例', () => {
  assert.equal(normalizeMetric('1k').value, 1000);
  assert.equal(normalizeMetric('1.2k').value, 1200);
  assert.equal(normalizeMetric('1w').value, 10000);
  assert.equal(normalizeMetric('1.2w').value, 12000);
  assert.equal(normalizeMetric('1000+').value, 1000);
  assert.equal(normalizeMetric('1万+').value, 10000);
});

test('中文万/千/亿单位', () => {
  assert.equal(normalizeMetric('1.5万').value, 15000);
  assert.equal(normalizeMetric('1.2万').value, 12000);
  assert.equal(normalizeMetric('10万+').value, 100000);
  assert.equal(normalizeMetric('3千').value, 3000);
  assert.equal(normalizeMetric('1.2亿').value, 120000000);
  assert.equal(normalizeMetric('1 万').value, 10000); // 数字与单位间有空格
});

test('千分位逗号与纯数字', () => {
  assert.equal(normalizeMetric('12,300').value, 12300);
  assert.equal(normalizeMetric('2,100').value, 2100);
  assert.equal(normalizeMetric('1,234,567').value, 1234567);
  assert.equal(normalizeMetric('999').value, 999);
  assert.equal(normalizeMetric('0').value, 0);
  assert.equal(normalizeMetric(8500).value, 8500);
});

test('带标签/前后缀文本也能抽出数字', () => {
  assert.equal(normalizeMetric('赞 1.2万').value, 12000);
  assert.equal(normalizeMetric('12.5k views').value, 12500);
  assert.equal(normalizeMetric('点赞12300').value, 12300);
});

test('全角数字', () => {
  assert.equal(normalizeMetric('１２３４').value, 1234);
  assert.equal(normalizeMetric('１.２万').value, 12000);
});

test('关键：无法识别返回 null（未知），而不是 0', () => {
  assert.equal(normalizeMetric('').value, null);
  assert.equal(normalizeMetric(null).value, null);
  assert.equal(normalizeMetric(undefined).value, null);
  assert.equal(normalizeMetric('赞').value, null);
  assert.equal(normalizeMetric('—').value, null);
  assert.equal(normalizeMetric('暂无').value, null);
  // 0 是「已知的零」，必须区别于 null
  assert.notEqual(normalizeMetric('0').value, null);
});

test('永远保留原始文本 raw', () => {
  assert.equal(normalizeMetric('1.2w').raw, '1.2w');
  assert.equal(normalizeMetric('赞 1.2万').raw, '赞 1.2万');
  assert.equal(normalizeMetric(null).raw, null);
});

test('normalizeMetrics 批量', () => {
  const out = normalizeMetrics({ like: '1.2w', share: '1500', comment: '', favorite: '3.4k' });
  assert.equal(out.like.value, 12000);
  assert.equal(out.share.value, 1500);
  assert.equal(out.comment.value, null);
  assert.equal(out.favorite.value, 3400);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDataStatus, isEligible, windowStartISO, THRESHOLD, ELIGIBLE_PLATFORMS, eligibleReason,
} from '../server/filter.js';

const base = {
  is_duplicate: 0, archived: 0, user_confirmed: 1, metrics_source: 'manual',
  platform: 'douyin', account_id: 'account-1',
  content_type: 'video', like_count: 5000, favorite_count: 5000, share_count: 5000,
};

test('平台必需互动指标全部达标 → confirmed', () => {
  assert.equal(computeDataStatus({ ...base }), 'confirmed');
  assert.equal(computeDataStatus({
    ...base, platform: 'xiaohongshu', like_count: 1001, favorite_count: 1001, share_count: 0,
  }), 'confirmed');
  assert.equal(computeDataStatus({
    ...base, platform: 'douyin', like_count: 1001, favorite_count: 1001, share_count: 1001,
  }), 'confirmed');
});

test('必需互动指标已知但未全部超过 1000 → below_threshold', () => {
  assert.equal(computeDataStatus({ ...base, like_count: 1000, share_count: 1000, favorite_count: 1000 }), 'below_threshold');
  assert.equal(computeDataStatus({ ...base, like_count: 999, favorite_count: 1001, share_count: 1001 }), 'below_threshold');
  assert.equal(computeDataStatus({ ...base, platform: 'xiaohongshu', like_count: 500, favorite_count: null }), 'needs_review');
});

test('1000+ 视为超过 1000，但纯 1000 不入选', () => {
  const xhsPlus = {
    ...base,
    platform: 'xiaohongshu',
    like_count: 1000,
    like_raw: '1000+',
    favorite_count: 1001,
  };
  assert.equal(computeDataStatus(xhsPlus), 'confirmed');
  assert.equal(computeDataStatus({ ...xhsPlus, like_raw: '1000' }), 'below_threshold');
  assert.equal(eligibleReason(xhsPlus), '点赞 1000+，收藏 1001 均达标');
});

test('必需指标缺失 → needs_review', () => {
  assert.equal(computeDataStatus({ ...base, like_count: null, favorite_count: null, share_count: null }), 'needs_review');
});

test('关键：自动识别且未经人工确认 → needs_review（不自动达标）', () => {
  // 即便数字看起来达标，只要来源是自动识别且没确认，就必须人工复核
  const auto = { ...base, metrics_source: 'page_ocr', user_confirmed: 0 };
  assert.equal(computeDataStatus(auto), 'needs_review');
  const autoText = { ...base, metrics_source: 'page_text', user_confirmed: 0 };
  assert.equal(computeDataStatus(autoText), 'needs_review');
  // 用户确认后即可正常判定
  assert.equal(computeDataStatus({ ...auto, user_confirmed: 1 }), 'confirmed');
});

test('稳定页面证据可自动入选，弱文本/OCR 证据需复核', () => {
  const stable = { ...base, metrics_source: 'rpa', metrics_confidence: 'structured', user_confirmed: 0 };
  assert.equal(computeDataStatus(stable), 'confirmed');

  const weak = { ...base, metrics_source: 'rpa', metrics_confidence: 'text', user_confirmed: 0 };
  assert.equal(computeDataStatus(weak), 'needs_review');

  const mixed = {
    ...base,
    metrics_source: 'rpa',
    metrics_confidence: 'structured',
    like_count: 5000,
    favorite_count: 5000,
    share_count: 10,
    metrics_evidence_json: JSON.stringify({
      like: { source: 'text', raw: '5000', value: 5000 },
      favorite: { source: 'structured', raw: 5000, value: 5000 },
      share: { source: 'structured', raw: 10, value: 10 },
    }),
    user_confirmed: 0,
  };
  assert.equal(computeDataStatus(mixed), 'needs_review');
});

test('授权 API 来源视为可信', () => {
  assert.equal(computeDataStatus({ ...base, metrics_source: 'authorized', user_confirmed: 0 }), 'confirmed');
});

test('duplicate / archived 优先级最高', () => {
  assert.equal(computeDataStatus({ ...base, is_duplicate: 1 }), 'duplicate');
  assert.equal(computeDataStatus({ ...base, archived: 1 }), 'archived');
});

test('isEligible：只有账号池小红书/抖音 + confirmed + video/article + 平台必需指标达标才入选', () => {
  assert.equal(isEligible({ ...base, data_status: 'confirmed' }), true);
  assert.equal(isEligible({ ...base, data_status: 'missing_share' }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', content_type: 'other' }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', platform: 'wechat_article' }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', platform: 'wechat_channels' }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', account_id: null }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', like_count: 1000, share_count: 1000, favorite_count: 1000 }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', like_count: 1000, like_raw: '1000+', favorite_count: 1001, share_count: 1001 }), true);
});

test('阈值常量就是 1000', () => {
  assert.equal(THRESHOLD, 1000);
  assert.deepEqual(ELIGIBLE_PLATFORMS, ['douyin', 'xiaohongshu']);
});

test('时间窗口起点计算', () => {
  const now = new Date('2026-05-30T12:00:00.000Z');
  assert.equal(windowStartISO('last_3_days', now), '2026-05-27T12:00:00.000Z');
  assert.equal(windowStartISO('last_7_days', now), '2026-05-23T12:00:00.000Z');
});

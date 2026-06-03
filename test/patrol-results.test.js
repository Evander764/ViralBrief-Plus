import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPatrolResult, patrolStatusMessage } from '../server/rpa/patrol-results.js';

test('patrol result status distinguishes failed, partial, stopped, and success', () => {
  assert.equal(classifyPatrolResult({ total: 2, success: 0, failed: 2 }), 'failed');
  assert.equal(classifyPatrolResult({ total: 2, success: 1, failed: 1 }), 'partial');
  assert.equal(classifyPatrolResult({ total: 2, success: 1, failed: 0, stopped: true }), 'stopped');
  assert.equal(classifyPatrolResult({ total: 0, success: 0, failed: 0 }), 'success');
  assert.equal(patrolStatusMessage('failed'), '自动巡检失败。');
  assert.equal(patrolStatusMessage('partial'), '自动巡检部分失败。');
});

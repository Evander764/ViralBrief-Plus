import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginPatrolRun,
  endPatrolRun,
  getPatrolRunState,
  requestPatrolStop,
} from '../server/rpa/control.js';

test('patrol control rejects concurrent runs and preserves the active stop target', () => {
  const first = beginPatrolRun({ source: 'test', platforms: ['xiaohongshu'] });
  try {
    assert.throws(
      () => beginPatrolRun({ source: 'second', platforms: ['douyin'] }),
      (err) => err.code === 'VBP_PATROL_ACTIVE' && /已有巡检正在运行/.test(err.message),
    );

    const active = getPatrolRunState();
    assert.equal(active.id, first.id);
    assert.equal(active.source, 'test');

    const stopped = requestPatrolStop();
    assert.equal(stopped.active, true);
    assert.equal(stopped.id, first.id);
    assert.equal(first.shouldStop(), true);
  } finally {
    endPatrolRun(first.id);
  }

  assert.equal(getPatrolRunState(), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clickRectLikeHuman,
  easeInOut,
  executeHumanActions,
  randomPointInRect,
  validateActions,
} from '../server/rpa/human-actions.js';

test('human-actions rejects unknown actions and out-of-bounds coordinates', () => {
  assert.throws(() => validateActions([{ type: 'shell', x: 1, y: 1 }]), /unknown action type/);
  assert.throws(() => validateActions([{ type: 'move', x: 1200, y: 10 }], { width: 100, height: 100 }), /outside/);
  assert.throws(() => validateActions([{ type: 'wait', milliseconds: 20000 }]), /outside the allowed range/);
});

test('easeInOut is stable and bounded', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.ok(easeInOut(0.25) > 0);
  assert.ok(easeInOut(0.75) < 1);
});

test('executeHumanActions runs validated mouse and scroll actions', async () => {
  const calls = [];
  const client = {
    async evaluate() { return { x: 10, y: 10 }; },
    async mouseMove(x, y) { calls.push(['move', Math.round(x), Math.round(y)]); },
    async mouseClick(x, y, options) { calls.push(['click', Math.round(x), Math.round(y), options]); },
    async mouseWheel(dx, dy) { calls.push(['wheel', dx, dy]); },
    async sleep() {},
  };

  await executeHumanActions(client, [
    { type: 'move', x: 20, y: 20, duration_ms: 48 },
    { type: 'click', x: 20, y: 20, hold_ms: 220 },
    { type: 'scroll', delta_y: 500 },
  ], { width: 100, height: 100 });

  const click = calls.find((c) => c[0] === 'click');
  assert.equal(click?.[3]?.holdMs, 220);
  assert.ok(calls.some((c) => c[0] === 'wheel' && c[2] === 500));
});

test('randomPointInRect uses offsets relative to the card rect', () => {
  const rect = { left: 600, top: 250, width: 160, height: 120 };
  const point = randomPointInRect(rect, {
    rng: () => 0.5,
    insetRatio: 0.1,
    minInset: 10,
    maxInset: 30,
  });

  assert.ok(point.x > rect.left);
  assert.ok(point.x < rect.left + rect.width);
  assert.ok(point.y > rect.top);
  assert.ok(point.y < rect.top + rect.height);
  assert.ok(point.x > rect.width, 'x should be page-relative from rect.left, not global-random within width');
});

test('clickRectLikeHuman clicks inside the card and passes randomized hold time', async () => {
  const calls = [];
  const client = {
    async evaluate() { return { x: 10, y: 10 }; },
    async mouseMove(x, y) { calls.push(['move', x, y]); },
    async mouseClick(x, y, options) { calls.push(['click', x, y, options]); },
    async sleep() {},
  };

  const rect = { left: 120, top: 180, width: 240, height: 160 };
  const result = await clickRectLikeHuman(client, rect, {
    viewport: { width: 800, height: 600 },
    rng: () => 0.5,
    minMoveMs: 300,
    maxMoveMs: 300,
    minHoldMs: 180,
    maxHoldMs: 180,
  });

  const click = calls.find((c) => c[0] === 'click');
  assert.ok(click[1] > rect.left && click[1] < rect.left + rect.width);
  assert.ok(click[2] > rect.top && click[2] < rect.top + rect.height);
  assert.equal(click[3].holdMs, 180);
  assert.equal(result.holdMs, 180);
});

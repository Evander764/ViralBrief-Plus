/**
 * Human-like CDP action executor.
 *
 * This mirrors the useful safety shape of AI Mouse without requiring macOS
 * Accessibility: actions are small, validated, bounded, and executed through
 * Chrome DevTools Protocol.
 */

export const ACTION_TYPES = new Set(['move', 'click', 'double_click', 'scroll', 'wait']);
export const MAX_ACTIONS = 20;
export const MAX_WAIT_MS = 10_000;
export const MAX_MOVE_MS = 5_000;
export const MAX_HOLD_MS = 2_000;

export function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
}

export function validateActions(actions, viewport = { width: 1280, height: 800 }) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('actions must be a non-empty array');
  }
  if (actions.length > MAX_ACTIONS) {
    throw new Error('too many actions');
  }

  for (const action of actions) validateAction(action, viewport);
  return actions;
}

function validateAction(action, viewport) {
  if (!ACTION_TYPES.has(action?.type)) throw new Error(`unknown action type: ${action?.type}`);
  if (['move', 'click', 'double_click'].includes(action.type)) {
    requirePoint(action.x, action.y, viewport, action.type);
    if (action.duration_ms != null && (action.duration_ms < 0 || action.duration_ms > MAX_MOVE_MS)) {
      throw new Error(`${action.type} duration_ms is outside the allowed range`);
    }
    if (action.hold_ms != null && (action.hold_ms < 0 || action.hold_ms > MAX_HOLD_MS)) {
      throw new Error(`${action.type} hold_ms is outside the allowed range`);
    }
  }
  if (action.type === 'scroll') {
    if (action.x != null || action.y != null) requirePoint(action.x, action.y, viewport, 'scroll');
    if (!Number.isFinite(Number(action.delta_y))) throw new Error('scroll requires delta_y');
  }
  if (action.type === 'wait') {
    const ms = Number(action.milliseconds || 0);
    if (ms <= 0 || ms > MAX_WAIT_MS) throw new Error('wait milliseconds is outside the allowed range');
  }
}

function requirePoint(x, y, viewport, label) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw new Error(`${label} requires x and y`);
  }
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    throw new Error(`${label} point is outside the viewport bounds`);
  }
}

export async function executeHumanActions(client, actions, viewport) {
  validateActions(actions, viewport);
  for (const action of actions) {
    if (action.type === 'move') {
      await humanMove(client, action.x, action.y, action.duration_ms ?? 450);
    } else if (action.type === 'click') {
      await humanMove(client, action.x, action.y, action.duration_ms ?? 180);
      await client.mouseClick(action.x, action.y, {
        button: action.button || 'left',
        holdMs: action.hold_ms ?? action.holdMs,
      });
    } else if (action.type === 'double_click') {
      await humanMove(client, action.x, action.y, action.duration_ms ?? 180);
      await client.mouseClick(action.x, action.y, {
        button: action.button || 'left',
        clickCount: 2,
        holdMs: action.hold_ms ?? action.holdMs,
      });
    } else if (action.type === 'scroll') {
      await client.mouseWheel(action.delta_x || 0, action.delta_y, action.x || 400, action.y || 400);
    } else if (action.type === 'wait') {
      await client.sleep(action.milliseconds);
    }
    await client.sleep(90 + Math.random() * 80);
  }
}

async function humanMove(client, x, y, durationMs) {
  const steps = Math.max(4, Math.min(60, Math.floor(durationMs / 12)));
  const start = await pointerLocation(client);
  for (let step = 1; step <= steps; step++) {
    const p = easeInOut(step / steps);
    await client.mouseMove(
      start.x + (x - start.x) * p,
      start.y + (y - start.y) * p,
    );
    await client.sleep(Math.max(1, Math.floor(durationMs / steps)));
  }
}

async function pointerLocation(client) {
  try {
    const loc = await client.evaluate('window.__vbpPointer || { x: innerWidth / 2, y: innerHeight / 2 }');
    return {
      x: Number.isFinite(Number(loc?.x)) ? Number(loc.x) : 400,
      y: Number.isFinite(Number(loc?.y)) ? Number(loc.y) : 300,
    };
  } catch {
    return { x: 400, y: 300 };
  }
}

export async function clickElementLikeHuman(client, selectorOrScript) {
  const rect = await client.evaluate(`
    (() => {
      const el = typeof ${JSON.stringify(selectorOrScript)} === 'string' && ${JSON.stringify(selectorOrScript)}.startsWith('js:')
        ? eval(${JSON.stringify(selectorOrScript)}.slice(3))
        : document.querySelector(${JSON.stringify(selectorOrScript)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: innerWidth, height: innerHeight };
    })()
  `);
  if (!rect) return false;
  await executeHumanActions(client, [
    { type: 'move', x: rect.x, y: rect.y, duration_ms: 260 },
    { type: 'click', x: rect.x, y: rect.y },
  ], { width: rect.width, height: rect.height });
  return true;
}

export function randomPointInRect(rect, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const left = Number(rect?.left ?? rect?.x);
  const top = Number(rect?.top ?? rect?.y);
  const width = Number(rect?.width);
  const height = Number(rect?.height);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('rect must include finite left/top/width/height');
  }

  const insetRatio = opts.insetRatio ?? 0.16;
  const minInset = opts.minInset ?? 8;
  const maxInset = opts.maxInset ?? 42;
  const xInset = safeInset(width, insetRatio, minInset, maxInset);
  const yInset = safeInset(height, insetRatio, minInset, maxInset);
  const minX = left + xInset;
  const maxX = left + width - xInset;
  const minY = top + yInset;
  const maxY = top + height - yInset;

  return {
    x: randomBetween(minX, maxX, rng),
    y: randomBetween(minY, maxY, rng),
  };
}

export async function clickRectLikeHuman(client, rect, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const point = randomPointInRect(rect, { ...opts, rng });
  const moveMs = randomBetween(opts.minMoveMs ?? 260, opts.maxMoveMs ?? 520, rng);
  const holdMs = randomBetween(opts.minHoldMs ?? 140, opts.maxHoldMs ?? 340, rng);
  const viewport = opts.viewport
    || rect?.viewport
    || { width: Math.ceil(Number(rect.left ?? rect.x ?? 0) + Number(rect.width || 0)), height: Math.ceil(Number(rect.top ?? rect.y ?? 0) + Number(rect.height || 0)) };

  await executeHumanActions(client, [
    { type: 'move', x: point.x, y: point.y, duration_ms: moveMs },
    { type: 'click', x: point.x, y: point.y, hold_ms: holdMs },
  ], viewport);

  return { ...point, moveMs, holdMs };
}

function randomBetween(min, max, rng) {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  if (hi <= lo) return lo;
  return lo + rng() * (hi - lo);
}

function safeInset(size, ratio, minInset, maxInset) {
  const halfLimit = Math.max(0, size / 2 - 1);
  const wanted = Math.max(minInset, size * ratio);
  return Math.min(maxInset, wanted, halfLimit);
}

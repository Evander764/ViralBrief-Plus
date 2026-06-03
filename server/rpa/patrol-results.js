export function combinePatrolResults(results = []) {
  const out = {
    total: 0,
    success: 0,
    failed: 0,
    newItems: 0,
    duplicates: 0,
    discovered: 0,
    skippedToday: 0,
    platformResults: {},
    details: [],
    stages: [],
    stopped: false,
  };

  for (const r of results.filter(Boolean)) {
    out.stages.push(r);
    for (const key of ['total', 'success', 'failed', 'newItems', 'duplicates', 'discovered', 'skippedToday']) {
      out[key] += Number(r[key] || 0);
    }
    Object.assign(out.platformResults, r.platformResults || {});
    out.details.push(...(r.details || []));
    out.stopped ||= !!r.stopped;
    out.tabMode ||= r.tabMode;
    out.maxTabsPerBatch ||= r.maxTabsPerBatch;
  }

  return out;
}

export function classifyPatrolResult(result = {}) {
  if (result.stopped) return 'stopped';
  const failed = Number(result.failed || 0);
  const success = Number(result.success || 0);
  if (failed > 0 && success === 0) return 'failed';
  if (failed > 0) return 'partial';
  return 'success';
}

export function patrolStatusMessage(status) {
  if (status === 'stopped') return '自动巡检已停止。';
  if (status === 'failed') return '自动巡检失败。';
  if (status === 'partial') return '自动巡检部分失败。';
  return '自动巡检完成。';
}

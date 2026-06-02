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

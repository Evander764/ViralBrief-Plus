let activeRun = null;

export class PatrolAlreadyRunningError extends Error {
  constructor(active) {
    super('已有巡检正在运行，请先停止或等待当前巡检结束');
    this.code = 'VBP_PATROL_ACTIVE';
    this.active = active ? { ...active } : null;
  }
}

export function beginPatrolRun(meta = {}) {
  if (activeRun) throw new PatrolAlreadyRunningError(activeRun);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeRun = {
    id,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    ...meta,
  };
  return {
    id,
    shouldStop() {
      return activeRun?.id === id && activeRun.stopRequested === true;
    },
    stopReason() {
      return activeRun?.id === id && activeRun.stopRequested ? '用户已请求停止巡检' : null;
    },
  };
}

export function requestPatrolStop() {
  if (!activeRun) return { ok: true, active: false };
  activeRun.stopRequested = true;
  activeRun.stopRequestedAt = new Date().toISOString();
  return { ok: true, active: true, id: activeRun.id };
}

export function endPatrolRun(id) {
  if (!id || activeRun?.id === id) activeRun = null;
}

export function getPatrolRunState() {
  return activeRun ? { ...activeRun } : null;
}

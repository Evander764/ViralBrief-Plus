/**
 * 自动运行调度器 —— 「接入 API Key 后就能自动产出每日日报」靠它实现。
 * 纯 setTimeout，无外部依赖；进程重启后能补跑当天遗漏。
 */
import { loadConfig, hasApiKey } from './config.js';
import { metaGet, metaSet } from './store.js';
import { runDailyReport } from './pipeline.js';
import { log } from './lib/log.js';

let timer = null;

function msUntil(timeStr) {
  const [h, m] = String(timeStr || '09:00').split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h || 0, m || 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

const today = () => new Date().toISOString().slice(0, 10);

async function runOnce(windowType) {
  if (!hasApiKey()) {
    log.warn('调度触发，但未配置 API Key，跳过本次自动日报。');
    return;
  }
  try {
    await runDailyReport({ windowType });
    metaSet('last_auto_run_date', today());
  } catch (e) {
    log.error('自动日报失败：', e);
  }
}

function arm() {
  if (timer) clearTimeout(timer);
  const cfg = loadConfig();
  if (!cfg.schedule.enabled) return;
  const delay = msUntil(cfg.schedule.time);
  timer = setTimeout(async () => {
    const cfg2 = loadConfig();
    if (cfg2.schedule.enabled && metaGet('last_auto_run_date') !== today()) {
      await runOnce(cfg2.schedule.window);
    }
    arm(); // 排下一天
  }, delay);
  log.info(`已排程：约 ${Math.round(delay / 60000)} 分钟后自动生成日报（${cfg.schedule.time} / ${cfg.schedule.window}）。`);
}

export function startScheduler() {
  const cfg = loadConfig();
  if (!cfg.schedule.enabled) {
    log.info('自动调度未开启（可在「设置」开启）。');
    return;
  }
  // 补跑：今天计划时间已过且尚未运行 → 立即补一次。
  if (cfg.schedule.catchUp) {
    const [h, m] = String(cfg.schedule.time).split(':').map(Number);
    const planned = new Date();
    planned.setHours(h || 0, m || 0, 0, 0);
    if (new Date() > planned && metaGet('last_auto_run_date') !== today() && hasApiKey()) {
      log.info('今天计划时间已过且未运行，立即补跑一次。');
      runOnce(cfg.schedule.window);
    }
  }
  arm();
}

/** 设置变更后调用，立即按新配置重排。 */
export function restartScheduler() {
  arm();
}

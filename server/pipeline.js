/**
 * 每日总结处理管线 —— RPA 驱动的全链路日报生成。
 *
 * 新流程：
 *   1. [RPA 采集] 启动 Chrome → 逐账号跳转主页 → 提取最新内容数据 → 截图 → 入库
 *   2. [状态刷新] recomputeAll（零 token，确定性）
 *   3. [硬筛选]   getEligible（零 token，确定性）
 *   4. [逐条分析] analyzeContent（命中缓存不花钱）
 *   5. [内容归类] generateReportData
 *   6. [渲染输出] Markdown / HTML / CSV → 落库 + 导出文件
 *
 * 关键原则：日报中的所有数字都来自数据库（由 RPA 或插件采集 + 人工确认），
 * AI 只产出定性内容（母题/聚类/标题/建议），绝不采信 AI 编造的数字。
 */
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { windowStartISO, normalizeWindowType, ELIGIBLE_PLATFORMS } from './filter.js';
import {
  recomputeAll, getEligible, getWechatReportItems, getAnalysesForContents, insertReport,
  countsByStatus, getUsageForDay, WECHAT_REPORT_PLATFORMS,
} from './store.js';
import { analyzeContent } from './ai/analyze.js';
import { generateReportData } from './ai/report.js';
import { renderMarkdown, renderHtml, renderCsv, fallbackReportData } from './report/render.js';
import { createZip } from './report/archive.js';
import { hasApiKey, loadConfig } from './config.js';
import { EXPORTS_DIR } from './lib/paths.js';
import { log } from './lib/log.js';
import { CDPClient } from './rpa/cdp.js';
import { runPatrol } from './rpa/patrol.js';
import { launchChrome, killChrome } from './rpa/chrome-launcher.js';

function combinePatrolResults(results = []) {
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
    stages: results,
    stopped: results.some((r) => r?.stopped),
  };
  for (const r of results) {
    if (!r) continue;
    for (const key of ['total', 'success', 'failed', 'newItems', 'duplicates', 'discovered', 'skippedToday']) {
      out[key] += Number(r[key] || 0);
    }
    Object.assign(out.platformResults, r.platformResults || {});
    out.details.push(...(r.details || []));
    out.tabMode ||= r.tabMode;
    out.maxTabsPerBatch ||= r.maxTabsPerBatch;
  }
  return out;
}

async function renderReportFromItems({
  reportType = 'web',
  windowType,
  force,
  items,
  counts,
  reportDate,
  progress,
}) {
  let reportData;
  let model = null;
  let aiUsed = false;

  if (items.length === 0) {
    reportData = fallbackReportData(windowType, counts, { reportType });
    progress('ai', '本期 0 条可生成内容，跳过 AI 调用。');
  } else {
    if (!hasApiKey()) throw new Error('未配置 API Key，无法生成 AI 日报。请先在「设置」里填写。');

    const cfg = loadConfig();
    if (cfg.budgetDailyTokens > 0) {
      const used = getUsageForDay().total;
      if (used >= cfg.budgetDailyTokens) {
        log.warn(`今日 token 用量 ${used} 已达预算 ${cfg.budgetDailyTokens}，仍继续以保证日报完整。`);
      }
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      progress('ai', `分析内容 (${i + 1}/${items.length}): ${it.title || it.id}`);
      try {
        await analyzeContent(it, { force });
      } catch (e) {
        log.warn(`单条分析失败（不影响整体）：${it.id} ${e.message}`);
      }
    }

    const analyses = getAnalysesForContents(items.map((i) => i.id));
    progress('ai', '正在生成内容归类报告...');
    const r = await generateReportData({ windowType, items, analyses, reportType });
    reportData = r.data;
    model = r.model;
    aiUsed = true;
  }

  progress('render', '正在渲染日报...');

  const analyses = getAnalysesForContents(items.map((i) => i.id));
  const meta = { reportType, windowType, reportDate, generatedAt: new Date().toISOString(), counts, model, aiUsed };

  const md = renderMarkdown(reportData, items, analyses, meta);
  const html = renderHtml(reportData, items, analyses, meta);
  const csv = renderCsv(items, analyses);

  const stamp = `${reportDate}_${windowType}`;
  const prefix = reportType === 'wechat' ? 'wechat_report' : 'report';
  const mdPath = join(EXPORTS_DIR, `${prefix}_${stamp}.md`);
  const htmlPath = join(EXPORTS_DIR, `${prefix}_${stamp}.html`);
  const csvPath = join(EXPORTS_DIR, `${prefix}_${stamp}.csv`);
  const zipPath = join(EXPORTS_DIR, `${prefix}_${stamp}.zip`);
  writeFileSync(mdPath, md);
  writeFileSync(htmlPath, html);
  writeFileSync(csvPath, csv);
  writeFileSync(zipPath, createZip([
    { name: basename(mdPath), data: md },
    { name: basename(htmlPath), data: html },
    { name: basename(csvPath), data: csv },
  ]));

  const row = insertReport({
    report_type: reportType,
    report_date: reportDate,
    window_type: windowType,
    eligible_count: items.length,
    report_json: JSON.stringify(reportData),
    report_markdown: md,
    export_md_path: mdPath,
    export_html_path: htmlPath,
    export_csv_path: csvPath,
    export_zip_path: zipPath,
  });

  const statusStr = aiUsed ? `AI=on(${model})` : 'AI=skip';
  const label = reportType === 'wechat' ? '微信日报' : '日报';
  progress('done', `${label}已生成：${windowType}，内容 ${items.length} 条，${statusStr}`);
  log.info(`${label}已生成：${windowType}，内容 ${items.length} 条，${statusStr}`);

  return { report: row, markdown: md, eligibleCount: items.length, aiUsed };
}

/**
 * 生成每日爆款选题日报。
 *
 * @param {object} opts
 * @param {string}  [opts.windowType='last_1_day']  时间窗口
 * @param {boolean} [opts.force=false]               是否强制重新分析（忽略缓存）
 * @param {boolean} [opts.skipRpa=false]              是否跳过 RPA 采集步骤
 * @param {(phase: string, detail: string) => void} [opts.onProgress] 进度回调
 * @returns {Promise<{report, markdown, eligibleCount, aiUsed, patrolResult?}>}
 */
export async function runDailyReport({
  windowType = 'last_1_day',
  force = false,
  skipRpa = false,
  onProgress,
  shouldStop = () => false,
} = {}) {
  const progress = (phase, detail) => {
    log.info(`[Pipeline:${phase}] ${detail}`);
    if (onProgress) onProgress(phase, detail);
  };

  // 统一窗口格式
  windowType = normalizeWindowType(windowType);
  const startISO = windowStartISO(windowType);
  const cfg = loadConfig();

  // ====================================================================
  // 第 1 步：RPA 浏览器采集（可选跳过）
  // ====================================================================
  let patrolResult = null;
  let rpaError = null;

  if (!skipRpa) {
    progress('rpa', '正在启动自动巡检...');
    let chromeChild = null;
    let client = null;

    try {
      // 网页日报只跑小红书/抖音 Chrome CDP；视频号由微信日报入口单独处理。
      const chrome = await launchChrome({ port: 9222, waitMs: 15000 });
      chromeChild = chrome.closeOnDone ? chrome.child : null;

      progress('rpa', '正在连接浏览器...');
      client = new CDPClient();
      await client.connect(chrome.port);

      const stageResults = [];
      for (const platform of ['xiaohongshu', 'douyin']) {
        if (shouldStop()) break;
        const label = platform === 'xiaohongshu' ? '小红书' : '抖音';
        progress('rpa', `开始${label}阶段巡检...`);
        stageResults.push(await runPatrol(client, {
          onProgress: (msg) => progress('rpa', msg),
          windowType,
          windowStartISO: startISO,
          platforms: [platform],
          maxTabsPerBatch: cfg.rpa?.maxTabsPerBatch,
          shouldStop,
          clientFactory: async () => {
            const c = new CDPClient();
            await c.connect(chrome.port);
            return c;
          },
        }));
      }
      patrolResult = combinePatrolResults(stageResults);

      progress('rpa', `采集完成: 新增 ${patrolResult.newItems} 条，去重 ${patrolResult.duplicates} 条`);
    } catch (rpaErr) {
      // RPA 失败不阻断日报生成——可能数据库里已有足够的数据
      rpaError = rpaErr.message || String(rpaErr);
      log.warn(`[Pipeline] RPA 采集失败，继续使用已有数据: ${rpaErr.message}`);
      progress('rpa', `采集失败: ${rpaErr.message}（将使用已有数据继续）`);
    } finally {
      // 一定要清理资源
      if (client) await client.close();
      if (chromeChild) killChrome(chromeChild);
    }
  } else {
    progress('rpa', '已跳过浏览器采集（使用已有数据）');
  }

  // ====================================================================
  // 第 2-3 步：确定性筛选（零 token）
  // ====================================================================
  progress('filter', '刷新数据状态...');
  recomputeAll(startISO);
  const items = getEligible(startISO);
  const counts = countsByStatus({ platforms: ELIGIBLE_PLATFORMS });
  const reportDate = new Date().toISOString().slice(0, 10);

  progress('filter', `达标内容: ${items.length} 条`);

  const result = await renderReportFromItems({
    reportType: 'web',
    windowType,
    force,
    items,
    counts,
    reportDate,
    progress,
  });

  return { ...result, patrolResult, rpaError };
}

export async function runWechatReport({
  windowType = 'last_1_day',
  force = false,
  skipRpa = true,
  onProgress,
  shouldStop = () => false,
  maxVideosPerAccount,
} = {}) {
  const progress = (phase, detail) => {
    log.info(`[Pipeline:wechat:${phase}] ${detail}`);
    if (onProgress) onProgress(phase, detail);
  };

  windowType = normalizeWindowType(windowType);
  const startISO = windowStartISO(windowType);

  // 视频号桌面巡检已移除（准备重做）。微信日报现在只基于已有的、已人工确认的内容生成。
  const patrolResult = null;
  const rpaError = null;
  progress('rpa', '视频号桌面巡检已移除，使用已有数据生成微信日报');

  progress('filter', '刷新微信内容状态...');
  recomputeAll(startISO);
  const items = getWechatReportItems(startISO);
  const counts = countsByStatus({ platforms: WECHAT_REPORT_PLATFORMS });
  const reportDate = new Date().toISOString().slice(0, 10);

  progress('filter', `微信可生成内容: ${items.length} 条`);

  const result = await renderReportFromItems({
    reportType: 'wechat',
    windowType,
    force,
    items,
    counts,
    reportDate,
    progress,
  });

  return { ...result, patrolResult, rpaError };
}

/**
 * 视觉观察模块 —— 对应 PDF §5/§11，仿 analyze.js 模式。
 * 
 * 通过截图 + 视觉模型识别页面状态、观察博主行为。
 * 观察结果按 content_id 缓存（命中不再花钱），与 analyzeContent 缓存策略一致。
 * 
 * 所有视觉推理结果属于「定性软内容」，不用于指标判定。
 * 视觉/OCR 读出的指标以 metrics_source='desktop_agent' 入库 → needs_review。
 */
import { callJSON } from './client.js';
import { log } from '../lib/log.js';
import {
  SYSTEM_PAGE_STATE, buildPageStateUser, validatePageState,
  SYSTEM_OBSERVE, buildObserveUser, validateObservation,
  SYSTEM_READ_METRICS, validateMetricsRead,
} from './prompts.js';
import { getObservation, upsertObservation } from '../store.js';
import { loadConfig } from '../config.js';

/**
 * 识别页面状态：当前页面是什么类型、有无置顶、该点哪里。
 * 不走缓存（每次截图都不同），每次都调视觉模型。
 * @param {string} screenshotB64 - 纯 base64 字符串（不含 data: 前缀）
 * @param {{platform:string, creator:string}} ctx
 * @returns {Promise<{json:object, usage:object}>}
 */
export async function recognizePageState(screenshotB64, { platform, creator } = {}) {
  const user = buildPageStateUser(platform, creator);
  const { json, usage, model } = await callJSON({
    system: SYSTEM_PAGE_STATE,
    user,
    images: [{ data: screenshotB64, media_type: 'image/png' }],
    validate: validatePageState,
    task: 'page_state',
    maxTokens: 1500,
  });
  log.info(`[page_state] type=${json.page_type} action=${json.next_action} conf=${json.confidence}`);
  return { json, usage, model };
}

/**
 * 观察视频详情页：博主在干什么。
 * 按 content_id 缓存，已观察过的内容不重复花钱。
 * @param {string} screenshotB64 - 纯 base64 字符串
 * @param {{content_id?:string, platform?:string, creator?:string, title?:string}} ctx
 * @returns {Promise<{observation:object, cached:boolean}>}
 */
export async function observeVideo(screenshotB64, ctx = {}) {
  // 缓存检查：已有观察结果直接返回
  if (ctx.content_id) {
    const cached = getObservation(ctx.content_id);
    if (cached) {
      log.info(`[observe] 缓存命中 content_id=${ctx.content_id}`);
      return { observation: cached, cached: true };
    }
  }

  const user = buildObserveUser(ctx);
  const { json, usage, model } = await callJSON({
    system: SYSTEM_OBSERVE,
    user,
    images: [{ data: screenshotB64, media_type: 'image/png' }],
    validate: validateObservation,
    task: 'observe',
    maxTokens: 1500,
  });

  // 有 content_id 则缓存
  if (ctx.content_id) {
    const cfg = loadConfig();
    upsertObservation(ctx.content_id, json, model || cfg.model);
  }

  log.info(`[observe] activity="${json.observed_activity}" topic=${json.topic_category} conf=${json.confidence}`);
  return { observation: json, cached: false };
}

/**
 * 从截图读取指标数字（可选辅助）。
 * 返回的 raw 字符串需要经 normalizeMetric 转换，且以 needs_review 处理。
 * @param {string} screenshotB64
 * @returns {Promise<{json:object, usage:object}>}
 */
export async function readMetricsFromScreenshot(screenshotB64) {
  const { json, usage, model } = await callJSON({
    system: SYSTEM_READ_METRICS,
    user: '请从这张截图中读取可见的互动指标数字（点赞、转发、评论、收藏）。',
    images: [{ data: screenshotB64, media_type: 'image/png' }],
    validate: validateMetricsRead,
    task: 'read_metrics',
    maxTokens: 800,
  });
  log.info(`[read_metrics] like=${json.like_raw} share=${json.share_raw}`);
  return { json, usage, model };
}

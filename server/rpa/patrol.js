/**
 * RPA patrol module.
 *
 * Flow:
 * 1. Discover followed creators from the logged-in browser for Xiaohongshu and Douyin.
 * 2. Upsert discovered creators into the local account pool.
 * 3. Visit enabled accounts, open recent posts, extract metrics, and save trusted evidence.
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freemem } from 'node:os';
import { all } from '../db.js';
import {
  upsertCapture,
  upsertAccount,
  contentExistsByUrl,
  markAccountPatrolled,
  beijingDayStartISO,
} from '../store.js';
import { SCREENSHOTS_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { deriveMetricsWithEvidence, parseCount } from '../../extension/extract-core.js';
import { clickRectLikeHuman, executeHumanActions } from './human-actions.js';
import { looksLikeRealProfile, platformSearchUrl } from '../lib/platform-links.js';
import { normalizeWindowType, windowStartISO as computeWindowStartISO } from '../filter.js';

const DEFAULT_PLATFORMS = ['xiaohongshu', 'douyin'];
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_TABS_PER_BATCH = 6;
const MAX_TABS_PER_BATCH = 10;
const MIN_MEMORY_SAFE_TABS = 1;
const MEMORY_PER_RPA_TAB_BYTES = 600 * 1024 * 1024;
const MEMORY_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_XHS_SCAN_CANDIDATES = 120;
const MAX_XHS_SCROLLS = 20;
const MAX_XHS_EMPTY_SCROLLS = 3;
const XHS_ROW_TOLERANCE_PX = 72;

export async function discoverFollowedCreators(client, opts = {}) {
  const platforms = opts.platforms || DEFAULT_PLATFORMS;
  const onProgress = opts.onProgress || (() => {});
  const out = [];

  for (const platform of platforms) {
    try {
      const creators = platform === 'xiaohongshu'
        ? await discoverXiaohongshuCreators(client, onProgress)
        : await discoverDouyinCreators(client, onProgress);
      out.push(...creators);
    } catch (e) {
      onProgress(`${platform} 关注发现失败: ${e.message}`);
      log.warn(`[RPA] ${platform} 关注发现失败: ${e.message}`);
    }
  }

  return out;
}

export async function runPatrol(client, opts = {}) {
  const {
    onProgress,
    platforms = DEFAULT_PLATFORMS,
    discoverFollows = false,
    maxCandidatesPerAccount = DEFAULT_MAX_CANDIDATES,
    clientFactory = null,
    shouldStop = () => false,
    includePatrolledToday = false,
  } = opts;
  const orderedPlatforms = orderPlatforms(platforms);
  const normalizedWindowType = normalizeWindowType(opts.windowType || 'last_1_days');
  const patrolWindowStartISO = opts.windowStartISO || computeWindowStartISO(normalizedWindowType);
  const requestedMaxTabsPerBatch = normalizeMaxTabs(
    opts.maxTabsPerBatch
      ?? opts.maxTabsPerPlatform
      ?? process.env.VBP_RPA_MAX_TABS_PER_BATCH
      ?? process.env.VB_RPA_MAX_TABS_PER_BATCH
      ?? process.env.VBP_RPA_MAX_TABS_PER_PLATFORM
      ?? process.env.VB_RPA_MAX_TABS_PER_PLATFORM
      ?? DEFAULT_MAX_TABS_PER_BATCH,
    DEFAULT_MAX_TABS_PER_BATCH,
  );
  const freeMemoryBytes = Number.isFinite(Number(opts.freeMemoryBytes))
    ? Number(opts.freeMemoryBytes)
    : freemem();
  const maxTabsPerBatch = clientFactory
    ? memorySafeBatchSize(requestedMaxTabsPerBatch, freeMemoryBytes)
    : 1;
  const progress = (msg) => {
    log.info(`[RPA] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  const result = {
    total: 0,
    success: 0,
    failed: 0,
    newItems: 0,
    duplicates: 0,
    discovered: 0,
    platformResults: {},
    details: [],
    tabMode: clientFactory ? 'multi' : 'single',
    maxTabsPerBatch,
    maxTabsPerPlatform: maxTabsPerBatch,
    requestedMaxTabsPerBatch: clientFactory ? requestedMaxTabsPerBatch : 1,
    freeMemoryBytes,
    windowType: normalizedWindowType,
    windowStartISO: patrolWindowStartISO,
    stopped: false,
  };

  progress(`开始自动巡检: ${orderedPlatforms.join(', ')}`);

  if (discoverFollows) {
    const creators = await discoverFollowedCreators(client, { platforms: orderedPlatforms, onProgress: progress });
    for (const creator of creators) {
      upsertAccount({
        platform: creator.platform,
        nickname: creator.name,
        homepage_url: creator.url,
        platform_user_id: creator.platform_user_id,
        category: '自动发现',
        priority: 'B',
        monitor_enabled: 1,
        discovery_source: 'browser_following',
      });
    }
    result.discovered = creators.length;
    progress(`关注发现完成: ${creators.length} 个账号`);
  }

  const placeholders = orderedPlatforms.map(() => '?').join(',');
  const rawAccounts = all(
    `SELECT * FROM accounts WHERE monitor_enabled = 1 AND platform IN (${placeholders})`,
    orderedPlatforms,
  );
  const sortedAccounts = sortPatrolAccounts(rawAccounts);
  const todayStart = beijingDayStartISO();
  const skippedToday = includePatrolledToday ? [] : sortedAccounts.filter((acc) => isPatrolledSince(acc, todayStart));
  const accounts = includePatrolledToday ? sortedAccounts : sortedAccounts.filter((acc) => !isPatrolledSince(acc, todayStart));
  result.total = accounts.length;
  result.skippedToday = skippedToday.length;
  for (const acc of accounts) {
    initPlatformResult(result, acc.platform).total++;
  }

  if (clientFactory) {
    if (maxTabsPerBatch < requestedMaxTabsPerBatch) {
      progress(`启用分平台批量巡检: 目标每批 ${requestedMaxTabsPerBatch} 个账号；可用内存不足，自动降到 ${maxTabsPerBatch} 个`);
    } else {
      progress(`启用分阶段批量巡检: 每批最多同时打开 ${maxTabsPerBatch} 个账号标签页`);
    }
    let primaryAvailable = true;
    let globalStart = 0;
    for (const platform of orderedPlatforms) {
      if (shouldStop()) break;
      const platformAccounts = accounts.filter((acc) => acc.platform === platform);
      if (platformAccounts.length === 0) continue;
      progress(`开始巡检${platformName(platform)}账号: ${platformAccounts.length} 个`);
      for (let localStart = 0; localStart < platformAccounts.length; localStart += maxTabsPerBatch) {
        if (shouldStop()) break;
        const batch = platformAccounts.slice(localStart, localStart + maxTabsPerBatch);
        const outcomes = await patrolMixedBatch(batch, {
          client,
          clientFactory,
          progress,
          startIndex: globalStart + localStart,
          total: accounts.length,
          maxCandidates: maxCandidatesPerAccount,
          windowStartISO: patrolWindowStartISO,
          usePrimary: primaryAvailable,
          shouldStop,
        });
        primaryAvailable = false;
        for (const outcome of outcomes) applyPatrolOutcome(result, outcome);
      }
      globalStart += platformAccounts.length;
    }
  } else {
    let index = 0;
    for (const platform of orderedPlatforms) {
      if (shouldStop()) break;
      const platformAccounts = accounts.filter((acc) => acc.platform === platform);
      if (platformAccounts.length === 0) continue;
      progress(`开始巡检${platformName(platform)}账号: ${platformAccounts.length} 个`);
      for (const acc of platformAccounts) {
        if (shouldStop()) break;
        const outcome = await patrolAccount(client, acc, progress, {
          index,
          total: accounts.length,
          maxCandidates: maxCandidatesPerAccount,
          windowStartISO: patrolWindowStartISO,
          shouldStop,
        });
        applyPatrolOutcome(result, outcome);
        index++;
        await client.sleep(1400 + Math.random() * 1600);
      }
    }
  }

  result.stopped = !!shouldStop();
  progress(`${result.stopped ? '巡检已停止' : '巡检完成'}: 发现 ${result.discovered}, 成功 ${result.success}, 失败 ${result.failed}, 新增 ${result.newItems}, 去重 ${result.duplicates}, 今日已跳过 ${result.skippedToday}`);
  return result;
}

function orderPlatforms(platforms) {
  const requested = Array.isArray(platforms) && platforms.length ? platforms : DEFAULT_PLATFORMS;
  const priority = new Map(DEFAULT_PLATFORMS.map((platform, i) => [platform, i]));
  return [...new Set(requested.filter(Boolean))]
    .sort((a, b) => (priority.get(a) ?? 99) - (priority.get(b) ?? 99));
}

function normalizeMaxTabs(v, fallback = DEFAULT_MAX_TABS_PER_BATCH) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_TABS_PER_BATCH, Math.floor(n)));
}

function memorySafeBatchSize(requested, freeBytes) {
  const requestedTabs = Math.max(1, Number(requested) || DEFAULT_MAX_TABS_PER_BATCH);
  const availableForTabs = Number(freeBytes) - MEMORY_RESERVE_BYTES;
  const memoryTabs = Math.floor(availableForTabs / MEMORY_PER_RPA_TAB_BYTES);
  const safeTabs = Math.max(MIN_MEMORY_SAFE_TABS, memoryTabs);
  return Math.max(1, Math.min(requestedTabs, safeTabs));
}

export function priorityRank(priority) {
  const first = String(priority || 'B').trim().toUpperCase()[0] || 'B';
  const rank = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  return rank[first] ?? 50;
}

function platformRank(platform) {
  if (platform === 'xiaohongshu') return 0;
  if (platform === 'douyin') return 1;
  return 9;
}

export function sortPatrolAccounts(accounts = []) {
  return [...accounts].sort((a, b) => {
    const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDelta) return priorityDelta;
    const platformDelta = platformRank(a.platform) - platformRank(b.platform);
    if (platformDelta) return platformDelta;
    const aCreated = Date.parse(a.created_at || '');
    const bCreated = Date.parse(b.created_at || '');
    const aHasCreated = Number.isFinite(aCreated);
    const bHasCreated = Number.isFinite(bCreated);
    if (aHasCreated && bHasCreated && aCreated !== bCreated) return aCreated - bCreated;
    if (aHasCreated !== bHasCreated) return aHasCreated ? -1 : 1;
    return Math.random() - 0.5;
  });
}

function isPatrolledSince(acc, startISO) {
  const t = Date.parse(acc?.last_patrolled_at || '');
  const start = Date.parse(startISO || '');
  return Number.isFinite(t) && Number.isFinite(start) && t >= start;
}

function platformName(platform) {
  if (platform === 'xiaohongshu') return '小红书';
  if (platform === 'douyin') return '抖音';
  return platform;
}

function initPlatformResult(result, platform) {
  result.platformResults[platform] ||= { total: 0, success: 0, failed: 0, newItems: 0, duplicates: 0 };
  return result.platformResults[platform];
}

function applyPatrolOutcome(result, outcome) {
  const platformResult = initPlatformResult(result, outcome.platform);
  if (outcome.status === 'ok') {
    result.success++;
    platformResult.success++;
    const items = outcome.items || (outcome.item ? [outcome.item] : []);
    for (const item of items) {
      if (item?.duplicate) {
        result.duplicates++;
        platformResult.duplicates++;
      } else if (item) {
        result.newItems++;
        platformResult.newItems++;
      }
    }
  } else if (outcome.status === 'stopped') {
    result.stopped = true;
  } else {
    result.failed++;
    platformResult.failed++;
  }
  result.details.push(outcome);
}

async function patrolMixedBatch(accounts, { client, clientFactory, progress, startIndex, total, maxCandidates, windowStartISO, usePrimary, shouldStop }) {
  const endIndex = startIndex + accounts.length;
  progress(`批次 ${startIndex + 1}-${endIndex}/${total}: 同时打开 ${accounts.length} 个账号主页`);
  if (shouldStop?.()) return accounts.map((acc) => stoppedOutcome(acc));

  const opened = await Promise.allSettled(accounts.map(async (acc, localIndex) => {
    const index = startIndex + localIndex;
    let worker = null;
    try {
      if (shouldStop?.()) return { outcome: stoppedOutcome(acc) };
      worker = usePrimary && localIndex === 0 ? client : await clientFactory();
      const session = await openPatrolSession(worker, acc, progress, { index, total });
      if (session.outcome) {
        await closeWorker(worker, progress, acc);
      }
      return session;
    } catch (e) {
      if (worker) await closeWorker(worker, progress, acc);
      log.warn(`[RPA] 打开主页失败 ${acc.platform}/${acc.nickname || acc.id}: ${e.message}`);
      return { outcome: errorOutcome(acc, e.message) };
    }
  }));

  const sessions = [];
  const outcomes = [];
  for (const item of opened) {
    if (item.status === 'rejected') {
      outcomes.push(errorOutcome(null, item.reason?.message || String(item.reason)));
      continue;
    }
    if (item.value?.outcome) outcomes.push(item.value.outcome);
    else if (item.value) sessions.push(item.value);
  }

  progress(`批次 ${startIndex + 1}-${endIndex}/${total}: 主页打开完成，开始处理 ${sessions.length} 个账号`);
  const processed = await Promise.allSettled(sessions.map(async (session) => {
    try {
      if (shouldStop?.()) return stoppedOutcome(session.acc);
      return await patrolOpenSession(session, progress, { total, maxCandidates, windowStartISO, shouldStop });
    } finally {
      await closeWorker(session.worker, progress, session.acc);
    }
  }));
  for (let i = 0; i < processed.length; i++) {
    const item = processed[i];
    if (item.status === 'fulfilled') outcomes.push(item.value);
    else {
      const session = sessions[i];
      outcomes.push(errorOutcome(session?.acc, item.reason?.message || String(item.reason)));
    }
  }

  progress(`批次 ${startIndex + 1}-${endIndex}/${total}: 标签已全部关闭`);
  return outcomes;
}

async function openPatrolSession(worker, acc, progress, { index, total }) {
  const label = `${acc.platform}/${acc.nickname || acc.homepage_url || acc.id}`;
  const accountProgress = progressForAccount(acc, progress);

  if (!acc.homepage_url && !acc.nickname) {
    return { worker, acc, index, outcome: { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'skipped', error: '缺少主页链接和昵称', item: null, items: [], skipReasons: [] } };
  }

  progress(`(${index + 1}/${total}) 打开标签页巡检 ${label}`);
  const waitMs = acc.platform === 'xiaohongshu' ? 5000 : 4500;
  const homepage = await openAccountHomepage(worker, acc, acc.platform, accountProgress, { waitMs });
  if (!homepage) {
    return { worker, acc, index, outcome: errorOutcome(acc, `未能打开${platformName(acc.platform)}主页`) };
  }
  progress(`(${index + 1}/${total}) ${platformName(acc.platform)}主页标签已打开 ${acc.nickname || acc.homepage_url || acc.id}`);
  return { worker, acc, homepage, index };
}

async function patrolOpenSession(session, progress, { total, maxCandidates, windowStartISO, shouldStop }) {
  const { worker, acc, homepage, index } = session;
  progress(`(${index + 1}/${total}) 处理已打开的${platformName(acc.platform)}主页 ${acc.nickname || homepage || acc.id}`);
  const accountProgress = progressForAccount(acc, progress);
  if (shouldStop?.()) {
    return stoppedOutcome(acc);
  }

  if (acc.platform === 'xiaohongshu') {
    const result = await collectXiaohongshuItems(worker, acc, homepage, accountProgress, { maxCandidates, windowStartISO, shouldStop });
    markAccountPatrolledFromItems(acc.id, result.items);
    return okOutcome(acc, result.items, result.skipReasons);
  }

  const result = await collectDouyinItems(worker, acc, accountProgress, { maxCandidates, windowStartISO, shouldStop });
  const items = result.items || [];
  if (items.length === 0 && result.skipReasons.length === 0) {
    return errorOutcome(acc, '未能提取到新增内容');
  }
  markAccountPatrolledFromItems(acc.id, items);
  return okOutcome(acc, items, result.skipReasons);
}

async function closeWorker(worker, progress, acc) {
  if (!worker || typeof worker.close !== 'function') return;
  try {
    await worker.close();
  } catch (e) {
    const label = acc ? `${acc.platform}/${acc.nickname || acc.id}` : 'unknown';
    log.warn(`[RPA] 关闭标签页失败 ${label}: ${e.message}`);
    progress(`关闭标签页失败 ${label}: ${e.message}`);
  }
}

function okOutcome(acc, items = [], skipReasons = []) {
  return {
    accountId: acc.id,
    nickname: acc.nickname,
    platform: acc.platform,
    status: 'ok',
    item: items[0] || null,
    items,
    skipReasons,
  };
}

function errorOutcome(acc, error) {
  return {
    accountId: acc?.id || null,
    nickname: acc?.nickname || null,
    platform: acc?.platform || 'unknown',
    status: 'error',
    error,
    item: null,
    items: [],
    skipReasons: [],
  };
}

function stoppedOutcome(acc) {
  return {
    accountId: acc?.id || null,
    nickname: acc?.nickname || null,
    platform: acc?.platform || 'unknown',
    status: 'stopped',
    error: '用户已请求停止巡检',
    item: null,
    items: [],
    skipReasons: [],
  };
}

function progressForAccount(acc, progress) {
  const label = `${acc.platform}/${acc.nickname || acc.homepage_url || acc.id}`;
  return (msg) => progress(`[${label}] ${String(msg || '').trimStart()}`);
}

async function patrolAccount(client, acc, progress, { index, total, maxCandidates, windowStartISO, shouldStop }) {
  const label = `${acc.platform}/${acc.nickname || acc.homepage_url || acc.id}`;
  const accountProgress = (msg) => progress(`[${label}] ${String(msg || '').trimStart()}`);

  if (!acc.homepage_url && !acc.nickname) {
    return { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'skipped', error: '缺少主页链接和昵称', item: null };
  }

  progress(`(${index + 1}/${total}) 打开标签页巡检 ${label}`);
  try {
    if (shouldStop?.()) return stoppedOutcome(acc);
    if (acc.platform === 'xiaohongshu') {
      const result = await patrolXiaohongshu(client, acc, accountProgress, { maxCandidates, windowStartISO, shouldStop });
      markAccountPatrolledFromItems(acc.id, result.items);
      return okOutcome(acc, result.items, result.skipReasons);
    }

    const result = await patrolDouyin(client, acc, accountProgress, { maxCandidates, windowStartISO, shouldStop });
    if (!result?.items?.length && !result?.skipReasons?.length) {
      return { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'error', error: '未能提取到新增内容', item: null };
    }

    const items = result.items || [];
    markAccountPatrolledFromItems(acc.id, items);
    return okOutcome(acc, items, result.skipReasons);
  } catch (e) {
    markAccountPatrolled(acc.id);
    log.warn(`[RPA] 巡检 ${label} 失败: ${e.message}`);
    return { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'error', error: e.message, item: null };
  }
}

function markAccountPatrolledFromItems(accountId, items = []) {
  const first = items.find(Boolean);
  if (first) {
    markAccountPatrolled(accountId, { lastSeenUrl: first.url, lastSeenPublishTime: first.publishTime });
  } else {
    markAccountPatrolled(accountId);
  }
}

async function discoverXiaohongshuCreators(client, progress) {
  progress('小红书: 打开个人主页并读取关注列表');
  await client.goto('https://www.xiaohongshu.com/user/profile');
  await client.sleep(4500);
  await assertNotBlocked(client, 'xiaohongshu');
  if (await currentPageUnavailable(client)) {
    progress('小红书: 当前个人主页不可用，跳过关注发现，继续巡检账号池');
    return [];
  }
  await clickTextLikeHuman(client, ['关注']);
  await client.sleep(3000);
  await scrollPage(client, 2);
  const creators = await client.evaluate(followLinksScript('xiaohongshu'));
  progress(`小红书: 发现 ${creators.length} 个关注账号`);
  return creators;
}

async function discoverDouyinCreators(client, progress) {
  progress('抖音: 打开个人主页并读取关注列表');
  await client.goto('https://www.douyin.com/user/self');
  await client.sleep(5000);
  await assertNotBlocked(client, 'douyin');
  await clickTextLikeHuman(client, ['关注']);
  await client.sleep(3500);
  await scrollPage(client, 3);
  const creators = await client.evaluate(followLinksScript('douyin'));
  progress(`抖音: 发现 ${creators.length} 个关注账号`);
  return creators;
}

async function patrolDouyin(client, acc, progress, { maxCandidates, windowStartISO, shouldStop }) {
  const homepage = await openAccountHomepage(client, acc, 'douyin', progress, { waitMs: 4500 });
  if (!homepage) return { items: [], skipReasons: [{ reason: 'homepage_unavailable', detail: '未能打开抖音主页' }] };
  return collectDouyinItems(client, acc, progress, { maxCandidates, windowStartISO, shouldStop });
}

async function collectDouyinItems(client, acc, progress, { maxCandidates, windowStartISO, shouldStop }) {
  const skipReasons = [];
  const postCandidates = await waitForPostCandidates(client, 'douyin');
  if (postCandidates.length === 0) {
    progress('  未找到最新视频链接');
    return { items: [], skipReasons };
  }

  const items = await patrolCandidateUrls(client, acc, 'douyin', postCandidates, progress, {
    maxCandidates,
    waitMs: 4500,
    windowStartISO,
    skipReasons,
    shouldStop,
  });
  return { items, skipReasons };
}

async function patrolXiaohongshu(client, acc, progress, { maxCandidates, windowStartISO, shouldStop }) {
  const homepage = await openAccountHomepage(client, acc, 'xiaohongshu', progress, { waitMs: 5000 });
  if (!homepage) return { items: [], skipReasons: [{ reason: 'homepage_unavailable' }] };
  return collectXiaohongshuItems(client, acc, homepage, progress, { maxCandidates, windowStartISO, shouldStop });
}

async function openAccountHomepage(client, acc, platform, progress, { waitMs }) {
  const direct = cleanProfileUrl(platform, acc.homepage_url);
  if (direct) {
    progress(`  打开${platform === 'douyin' ? '抖音' : '小红书'}主页: ${direct}`);
    await client.goto(direct);
    await client.sleep(waitMs);
    await assertNotBlocked(client, platform);
    if (!(await currentPageUnavailable(client))) return direct;
    progress('  主页链接不可用，改用昵称搜索账号');
  } else if (acc.homepage_url) {
    progress(`  主页链接不像真实账号页，改用昵称搜索: ${acc.homepage_url}`);
  } else {
    progress('  未配置真实主页链接，改用昵称搜索账号');
  }

  return searchAndOpenAccountHomepage(client, acc, platform, progress, { waitMs });
}

async function searchAndOpenAccountHomepage(client, acc, platform, progress, { waitMs }) {
  const nickname = String(acc.nickname || '').trim();
  const searchUrl = platformSearchUrl(platform, nickname);
  if (!searchUrl) return null;

  progress(`  搜索${platform === 'douyin' ? '抖音' : '小红书'}账号: ${nickname}`);
  let usedHomeSearch = false;
  if (platform === 'xiaohongshu') {
    usedHomeSearch = await searchXiaohongshuFromHome(client, nickname, progress);
  }
  if (!usedHomeSearch) {
    await client.goto(searchUrl);
    await client.sleep(platform === 'xiaohongshu' ? 6500 : 7500);
  }
  await assertNotBlocked(client, platform);

  let hit = await findAccountSearchHit(client, platform, nickname);
  if (!hit) {
    await scrollPage(client, 1);
    await client.sleep(1500);
    hit = await findAccountSearchHit(client, platform, nickname);
  }
  if (!hit && usedHomeSearch) {
    progress('  小红书主页搜索未返回匹配账号，改用搜索结果页');
    await client.goto(searchUrl);
    await client.sleep(6500);
    await assertNotBlocked(client, platform);
    hit = await findAccountSearchHit(client, platform, nickname);
  }
  if (!hit?.url) {
    progress('  搜索结果中未找到匹配账号');
    return null;
  }

  progress(`  找到账号主页: ${hit.url}`);
  // 找到真实主页后直接打开该链接。小红书搜索结果点击偶尔会触发前端跳转卡住，
  // 直接导航更稳定，也保留了“先搜索，再进入真实结果”的流程。
  await client.goto(hit.url);
  await client.sleep(waitMs);

  let finalUrl = cleanProfileUrl(platform, await client.currentUrl());
  if (!finalUrl) {
    await client.goto(hit.url);
    await client.sleep(waitMs);
    finalUrl = cleanProfileUrl(platform, await client.currentUrl()) || cleanProfileUrl(platform, hit.url);
  }
  if (finalUrl) {
    upsertAccount({
      id: acc.id,
      platform: acc.platform,
      nickname: acc.nickname,
      homepage_url: finalUrl,
      platform_user_id: creatorIdFromUrl(platform, finalUrl) || acc.platform_user_id,
      category: acc.category,
      priority: acc.priority,
      monitor_enabled: !!acc.monitor_enabled,
      discovery_source: acc.discovery_source || 'search_fallback',
    });
  }
  await assertNotBlocked(client, platform);
  if (!finalUrl || await currentPageUnavailable(client)) {
    progress('  搜索结果主页打开后不可用');
    return null;
  }
  return finalUrl;
}

async function searchXiaohongshuFromHome(client, nickname, progress) {
  if (typeof client.typeText !== 'function' || typeof client.keyPress !== 'function') {
    return false;
  }
  try {
    progress('  打开小红书主页，像人工一样点击搜索框');
    await client.goto('https://www.xiaohongshu.com/explore');
    await client.sleep(4500);
    await assertNotBlocked(client, 'xiaohongshu');

    const rect = await waitForSearchBoxRect(client, 9000);
    if (!rect) {
      progress('  未找到小红书搜索框，改用搜索结果页');
      return false;
    }
    await executeHumanActions(client, [
      { type: 'move', x: rect.x, y: rect.y, duration_ms: 360 },
      { type: 'click', x: rect.x, y: rect.y },
      { type: 'wait', milliseconds: 280 },
    ], { width: rect.width, height: rect.height });
    await client.typeText(nickname, { minDelayMs: 55, maxDelayMs: 130 });
    await client.sleep(350 + Math.random() * 250);
    await client.keyPress('Enter');
    let landed = await waitForUrlPart(client, '/search_result', 5000);
    if (!landed) {
      const searchButton = await findSearchButtonRect(client);
      if (searchButton) {
        progress('  回车未触发搜索，点击小红书搜索按钮');
        await executeHumanActions(client, [
          { type: 'move', x: searchButton.x, y: searchButton.y, duration_ms: 220 },
          { type: 'click', x: searchButton.x, y: searchButton.y },
        ], { width: searchButton.width, height: searchButton.height });
        landed = await waitForUrlPart(client, '/search_result', 6000);
      }
    }
    if (!landed) {
      progress('  小红书主页输入后未进入搜索结果页，改用搜索结果页');
      return false;
    }
    await client.sleep(2500);
    return true;
  } catch (e) {
    progress(`  小红书主页搜索未完成，改用搜索结果页: ${e.message}`);
    return false;
  }
}

async function waitForSearchBoxRect(client, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rect = await findSearchBoxRect(client);
    if (rect) return rect;
    await client.sleep(500);
  }
  return null;
}

async function waitForUrlPart(client, part, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const url = typeof client.currentUrl === 'function'
        ? await client.currentUrl()
        : await client.evaluate('window.location.href');
      if (String(url || '').includes(part)) return true;
    } catch {
      // 页面跳转中偶发拿不到 URL，继续等下一轮。
    }
    await client.sleep(500);
  }
  return false;
}

async function findSearchBoxRect(client) {
  return client.evaluate(`
    (() => {
      // vbp-search-input
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const opacity = Number(style.opacity || 1);
        if (r.width < 40 || r.height < 20 || style.display === 'none' || style.visibility === 'hidden') return null;
        if (opacity <= 0.05 || Number(style.zIndex) < 0 || el.getAttribute('aria-hidden') === 'true' || el.tabIndex < 0) return null;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        return { x: r.left + Math.min(r.width / 2, 280), y: r.top + r.height / 2, width: innerWidth, height: innerHeight };
      };
      const selectors = [
        '#search-input',
        'input[placeholder*="搜索"]',
        'input[type="search"]',
        '[role="searchbox"]',
        '[contenteditable="true"][placeholder*="搜索"]',
        '[class*="search"] input',
        '[class*="search"][contenteditable="true"]',
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = visible(el);
          if (rect) return rect;
        }
      }
      const nodes = Array.from(document.querySelectorAll('input, [contenteditable="true"], [role="searchbox"]'));
      for (const el of nodes) {
        const text = [
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.parentElement?.innerText,
        ].filter(Boolean).join(' ');
        if (!/搜索|search/i.test(text)) continue;
        const rect = visible(el);
        if (rect) return rect;
      }
      return null;
    })()
  `);
}

async function findSearchButtonRect(client) {
  return client.evaluate(`
    (() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const opacity = Number(style.opacity || 1);
        if (r.width < 12 || r.height < 12 || style.display === 'none' || style.visibility === 'hidden') return null;
        if (opacity <= 0.05 || Number(style.zIndex) < 0 || el.getAttribute('aria-hidden') === 'true') return null;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: innerWidth, height: innerHeight };
      };
      const selectors = [
        '.input-button',
        '.search-icon',
        'button[class*="search"]',
        '[aria-label*="搜索"]',
        '[title*="搜索"]',
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = visible(el);
          if (rect) return rect;
        }
      }
      return null;
    })()
  `);
}

async function findAccountSearchHit(client, platform, nickname) {
  return client.evaluate(`
    (() => {
      // vbp-search-result-hit
      const platform = ${JSON.stringify(platform)};
      const nickname = ${JSON.stringify(nickname)};
      const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const toAbs = (href) => {
        try { return new URL(href, location.href).href; } catch { return null; }
      };
      const isProfile = (url) => {
        if (!url) return false;
        try {
          const u = new URL(url);
          if (platform === 'douyin') return /^\\/user\\/(?!self$)[^/?#]+$/i.test(u.pathname.replace(/\\/+$/, ''));
          return /^\\/user\\/profile\\/[^/?#]+$/i.test(u.pathname.replace(/\\/+$/, ''));
        } catch { return false; }
      };
      const visibleRect = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 8 || r.height < 8 || style.display === 'none' || style.visibility === 'hidden') return null;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        return { x: r.left + Math.min(r.width / 2, 180), y: r.top + Math.min(r.height / 2, 60), width: innerWidth, height: innerHeight };
      };
      const candidates = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const url = toAbs(a.getAttribute('href') || a.href);
        if (!isProfile(url)) continue;
        const text = clean(a.innerText || a.textContent || a.getAttribute('title') || a.querySelector('img')?.alt);
        if (!text || text === '我' || !text.includes(nickname)) continue;
        const firstLine = clean(text.split(/\\n/)[0]);
        let score = 0;
        if (firstLine === nickname) score += 100;
        else if (firstLine.includes(nickname)) score += 70;
        if (/小红书号|抖音号|粉丝|获赞|认证/.test(text)) score += 20;
        if (/店铺|旗舰店|好物|知识服务/.test(text)) score -= 35;
        const rect = visibleRect(a);
        if (rect) score += 10;
        candidates.push({ url, text, score, rect });
      }
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      return best ? { url: best.url, text: best.text, score: best.score, ...(best.rect || {}) } : null;
    })()
  `);
}

function cleanProfileUrl(platform, url) {
  if (!looksLikeRealProfile(platform, url)) return '';
  try {
    const u = new URL(String(url).trim());
    const path = u.pathname.replace(/\/+$/, '');
    if (platform === 'douyin') {
      const m = path.match(/^\/user\/(?!self$)([^/?#]+)$/i);
      return m ? `${u.origin}/user/${m[1]}` : '';
    }
    if (platform === 'xiaohongshu') {
      const m = path.match(/^\/user\/profile\/([^/?#]+)$/i);
      return m ? `${u.origin}/user/profile/${m[1]}` : '';
    }
  } catch {
    return '';
  }
  return '';
}

function creatorIdFromUrl(platform, url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const m = platform === 'douyin'
      ? path.match(/^\/user\/(?!self$)([^/?#]+)$/i)
      : path.match(/^\/user\/profile\/([^/?#]+)$/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

async function collectXiaohongshuItems(client, acc, homepage, progress, { maxCandidates = DEFAULT_MAX_CANDIDATES, windowStartISO, shouldStop }) {
  const items = [];
  const skipReasons = [];
  const seenCandidates = new Set();
  const accountState = createAccountVisitState();
  const candidateLimit = normalizeCandidateLimit(maxCandidates);
  let scrolls = 0;
  let emptyScrolls = 0;
  let stop = false;

  progress(`  小红书候选最多检查 ${candidateLimit} 条`);
  while (!stop && seenCandidates.size < candidateLimit && scrolls <= MAX_XHS_SCROLLS) {
    if (shouldStop?.()) break;
    const candidates = await waitForPostCandidates(client, 'xiaohongshu', seenCandidates.size === 0 ? 12000 : 1500);
    const fresh = sortXiaohongshuCandidates(
      candidates.filter((candidate) => candidate?.url && !seenCandidates.has(candidate.url)),
    );

    if (fresh.length === 0) {
      emptyScrolls++;
      if (emptyScrolls >= MAX_XHS_EMPTY_SCROLLS) break;
      await scrollPage(client, 1);
      scrolls++;
      continue;
    }
    emptyScrolls = 0;

    const rows = groupXiaohongshuCandidateRows(fresh);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      for (const candidate of rows[rowIndex]) {
        if (seenCandidates.size >= candidateLimit) break;
        seenCandidates.add(candidate.url);

        const decision = assessXiaohongshuCandidate(candidate, windowStartISO);
        if (decision.action === 'skip') {
          recordSkip(skipReasons, candidate, decision.reason, decision.detail);
          progress(`  跳过候选: ${decision.detail}`);
          continue;
        }
        if (decision.action === 'stop') {
          recordSkip(skipReasons, candidate, decision.reason, decision.detail);
          progress(`  停止继续检查: ${decision.detail}`);
          if (decision.item) items.push(decision.item);
          stop = true;
          break;
        }

        const item = await captureXiaohongshuCandidate(client, acc, homepage, candidate, progress, { windowStartISO, skipReasons, accountState, shouldStop });
        if (item?.stop) {
          if (item.item) items.push(item.item);
          stop = true;
          break;
        }
        if (item?.item) items.push(item.item);

        await restoreXiaohongshuHomepage(client, homepage, progress);
        await client.sleep(900 + Math.random() * 700);
        await assertNotBlocked(client, 'xiaohongshu');
      }

      if (!stop && rowIndex < rows.length - 1) {
        progress('  当前行检查完成，向下滑动查看下一行');
        await scrollXiaohongshuRow(client);
        scrolls++;
      }
      if (stop || seenCandidates.size >= candidateLimit) break;
    }

    if (!stop && seenCandidates.size < candidateLimit) {
      await scrollPage(client, 1);
      scrolls++;
    }
  }

  if (seenCandidates.size === 0) progress('  未找到最新笔记链接');
  else if (!stop) progress(`  小红书候选检查完成: 新增/命中 ${items.length} 条，跳过 ${skipReasons.length} 条`);
  return { items, skipReasons };
}

function normalizeCandidateLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CANDIDATES;
  return Math.max(1, Math.min(MAX_XHS_SCAN_CANDIDATES, Math.floor(n)));
}

function sortXiaohongshuCandidates(candidates) {
  return [...candidates].sort(compareCandidateGridPosition);
}

function compareCandidateGridPosition(a, b) {
  const ar = a?.rect;
  const br = b?.rect;
  if (ar && br) {
    const topDiff = Number(ar.top) - Number(br.top);
    if (Math.abs(topDiff) > XHS_ROW_TOLERANCE_PX) return topDiff;
    const leftDiff = Number(ar.left) - Number(br.left);
    if (leftDiff !== 0) return leftDiff;
    return topDiff;
  }
  if (ar && !br) return -1;
  if (!ar && br) return 1;
  return String(a?.url || '').localeCompare(String(b?.url || ''));
}

function groupXiaohongshuCandidateRows(candidates) {
  const rows = [];
  for (const candidate of sortXiaohongshuCandidates(candidates)) {
    const last = rows[rows.length - 1];
    const rowTop = last?.[0]?.rect?.top;
    const candidateTop = candidate?.rect?.top;
    if (
      last
      && Number.isFinite(Number(rowTop))
      && Number.isFinite(Number(candidateTop))
      && Math.abs(Number(candidateTop) - Number(rowTop)) <= XHS_ROW_TOLERANCE_PX
    ) {
      last.push(candidate);
    } else {
      rows.push([candidate]);
    }
  }
  return rows.map(sortXiaohongshuCandidates);
}

function assessXiaohongshuCandidate(candidate, windowStartISO) {
  if (candidate.isPinned) {
    return { action: 'skip', reason: 'pinned', detail: '置顶内容不算真正最新内容' };
  }

  if (contentExistsByUrl(candidate.url)) {
    return {
      action: 'stop',
      reason: 'already_seen',
      detail: '遇到已采集内容，停止该账号后续检查',
      item: duplicateItem(candidate.url),
    };
  }

  return { action: 'capture', reason: 'inspect_detail', detail: '进入详情页读取发布时间和完整指标' };
}

async function captureXiaohongshuCandidate(client, acc, homepage, candidate, progress, { windowStartISO, skipReasons, accountState, shouldStop }) {
  if (shouldStop?.()) return { stop: true };
  if (accountState?.openedCandidateUrls?.has(candidate.url)) {
    recordSkip(skipReasons, candidate, 'opened_twice', '同一内容在本轮已打开过，停止该博主');
    progress('  发现同一候选被重复打开，停止该博主');
    return { stop: true };
  }
  progress(`  进入候选详情: ${candidate.url}`);
  if (candidate.rect && homepage) {
    const guard = rightwardClickGuard(accountState, candidate);
    if (!guard.ok) {
      recordSkip(skipReasons, candidate, 'not_right_of_previous_click', guard.detail);
      progress(`  跳过候选: ${guard.detail}`);
      return null;
    }
    const opened = await openXiaohongshuCandidateFromHomepage(client, homepage, candidate, progress, { waitMs: 7000 });
    if (opened?.skipped === 'pinned') {
      recordSkip(skipReasons, candidate, 'pinned', '回到主页后识别为置顶内容，跳过点击');
      return null;
    }
    rememberClickPosition(accountState, candidate);
  } else {
    progress('  候选缺少可点击卡片范围，改用详情链接兜底');
    await client.goto(candidate.url);
    await client.sleep(7000);
  }
  accountState?.openedCandidateUrls?.add(candidate.url);

  try {
    await assertNotBlocked(client, 'xiaohongshu');
  } catch (e) {
    recordSkip(skipReasons, candidate, 'blocked', e.message);
    progress(`  候选被登录/验证拦截，跳过: ${e.message}`);
    return null;
  }

  const currentUrl = await safeCurrentUrl(client);
  if (!isDetailUrl('xiaohongshu', currentUrl) || await currentPageUnavailable(client)) {
    recordSkip(skipReasons, candidate, 'not_detail', `候选点击后未停留在详情页: ${currentUrl || candidate.url}`);
    progress(`  候选点击后未停留在详情页，跳过: ${currentUrl || candidate.url}`);
    return null;
  }

  const raw = await extractPageRaw(client, 'xiaohongshu');
  const data = buildCaptureData(raw, 'xiaohongshu');
  const finalUrl = isDetailUrl('xiaohongshu', data.pageUrl) ? data.pageUrl : candidate.url;
  if (accountState?.openedDetailUrls?.has(finalUrl)) {
    recordSkip(skipReasons, candidate, 'opened_twice', '同一详情页在本轮已打开过，停止该博主');
    progress('  发现同一详情页被重复打开，停止该博主');
    return { stop: true };
  }
  accountState?.openedDetailUrls?.add(finalUrl);
  const titleDecision = titleMismatchDecision(candidate, data.title, skipReasons);
  if (titleDecision) {
    recordSkip(skipReasons, candidate, titleDecision.reason, titleDecision.detail);
    progress(`  候选标题与详情不一致，仍按已打开详情入库: ${titleDecision.detail}`);
  }

  const timeGate = assessDetailPublishTime(data, windowStartISO);
  if (timeGate.reason === 'unknown_time') {
    recordSkip(skipReasons, candidate, timeGate.reason, timeGate.detail);
    progress('  详情页未识别到发布时间，先入库等待后续复核');
  }
  if (timeGate.reason === 'out_of_window') {
    recordSkip(skipReasons, candidate, timeGate.reason, timeGate.detail);
    progress(`  详情页发布时间超出窗口，仍先入库，巡检结束后统一筛选: ${timeGate.displayTime}`);
  }
  if (timeGate.action === 'continue') {
    progress(`  详情页发布时间确认在窗口内: ${timeGate.displayTime}`);
  }
  data.publishTime = timeGate.publishTime;

  if (contentExistsByUrl(finalUrl)) {
    const item = duplicateItem(finalUrl, timeGate.publishTime);
    recordSkip(skipReasons, candidate, 'already_seen', '详情页已采集，停止该账号后续检查');
    progress('  详情页已采集，停止该账号后续检查');
    return { stop: true, item };
  }

  if (isUnavailablePage(raw) || !hasCaptureSignal(data)) {
    recordSkip(skipReasons, candidate, 'unavailable', data.title || raw.pageUrl || candidate.url);
    progress(`  候选不可采，跳过: ${data.title || raw.pageUrl || candidate.url}`);
    return null;
  }

  progress(`  抓取到数据: 点赞=${data.like}, 转发=${data.share}, 收藏=${data.favorite}, 标签=${data.hashtags?.length || 0}, 证据=${data.metricsConfidence}`);
  const screenshotPath = await takeScreenshot(client, acc, 'xiaohongshu');
  const item = saveData(acc, finalUrl, data, screenshotPath);
  if (item.duplicate) {
    recordSkip(skipReasons, candidate, 'already_seen', '内容重复，停止该账号后续检查');
    progress('  内容重复，停止该账号后续检查');
    return { stop: true, item };
  }
  return { item };
}

async function restoreXiaohongshuHomepage(client, homepage, progress) {
  const current = await safeCurrentUrl(client);
  if (!isDetailUrl('xiaohongshu', current)) return true;

  progress('  点击左上角关闭按钮返回小红书主页');
  const clicked = await clickXiaohongshuCloseButton(client);
  if (clicked && await waitForXiaohongshuHomepage(client, homepage, 4500)) {
    return true;
  }

  progress('  左上角关闭未回到主页，兜底恢复主页');
  await client.goto(homepage);
  await client.sleep(2200 + Math.random() * 1200);
  return false;
}

async function clickXiaohongshuCloseButton(client) {
  const rect = await client.evaluate(`
    (() => {
      // vbp-xhs-close-button
      const visible = (el) => {
        if (!el || typeof el.getBoundingClientRect !== 'function') return null;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 8 || r.height < 8 || style.display === 'none' || style.visibility === 'hidden') return null;
        if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return null;
        return r;
      };
      const labelOf = (el) => [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.className,
        el.innerText || el.textContent,
      ].filter(Boolean).join(' ');
      const candidates = [];
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, svg, [class*="close"], [class*="back"], [class*="modal"]')).slice(0, 800);
      for (const node of nodes) {
        const target = node.closest('button, [role="button"], a') || node;
        const r = visible(target);
        if (!r) continue;
        const centerX = r.left + r.width / 2;
        const centerY = r.top + r.height / 2;
        if (centerX > 220 || centerY > 180) continue;
        const label = labelOf(target);
        let score = 0;
        if (/关闭|返回|close|back|cancel|退出/i.test(label)) score += 100;
        if (/x|close|back|left/i.test(String(target.className || ''))) score += 25;
        score += Math.max(0, 120 - centerX) + Math.max(0, 90 - centerY);
        candidates.push({ x: centerX, y: centerY, width: innerWidth, height: innerHeight, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0] || null;
    })()
  `);
  if (!rect) return false;
  await executeHumanActions(client, [
    { type: 'move', x: rect.x, y: rect.y, duration_ms: 220 },
    { type: 'click', x: rect.x, y: rect.y, hold_ms: 80 },
    { type: 'wait', milliseconds: 500 },
  ], { width: rect.width, height: rect.height });
  return true;
}

async function waitForXiaohongshuHomepage(client, homepage, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = await safeCurrentUrl(client);
    if (!isDetailUrl('xiaohongshu', url) && (!homepage || sameCleanUrl(url, homepage) || /xiaohongshu\.com\/user\/profile\//.test(String(url || '')))) {
      return true;
    }
    await client.sleep(350);
  }
  return false;
}

function createAccountVisitState() {
  return {
    openedCandidateUrls: new Set(),
    openedDetailUrls: new Set(),
    lastClickX: null,
    lastClickRowTop: null,
  };
}

function candidateClickPoint(candidate) {
  const rect = candidate?.rect;
  if (!rect) return null;
  return {
    x: Number(rect.left) + Number(rect.width) / 2,
    y: Number(rect.top) + Number(rect.height) / 2,
    rowTop: Number(rect.top),
  };
}

function rightwardClickGuard(state, candidate) {
  const point = candidateClickPoint(candidate);
  if (!state || !point) return { ok: true };
  const sameRow = Number.isFinite(state.lastClickRowTop)
    && Math.abs(point.rowTop - state.lastClickRowTop) <= XHS_ROW_TOLERANCE_PX;
  if (sameRow && Number.isFinite(state.lastClickX) && point.x <= state.lastClickX + 4) {
    return {
      ok: false,
      detail: `候选点击位置没有位于上一次点击右侧: ${Math.round(point.x)} <= ${Math.round(state.lastClickX)}`,
    };
  }
  return { ok: true };
}

function rememberClickPosition(state, candidate) {
  const point = candidateClickPoint(candidate);
  if (!state || !point) return;
  state.lastClickX = point.x;
  state.lastClickRowTop = point.rowTop;
}

function normalizedPublishTime(value) {
  if (!value) return null;
  return parseHumanTime(value);
}

function assessDetailPublishTime(data, windowStartISO) {
  const publishTime = normalizedPublishTime(data?.pubTime);
  const displayTime = data?.pubTime || publishTime;
  if (!publishTime) {
    return {
      action: 'record',
      reason: 'unknown_time',
      detail: '详情页未识别到发布时间，先入库等待后续复核',
      publishTime: null,
      displayTime: '',
    };
  }
  if (isBeforeWindow(publishTime, windowStartISO)) {
    return {
      action: 'record',
      reason: 'out_of_window',
      detail: `详情页发布时间超出窗口，先入库等待巡检后筛选: ${displayTime}`,
      publishTime,
      displayTime,
    };
  }
  return {
    action: 'continue',
    reason: 'in_window',
    detail: `详情页发布时间在窗口内: ${displayTime}`,
    publishTime,
    displayTime,
  };
}

function isBeforeWindow(publishTime, windowStartISO) {
  if (!publishTime || !windowStartISO) return false;
  const pub = new Date(publishTime).getTime();
  const start = new Date(windowStartISO).getTime();
  return Number.isFinite(pub) && Number.isFinite(start) && pub < start;
}

function recordSkip(skipReasons, candidate, reason, detail) {
  skipReasons.push({
    url: candidate?.url || null,
    reason,
    detail,
    title: candidateTitle(candidate, { fallbackCardText: true }),
    cardText: typeof candidate?.cardText === 'string' ? candidate.cardText.slice(0, 300) : '',
  });
}

function candidateTitle(candidate, { fallbackCardText = false } = {}) {
  const title = candidate?.title ?? candidate?.titleRaw ?? candidate?.title_raw;
  if (typeof title === 'string' && title.trim()) return title.trim().slice(0, 180);
  if (fallbackCardText && typeof candidate?.cardText === 'string') {
    return candidate.cardText.replace(/\s+/g, ' ').trim().slice(0, 180);
  }
  return '';
}

function normalizeTitleForCompare(value) {
  return String(value || '')
    .replace(/[-_—|].*(小红书|抖音).*/i, '')
    .replace(/(小红书|抖音|置顶|Pinned)/ig, '')
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function titlesLikelyMatch(a, b) {
  const left = normalizeTitleForCompare(a);
  const right = normalizeTitleForCompare(b);
  if (!left || !right) return true;
  if (left.length < 4 || right.length < 4) return true;
  return left.includes(right) || right.includes(left);
}

function pinnedTitleMatches(pinnedTitle, detailTitle) {
  const pinned = normalizeTitleForCompare(pinnedTitle);
  const detail = normalizeTitleForCompare(detailTitle);
  if (!pinned || !detail || pinned.length < 6 || detail.length < 6) return false;
  return pinned === detail || pinned.includes(detail) || detail.includes(pinned);
}

function titleMismatchDecision(candidate, detailTitle, skipReasons = []) {
  const detail = String(detailTitle || '').trim();
  if (!detail) return null;

  for (const skip of skipReasons) {
    if (skip?.reason !== 'pinned' || !skip.title) continue;
    if (pinnedTitleMatches(skip.title, detail)) {
      return {
        reason: 'title_mismatch',
        detail: `详情标题命中已跳过置顶标题: ${detail}`,
      };
    }
  }

  const title = candidateTitle(candidate);
  if (title && !titlesLikelyMatch(title, detail)) {
    return {
      reason: 'title_mismatch',
      detail: `卡片标题和详情标题不一致: ${title} / ${detail}`,
    };
  }
  return null;
}

function duplicateItem(url, publishTime = null) {
  return {
    url,
    title: '候选内容已采集',
    duplicate: true,
    dataStatus: 'already_seen',
    publishTime,
    screenshotPath: null,
  };
}

async function patrolCandidateUrls(client, acc, platform, postCandidates, progress, {
  maxCandidates,
  waitMs,
  homepage = null,
  windowStartISO = null,
  skipReasons = [],
  shouldStop = () => false,
}) {
  progress(`  找到 ${postCandidates.length} 个候选内容，最多检查 ${maxCandidates} 条`);
  const items = [];
  const openedThisAccount = new Set();
  let duplicateUrl = null;
  let duplicateItemResult = null;
  for (let i = 0; i < Math.min(postCandidates.length, maxCandidates); i++) {
    if (shouldStop?.()) break;
    const candidate = normalizePostCandidate(postCandidates[i]);
    const postUrl = candidate?.url;
    if (!postUrl) continue;
    if (candidate.isPinned) {
      recordSkip(skipReasons, candidate, 'pinned', '置顶内容不算真正最新内容');
      progress(`  候选 ${i + 1} 是置顶内容，跳过`);
      continue;
    }
    if (openedThisAccount.has(postUrl)) {
      recordSkip(skipReasons, candidate, 'opened_twice', '同一内容在本轮已打开过，停止该博主');
      progress(`  候选 ${i + 1} 在本轮已打开过，停止该账号后续检查`);
      break;
    }
    if (contentExistsByUrl(postUrl)) {
      progress(`  候选 ${i + 1} 已采集，跳过`);
      duplicateUrl ||= postUrl;
      continue;
    }

    progress(`  进入候选 ${i + 1}: ${postUrl}`);
    if (platform === 'xiaohongshu' && candidate.rect && homepage) {
      const opened = await openXiaohongshuCandidateFromHomepage(client, homepage, candidate, progress, { waitMs });
      if (opened?.skipped === 'pinned') continue;
    } else {
      if (platform === 'xiaohongshu') progress('  候选缺少可点击卡片范围，改用详情链接兜底');
      await client.goto(postUrl);
      if (platform === 'douyin') {
        await client.sleep(300);
        await pauseDouyinVideo(client, progress);
        await client.sleep(Math.max(0, waitMs - 300));
      } else {
        await client.sleep(waitMs);
      }
    }
    openedThisAccount.add(postUrl);
    try {
      await assertNotBlocked(client, platform);
    } catch (e) {
      if (platform === 'xiaohongshu') {
        progress(`  候选被登录/验证拦截，跳过: ${e.message}`);
        continue;
      }
      throw e;
    }

    if (platform === 'xiaohongshu') {
      const currentUrl = await safeCurrentUrl(client);
      if (!isDetailUrl(platform, currentUrl) || await currentPageUnavailable(client)) {
        progress(`  候选点击后未停留在详情页，跳过: ${currentUrl || postUrl}`);
        continue;
      }
    }

    const raw = await extractPageRaw(client, platform);
    const data = buildCaptureData(raw, platform);
    const finalUrl = isDetailUrl(platform, data.pageUrl) ? data.pageUrl : postUrl;
    if (openedThisAccount.has(finalUrl) && finalUrl !== postUrl) {
      recordSkip(skipReasons, candidate, 'opened_twice', '同一详情页在本轮已打开过，停止该博主');
      progress('  发现同一详情页被重复打开，停止该账号后续检查');
      break;
    }
    openedThisAccount.add(finalUrl);
    const titleDecision = titleMismatchDecision(candidate, data.title, skipReasons);
    if (titleDecision) {
      recordSkip(skipReasons, candidate, titleDecision.reason, titleDecision.detail);
      progress(`  候选标题与详情不一致，仍按已打开详情入库: ${titleDecision.detail}`);
    }

    const timeGate = assessDetailPublishTime(data, windowStartISO);
    if (timeGate.reason === 'unknown_time') {
      recordSkip(skipReasons, candidate, timeGate.reason, timeGate.detail);
      progress('  详情页未识别到发布时间，先入库等待后续复核');
    }
    if (timeGate.reason === 'out_of_window') {
      recordSkip(skipReasons, candidate, timeGate.reason, timeGate.detail);
      progress(`  详情页发布时间超出窗口，仍先入库，巡检结束后统一筛选: ${timeGate.displayTime}`);
    }
    if (timeGate.action === 'continue') {
      progress(`  详情页发布时间确认在窗口内: ${timeGate.displayTime}`);
    }
    data.publishTime = timeGate.publishTime;

    if (contentExistsByUrl(finalUrl)) {
      progress('  详情页已采集，跳过');
      duplicateUrl ||= finalUrl;
      duplicateItemResult ||= duplicateItem(finalUrl, timeGate.publishTime);
      continue;
    }
    if (isUnavailablePage(raw) || !hasCaptureSignal(data)) {
      progress(`  候选不可采，跳过: ${data.title || raw.pageUrl || postUrl}`);
      continue;
    }

    progress(`  抓取到数据: 点赞=${data.like}, 转发=${data.share}, 收藏=${data.favorite}, 标签=${data.hashtags?.length || 0}, 证据=${data.metricsConfidence}`);
    const screenshotPath = await takeScreenshot(client, acc, platform);
    const item = saveData(acc, finalUrl, data, screenshotPath);
    if (item.duplicate) {
      progress('  内容重复，继续检查下一条');
      duplicateUrl ||= item.url;
      continue;
    }
    items.push(item);
  }

  if (items.length) return items;
  progress('  候选内容均已采集或不可采');
  if (duplicateItemResult) return [duplicateItemResult];
  if (duplicateUrl) return [duplicateItem(duplicateUrl)];
  return [];
}

async function pauseDouyinVideo(client, progress) {
  try {
    const state = await client.evaluate(`
      (() => {
        // vbp-douyin-pause-video
        const videos = Array.from(document.querySelectorAll('video'));
        let paused = 0;
        for (const video of videos) {
          try {
            video.pause();
            video.muted = true;
            if (video.paused) paused++;
          } catch {}
        }
        return { videoCount: videos.length, pausedCount: paused };
      })()
    `);
    if (state?.videoCount) {
      progress(`  已暂停抖音视频播放: ${state.pausedCount}/${state.videoCount}`);
    }
  } catch (e) {
    progress(`  抖音视频暂停失败，继续提取: ${e.message}`);
  }
}

async function openXiaohongshuCandidateFromHomepage(client, homepage, candidate, progress, { waitMs }) {
  const current = await safeCurrentUrl(client);
  if (!sameCleanUrl(current, homepage)) {
    await client.goto(homepage);
    await client.sleep(2200 + Math.random() * 1200);
  }

  const fresh = await findPostCandidateByUrl(client, 'xiaohongshu', candidate.url);
  if (fresh?.isPinned) {
    progress('  回到主页后识别为置顶内容，跳过点击');
    return { skipped: 'pinned' };
  }
  const clickTarget = fresh?.rect ? fresh : candidate;
  if (!clickTarget.rect) {
    progress('  候选回到主页后未找到卡片范围，改用详情链接兜底');
    await client.goto(candidate.url);
    await client.sleep(waitMs);
    return { opened: true };
  }

  progress('  从主页卡片内随机位置长按点击进入');
  await clickRectLikeHuman(client, clickTarget.rect, {
    viewport: clickTarget.viewport || { width: 1600, height: 1200 },
    minMoveMs: 260,
    maxMoveMs: 520,
    minHoldMs: 140,
    maxHoldMs: 340,
  });

  const landed = await waitForDetailUrl(client, 'xiaohongshu', waitMs);
  if (!landed) {
    await client.sleep(900 + Math.random() * 800);
  } else {
    await client.sleep(1600 + Math.random() * 1200);
  }
  return { opened: true };
}

async function waitForDetailUrl(client, platform, timeoutMs = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = await safeCurrentUrl(client);
    if (isDetailUrl(platform, url)) return true;
    if (platform === 'xiaohongshu' && /xiaohongshu\.com\/explore\/?$/.test(String(url || ''))) return false;
    await client.sleep(350);
  }
  return false;
}

async function safeCurrentUrl(client) {
  try {
    if (typeof client.currentUrl === 'function') return await client.currentUrl();
    return await client.evaluate('window.location.href');
  } catch {
    return '';
  }
}

function sameCleanUrl(a, b) {
  try {
    const ua = new URL(String(a || ''));
    const ub = new URL(String(b || ''));
    return ua.origin === ub.origin && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

function followLinksScript(platform) {
  return `
    (() => {
      const platform = ${JSON.stringify(platform)};
      const toAbs = (href) => {
        try { return new URL(href, location.href).href; } catch { return null; }
      };
      const cleanName = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
      const creatorId = (url) => {
        try {
          const u = new URL(url);
          const m = platform === 'douyin'
            ? u.pathname.match(/\\/user\\/([^/?#]+)/)
            : u.pathname.match(/\\/user\\/profile\\/([^/?#]+)/);
          return m ? decodeURIComponent(m[1]) : null;
        } catch { return null; }
      };
      const isCreator = (url) => {
        if (!url) return false;
        try {
          const u = new URL(url);
          if (platform === 'douyin') return /\\/user\\/[^/?#]+/.test(u.pathname);
          return /\\/user\\/profile\\/[^/?#]+/.test(u.pathname);
        } catch { return false; }
      };
      const seen = new Set();
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const url = toAbs(a.getAttribute('href') || a.href);
        if (!isCreator(url) || seen.has(url) || url === location.href) continue;
        const name = cleanName(a.innerText || a.textContent || a.getAttribute('title') || a.querySelector('img')?.alt);
        if (!name || name.includes('关注') || name.length > 80) continue;
        seen.add(url);
        out.push({ platform, name, url, platform_user_id: creatorId(url) });
      }
      return out;
    })()
  `;
}

function postLinksScript(platform, targetUrl = null) {
  return `
    (() => {
      // vbp-post-candidates
      const platform = ${JSON.stringify(platform)};
      const targetUrl = ${JSON.stringify(targetUrl)};
      const toAbs = (href) => {
        try { return new URL(href, location.href).href; } catch { return null; }
      };
      const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const parseCount = (raw) => {
        if (raw === null || raw === undefined) return null;
        if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
        let s = String(raw).trim();
        if (!s) return null;
        s = s.replace(/[０-９．＋，]/g, (c) => '0123456789.+,'['０１２３４５６７８９．＋，'.indexOf(c)] || c);
        const m = s.match(/(\\d[\\d,]*\\.?\\d*)\\s*([kKwWmM千万亿]?)/);
        if (!m) return null;
        const num = parseFloat(m[1].replace(/,/g, ''));
        if (!Number.isFinite(num)) return null;
        const unit = { k: 1e3, K: 1e3, 千: 1e3, w: 1e4, W: 1e4, 万: 1e4, m: 1e6, M: 1e6, 亿: 1e8 }[m[2]] || 1;
        return Math.round(num * unit);
      };
      const parseHumanTime = (raw) => {
        const str = clean(raw);
        if (!str) return null;
        const now = new Date();
        if (str.includes('刚刚')) return now.toISOString();
        const min = str.match(/(\\d+)\\s*分钟前/);
        if (min) return new Date(now.getTime() - Number(min[1]) * 60000).toISOString();
        const hour = str.match(/(\\d+)\\s*小时前/);
        if (hour) return new Date(now.getTime() - Number(hour[1]) * 3600000).toISOString();
        const day = str.match(/(\\d+)\\s*天前/);
        if (day) return new Date(now.getTime() - Number(day[1]) * 86400000).toISOString();
        if (str.includes('昨天')) return new Date(now.getTime() - 86400000).toISOString();
        if (/^\\d{1,2}-\\d{1,2}$/.test(str)) return new Date(\`\${now.getFullYear()}-\${str}\`).toISOString();
        const d = new Date(str);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      };
      const firstTimeText = (text) => clean(text).match(/刚刚|\\d+\\s*(?:分钟前|小时前|天前)|昨天|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}/)?.[0] || null;
      const detailKey = (href) => {
        try {
          const u = new URL(href, location.href);
          u.hash = '';
          if (platform === 'xiaohongshu') return u.origin + u.pathname.replace(/\\/+$/, '');
          return u.href;
        } catch {
          return null;
        }
      };
      const targetKey = targetUrl ? detailKey(targetUrl) : null;
      const visibleRect = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width <= 4 || rect.height <= 4 || style.display === 'none' || style.visibility === 'hidden') return null;
        if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return null;
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right);
        const bottom = Math.min(innerHeight, rect.bottom);
        const width = right - left;
        const height = bottom - top;
        if (width <= 4 || height <= 4) return null;
        return { left, top, width, height };
      };
      const isDetail = (url) => {
        if (!url) return false;
        try {
          const u = new URL(url);
          if (platform === 'douyin') return /\\/video\\/[^/?#]+/.test(u.pathname);
          if (platform === 'xiaohongshu') return /\\/explore\\/[^/?#]+/.test(u.pathname) || /\\/discovery\\/item\\/[^/?#]+/.test(u.pathname);
        } catch {}
        return false;
      };
      const findCardRect = (link) => {
        const rects = [];
        for (let el = link; el && el !== document.body; el = el.parentElement) {
          const rect = visibleRect(el);
          if (!rect) continue;
          if (rect.width > innerWidth * 0.92 || rect.height > innerHeight * 0.95) continue;
          const name = [el.tagName, el.id, String(el.className || '')].join(' ');
          const likelyCard = el === link
            || /note|feed|card|cover|item|waterfall|media|video|post|aweme|douyin|作品|瀑布/i.test(name)
            || ['ARTICLE', 'LI', 'SECTION'].includes(el.tagName);
          if (likelyCard) rects.push(rect);
        }
        return rects.find((r) => r.width >= 80 && r.height >= 80) || rects[0] || visibleRect(link);
      };
      const findCardElement = (link) => (
        link.closest('article, li, section, [class*="note"], [class*="feed"], [class*="card"], [class*="item"], [class*="cover"], [class*="video"], [class*="post"], [class*="aweme"], [data-e2e*="video"]')
        || link
      );
      const parseColor = (value) => {
        const s = String(value || '').trim();
        let m = s.match(/rgba?\\(\\s*(\\d+(?:\\.\\d+)?)\\s*,\\s*(\\d+(?:\\.\\d+)?)\\s*,\\s*(\\d+(?:\\.\\d+)?)/i);
        if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
        m = s.match(/#([0-9a-f]{6})\\b/i);
        if (m) {
          const hex = m[1];
          return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
          };
        }
        m = s.match(/#([0-9a-f]{3})\\b/i);
        if (m) {
          const hex = m[1].split('').map((c) => c + c).join('');
          return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
          };
        }
        return null;
      };
      const isRed = (color) => color && color.r >= 150 && color.r > color.g * 1.25 && color.r > color.b * 1.15;
      const isYellow = (color) => color && color.r >= 150 && color.g >= 110 && color.b <= 150 && color.r >= color.g * 0.75;
      const platformPinColor = (el) => {
        const values = [];
        for (let cur = el, depth = 0; cur && cur !== document.body && depth < 3; cur = cur.parentElement, depth++) {
          const style = getComputedStyle(cur);
          values.push(style.color, style.backgroundColor, style.borderColor, style.borderTopColor, cur.getAttribute('style') || '');
        }
        return values.some((value) => {
          const color = parseColor(value);
          if (platform === 'xiaohongshu') return isRed(color) || /red|#ff2442|#fe2c55/i.test(String(value || ''));
          if (platform === 'douyin') return isYellow(color) || /yellow|gold|#face15|#ffd|#ffc|#ffcc/i.test(String(value || ''));
          return false;
        });
      };
      const inCardTopLeft = (badgeRect, cardRect) => {
        if (!badgeRect || !cardRect) return false;
        const centerX = badgeRect.left + badgeRect.width / 2;
        const centerY = badgeRect.top + badgeRect.height / 2;
        const leftLimit = cardRect.left + cardRect.width * 0.45;
        const topLimit = cardRect.top + Math.max(54, cardRect.height * 0.32);
        return centerX <= leftLimit && centerY <= topLimit;
      };
      const pinBadgeText = (el) => clean([
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('alt'),
        el.innerText || el.textContent,
      ].filter(Boolean).join(' '));
      const isPinnedContent = (card, cardRect) => {
        const baseRect = cardRect || visibleRect(card);
        if (!card || !baseRect) return false;
        const nodes = [card, ...card.querySelectorAll('*')].slice(0, 500);
        for (const node of nodes) {
          const text = pinBadgeText(node);
          if (!/(置顶|Pinned)/i.test(text)) continue;
          const badgeRect = visibleRect(node);
          if (!inCardTopLeft(badgeRect, baseRect)) continue;
          if (platformPinColor(node) || text.length <= 24) return true;
        }
        return false;
      };
      const findLikeRaw = (card) => {
        if (!card) return null;
        const selectors = [
          '[aria-label*="点赞"]',
          '[aria-label*="赞"]',
          '[title*="点赞"]',
          '[title*="赞"]',
          '[class*="like"] [class*="count"]',
          '[class*="like"]',
          '[class*="liked"]',
          '[class*="赞"]',
        ];
        for (const selector of selectors) {
          for (const el of card.querySelectorAll(selector)) {
            const text = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText || el.textContent].filter(Boolean).join(' '));
            const m = text.match(/(?:点赞|赞|like)?\\s*[:：]?\\s*([\\d.,]+\\s*[万千wkWK]?\\+?)/i)
              || text.match(/([\\d.,]+\\s*[万千wkWK]?\\+?)\\s*(?:点赞|赞|like)/i);
            if (m) return m[1];
          }
        }
        return null;
      };
      const findPublishRaw = (card) => {
        if (!card) return null;
        for (const el of card.querySelectorAll('time, [datetime], [class*="time"], [class*="date"]')) {
          const text = clean([el.getAttribute('datetime'), el.getAttribute('title'), el.innerText || el.textContent].filter(Boolean).join(' '));
          const hit = firstTimeText(text);
          if (hit) return hit;
        }
        return firstTimeText(card.innerText || card.textContent || '');
      };
      const findTitleRaw = (card, link, cardText) => {
        const candidates = [
          link.getAttribute('title'),
          link.getAttribute('aria-label'),
          link.querySelector('img')?.alt,
          card?.querySelector('[class*="title"], [class*="desc"], [class*="caption"]')?.innerText,
          card?.querySelector('[title]')?.getAttribute('title'),
        ].map(clean).filter(Boolean);
        const fromAttr = candidates.find((text) => text && !/(置顶|点赞|收藏|评论|转发|分享)/.test(text));
        if (fromAttr) return fromAttr.slice(0, 180);
        return clean(cardText)
          .replace(/置顶|Pinned/ig, ' ')
          .replace(/\\d[\\d,.]*\\s*[万千wkWKmM]?\\+?\\s*(?:点赞|赞|收藏|评论|转发|分享)?/g, ' ')
          .replace(/刚刚|\\d+\\s*(?:分钟前|小时前|天前)|昨天|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, 180);
      };
      const out = [];
      const seen = new Set();
      const push = (link, allowWithoutRect = false) => {
        const href = toAbs(link.getAttribute('href') || link.href);
        if (!isDetail(href)) return;
        const key = detailKey(href);
        if (!key || seen.has(key)) return;
        if (targetKey && key !== targetKey) return;
        const rect = findCardRect(link);
        const card = findCardElement(link);
        const cardText = clean(card?.innerText || card?.textContent || link.innerText || link.textContent || '').slice(0, 800);
        const isPinned = isPinnedContent(card, rect || visibleRect(card) || visibleRect(link));
        const titleRaw = findTitleRaw(card, link, cardText);
        const pinRaw = isPinned ? '置顶' : null;
        if (platform === 'xiaohongshu') {
          if (!rect && !allowWithoutRect) return;
          const likeRaw = findLikeRaw(card);
          const publishRaw = findPublishRaw(card);
          seen.add(key);
          out.push({
            url: href,
            rect,
            viewport: { width: innerWidth, height: innerHeight },
            isPinned,
            pinRaw,
            titleRaw,
            title: titleRaw,
            likeRaw,
            likeCount: parseCount(likeRaw),
            publishRaw,
            publishTime: parseHumanTime(publishRaw),
            cardText,
          });
          return;
        }
        seen.add(key);
        out.push({
          url: href,
          rect,
          viewport: rect ? { width: innerWidth, height: innerHeight } : null,
          isPinned,
          pinRaw,
          titleRaw,
          title: titleRaw,
          publishRaw: findPublishRaw(card),
          publishTime: parseHumanTime(findPublishRaw(card)),
          cardText,
        });
      };
      const links = [...document.querySelectorAll('a[href]')];
      for (const a of links) {
        if (visibleRect(a)) push(a, false);
      }
      for (const a of links) {
        push(a, true);
      }
      return out;
    })()
  `;
}

async function waitForPostCandidates(client, platform, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const candidates = normalizePostCandidates(await client.evaluate(postLinksScript(platform)));
    if (candidates.length > 0) return candidates;
    await client.sleep(700);
  }
  return [];
}

async function findPostCandidateByUrl(client, platform, url) {
  const candidates = normalizePostCandidates(await client.evaluate(postLinksScript(platform, url)));
  return candidates[0] || null;
}

function normalizePostCandidates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const candidate = normalizePostCandidate(item);
    if (!candidate?.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    out.push(candidate);
  }
  return out;
}

function normalizePostCandidate(item) {
  if (typeof item === 'string') return { url: item, rect: null, viewport: null };
  if (!item || typeof item !== 'object') return null;
  const url = typeof item.url === 'string' ? item.url : '';
  const likeRaw = item.likeRaw ?? item.like_raw ?? null;
  const likeCount = item.likeCount ?? item.like_count ?? parseCount(likeRaw);
  const publishRaw = item.publishRaw ?? item.publish_raw ?? null;
  const publishTime = item.publishTime ?? item.publish_time ?? normalizedPublishTime(publishRaw);
  const numericLike = likeCount === null || likeCount === undefined || likeCount === '' ? null : Number(likeCount);
  const titleRaw = item.titleRaw ?? item.title_raw ?? item.title ?? '';
  const pinRaw = item.pinRaw ?? item.pin_raw ?? null;
  return {
    url,
    rect: normalizeRect(item.rect),
    viewport: normalizeViewport(item.viewport),
    isPinned: item.isPinned === true || item.is_pinned === true,
    pinRaw,
    titleRaw: typeof titleRaw === 'string' ? titleRaw : '',
    title: typeof item.title === 'string' ? item.title : (typeof titleRaw === 'string' ? titleRaw : ''),
    likeRaw,
    likeCount: Number.isFinite(numericLike) ? numericLike : null,
    publishRaw,
    publishTime: normalizedPublishTime(publishTime),
    cardText: typeof item.cardText === 'string' ? item.cardText : '',
  };
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const left = Number(rect.left ?? rect.x);
  const top = Number(rect.top ?? rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![left, top, width, height].every(Number.isFinite) || width <= 4 || height <= 4) return null;
  return { left, top, width, height };
}

function normalizeViewport(viewport) {
  if (!viewport || typeof viewport !== 'object') return null;
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

async function assertNotBlocked(client, platform) {
  const state = await client.evaluate(`
    (() => ({
      title: document.title || '',
      url: location.href,
      text: (document.body && document.body.innerText || '').slice(0, 1200),
    }))()
  `);
  const haystack = `${state.title}\n${state.url}\n${state.text}`;
  if (/验证码|安全验证|滑动验证|captcha|verify|登录后查看|请先登录|登录后/.test(haystack)) {
    throw new Error(`${platform === 'douyin' ? '抖音' : '小红书'}页面被登录/验证码/安全验证拦截，请在 Chrome 中完成登录后重试`);
  }
}

async function currentPageUnavailable(client) {
  const raw = await client.evaluate(`
    (() => ({
      title: document.title || '',
      pageUrl: location.href,
      textSample: (document.body && document.body.innerText || '').slice(0, 2000),
    }))()
  `);
  return isUnavailablePage(raw);
}

async function extractPageRaw(client, platform) {
  return client.evaluate(`
    (() => {
      const platform = ${JSON.stringify(platform)};
      const textOf = (el) => {
        if (!el) return null;
        return (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim() || null;
      };
      const getText = (selectors) => {
        for (const s of selectors) {
          const el = document.querySelector(s);
          const text = textOf(el);
          if (text) return text;
        }
        return null;
      };
      const meta = (name) => document.querySelector(\`meta[property="\${name}"], meta[name="\${name}"]\`)?.content || '';
      const cleanBlock = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
      const firstAttr = (selectors, attr) => {
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            const value = el.getAttribute(attr);
            if (value) {
              try { return new URL(value, location.href).href; } catch { return value; }
            }
          }
        }
        return null;
      };
      const readableVideoDuration = () => {
        const v = document.querySelector('video');
        if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return null;
        const total = Math.round(v.duration);
        const mm = Math.floor(total / 60);
        const ss = String(total % 60).padStart(2, '0');
        return \`\${mm}:\${ss}\`;
      };
      const collectText = (selectors) => {
        const out = [];
        const seen = new Set();
        for (const selector of selectors) {
          for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 8)) {
            const text = cleanBlock(textOf(el));
            if (!text || text.length < 2 || seen.has(text)) continue;
            seen.add(text);
            out.push(text);
          }
        }
        return out.join('\\n').slice(0, 3000);
      };
      const extractHashtags = (text) => {
        const found = [];
        const seen = new Set();
        const re = /#[^#\\s，。！？、,.!?;；:：)）(（\\[\\]【】]+/g;
        for (const match of String(text || '').matchAll(re)) {
          const tag = match[0].trim();
          const key = tag.toLowerCase();
          if (tag.length < 2 || seen.has(key)) continue;
          seen.add(key);
          found.push(tag);
        }
        return found.slice(0, 24);
      };
      const scripts = [...document.querySelectorAll('script:not([src]), script[type="application/json"]')]
        .map((s) => s.textContent || '')
        .filter((s) => /(digg|share|comment|collect|liked|interact|aweme|note|favorite)/i.test(s))
        .slice(0, 16)
        .map((s) => s.slice(0, 250000));
      for (const key of ['__INITIAL_STATE__', '__NUXT__', '__NEXT_DATA__', 'SIGI_STATE', 'RENDER_DATA']) {
        try {
          const v = window[key];
          if (v) scripts.unshift(JSON.stringify(v).slice(0, 250000));
        } catch {}
      }
      const ariaText = [...document.querySelectorAll('[aria-label], [title]')]
        .map((el) => [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('\\n')
        .slice(0, 30000);
      const fullPageText = (document.body?.innerText || '').slice(0, 60000);
      const common = {
        dataBlobs: scripts,
        textSample: [fullPageText, ariaText].filter(Boolean).join('\\n'),
        pageUrl: location.href,
      };
      if (platform === 'douyin') {
        const title = getText(['h1.video-title', '[data-e2e="video-desc"]', 'h1']) || meta('og:title') || document.title;
        const bodyText = collectText([
          '[data-e2e="video-desc"]',
          'h1.video-title',
          '[class*="video-desc"]',
          '[class*="desc"]',
          '[class*="caption"]',
        ]) || cleanBlock(meta('og:description'));
        const coverUrl = meta('og:image')
          || document.querySelector('video')?.poster
          || firstAttr(['img[src*="douyin"]', 'img[src]', 'picture img'], 'src');
        return {
          ...common,
          domTexts: {
            like: getText(['[data-e2e="video-player-digg"]', '[data-e2e="digg-count"]', '[data-e2e*="like"]', '.like-cnt', '[aria-label*="点赞"]']),
            share: getText(['[data-e2e="video-player-share"]', '[data-e2e="share-count"]', '.share-cnt', '[aria-label*="分享"]', '[aria-label*="转发"]']),
            comment: getText(['[data-e2e="comment-count"]', '.comment-cnt', '[aria-label*="评论"]']),
            favorite: getText(['[data-e2e*="collect"]', '[data-e2e*="favorite"]', '[aria-label*="收藏"]']),
          },
          title,
          bodyText,
          hashtags: extractHashtags([bodyText, title, fullPageText].filter(Boolean).join('\\n')),
          pubTime: getText(['span[data-e2e="video-author-publishtime"]', '.video-publish-time', 'time']) || document.querySelector('time')?.dateTime || null,
          contentType: 'video',
          coverUrl,
          durationText: getText(['[class*="duration"]', '[data-e2e*="duration"]']) || readableVideoDuration(),
        };
      }
      const title = getText(['#detail-title', '.note-title', '[class*="title"]', 'h1']) || meta('og:title') || document.title;
      const bodyText = collectText([
        '#detail-desc',
        '.note-content',
        '[class*="note-content"]',
        '[class*="desc"]',
        '[class*="content"]',
        'article',
      ]) || cleanBlock(meta('og:description'));
      const coverUrl = meta('og:image')
        || document.querySelector('video')?.poster
        || firstAttr(['.note-content img[src]', '[class*="swiper"] img[src]', 'img[src]'], 'src');
      return {
        ...common,
        domTexts: {
          like: getText(['.interact-container .like-wrapper .count', '[class*="like-wrapper"] .count', '[class*="like"] [class*="count"]', '[aria-label*="点赞"]']),
          share: getText(['.interact-container .share-wrapper .count', '[class*="share-wrapper"] .count', '[class*="share"] [class*="count"]', '[aria-label*="分享"]', '[aria-label*="转发"]']),
          comment: getText(['.interact-container .chat-wrapper .count', '[class*="comment-wrapper"] .count', '[class*="comment"] [class*="count"]', '[aria-label*="评论"]']),
          favorite: getText(['.interact-container .collect-wrapper .count', '[class*="collect-wrapper"] .count', '[class*="collect"] [class*="count"]', '[aria-label*="收藏"]']),
        },
        title,
        bodyText,
        hashtags: extractHashtags([bodyText, title, fullPageText].filter(Boolean).join('\\n')),
        pubTime: getText(['.bottom-container .date', '.note-publish-date', '[class*="date"]', 'time']) || document.querySelector('time')?.dateTime || null,
        contentType: 'article',
        coverUrl,
        durationText: getText(['[class*="duration"]', '[class*="video-time"]']) || readableVideoDuration(),
      };
    })()
  `);
}

function buildCaptureData(raw, platform) {
  const { metrics, evidence, confidence } = deriveMetricsWithEvidence(raw);
  const bodyText = cleanupBodyExcerpt(raw.bodyText || '', platform);
  const hashtags = normalizeHashtags(raw.hashtags || extractHashtagsFromText(`${raw.bodyText || ''}\n${raw.title || ''}\n${raw.textSample || ''}`));
  return {
    ...metrics,
    title: cleanupTitle(raw.title, platform),
    bodyText,
    hashtags,
    bodyExcerpt: formatBodyExcerpt(bodyText, hashtags),
    pubTime: raw.pubTime,
    pageUrl: raw.pageUrl,
    contentType: raw.contentType,
    coverUrl: raw.coverUrl || null,
    durationText: raw.durationText || null,
    metricsEvidence: evidence,
    metricsConfidence: confidence,
  };
}

function isDetailUrl(platform, url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (platform === 'douyin') return /\/video\/[^/?#]+/.test(u.pathname);
    if (platform === 'xiaohongshu') {
      return /\/explore\/[^/?#]+/.test(u.pathname) || /\/discovery\/item\/[^/?#]+/.test(u.pathname);
    }
  } catch {
    return false;
  }
  return false;
}

function isUnavailablePage(raw = {}) {
  const text = `${raw.title || ''}\n${raw.pageUrl || ''}\n${raw.textSample || ''}`;
  return /页面不见了|暂时无法浏览|error_code=|\/404\b|404/.test(text)
    || ((raw.pageUrl || '').endsWith('/explore') && /小红书\s*-\s*你的生活兴趣社区/.test(raw.title || ''));
}

function hasCaptureSignal(data = {}) {
  return Boolean(
    data.title
    && data.title !== '小红书 - 你的生活兴趣社区'
    && (data.like !== null || data.share !== null || data.comment !== null || data.favorite !== null)
  );
}

function cleanupTitle(title, platform) {
  const s = String(title || '').trim();
  if (!s) return '';
  if (platform === 'xiaohongshu') return s.replace(/\s*-\s*小红书\s*$/, '').trim();
  if (platform === 'douyin') return s.replace(/\s*-\s*抖音\s*$/, '').trim();
  return s;
}

function cleanupBodyExcerpt(text, platform) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (platform === 'xiaohongshu') s = s.replace(/\s*-\s*小红书\s*$/, '').trim();
  if (platform === 'douyin') s = s.replace(/\s*-\s*抖音\s*$/, '').trim();
  return s.slice(0, 2400);
}

function extractHashtagsFromText(text) {
  const found = [];
  const seen = new Set();
  const re = /#[^#\s，。！？、,.!?;；:：)）(（\[\]【】]+/g;
  for (const match of String(text || '').matchAll(re)) {
    const tag = match[0].trim();
    const key = tag.toLowerCase();
    if (tag.length < 2 || seen.has(key)) continue;
    seen.add(key);
    found.push(tag);
  }
  return found;
}

function normalizeHashtags(tags) {
  const list = Array.isArray(tags) ? tags : extractHashtagsFromText(String(tags || ''));
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const tag = text.startsWith('#') ? text : `#${text}`;
    const key = tag.toLowerCase();
    if (tag.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.slice(0, 24);
}

function formatBodyExcerpt(bodyText, hashtags = []) {
  const tagLine = hashtags.length ? `标签：${hashtags.join(' ')}` : '';
  return [bodyText, tagLine].filter(Boolean).join('\n').slice(0, 3000);
}

async function takeScreenshot(client, acc, platform) {
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const safeName = String(acc.nickname || acc.id || 'account').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    const filename = `rpa_${platform}_${safeName}_${Date.now()}.png`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    const buf = await client.screenshot();
    writeFileSync(filepath, buf);
    return `screenshots/${filename}`;
  } catch (e) {
    log.warn(`[RPA] 截图失败: ${e.message}`);
    return null;
  }
}

function saveData(acc, url, data, screenshotPath) {
  const publishTime = data.publishTime || parseHumanTime(data.pubTime);
  const payload = {
    platform: acc.platform,
    account_id: acc.id,
    author_name: acc.nickname,
    url,
    title: data.title || '无标题',
    content_type: data.contentType || (acc.platform === 'douyin' ? 'video' : 'article'),
    metrics_raw: {
      like: data.metricsEvidence?.like?.raw ?? data.like,
      share: data.metricsEvidence?.share?.raw ?? data.share,
      comment: data.metricsEvidence?.comment?.raw ?? data.comment,
      favorite: data.metricsEvidence?.favorite?.raw ?? data.favorite,
    },
    metrics_source: 'rpa',
    metrics_confidence: data.metricsConfidence,
    metrics_evidence: data.metricsEvidence,
    body_excerpt: data.bodyExcerpt || null,
    publish_time: publishTime,
    screenshot_path: screenshotPath,
    cover_url: data.coverUrl || null,
    duration_text: data.durationText || null,
  };

  const res = upsertCapture(payload);
  return {
    id: res.id,
    url,
    title: data.title || '无标题',
    duplicate: !!res.duplicate,
    dataStatus: res.status || res.reason || 'unknown',
    publishTime,
    screenshotPath,
  };
}

function parseHumanTime(str) {
  if (!str) return null;
  const now = new Date();
  if (str.includes('刚刚')) return now.toISOString();
  const minMatch = str.match(/(\d+)\s*分钟前/);
  if (minMatch) return new Date(now.getTime() - Number(minMatch[1]) * 60000).toISOString();
  const hrMatch = str.match(/(\d+)\s*小时前/);
  if (hrMatch) return new Date(now.getTime() - Number(hrMatch[1]) * 3600000).toISOString();
  const dayMatch = str.match(/(\d+)\s*天前/);
  if (dayMatch) return new Date(now.getTime() - Number(dayMatch[1]) * 86400000).toISOString();
  if (str.includes('昨天')) return new Date(now.getTime() - 86400000).toISOString();
  if (/^\d{2}-\d{2}$/.test(str)) return new Date(`${now.getFullYear()}-${str}`).toISOString();
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function clickTextLikeHuman(client, texts) {
  const rect = await client.evaluate(`
    (() => {
      const wanted = ${JSON.stringify(texts)};
      const nodes = Array.from(document.querySelectorAll('button, a, div, span, li'));
      for (const el of nodes) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text || text.length > 30) continue;
        if (!wanted.some((w) => text.includes(w))) continue;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 6 || r.height < 6 || style.display === 'none' || style.visibility === 'hidden') continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: innerWidth, height: innerHeight };
      }
      return null;
    })()
  `);
  if (!rect) return false;
  await executeHumanActions(client, [
    { type: 'move', x: rect.x, y: rect.y, duration_ms: 260 },
    { type: 'click', x: rect.x, y: rect.y },
    { type: 'wait', milliseconds: 500 },
  ], { width: rect.width, height: rect.height });
  return true;
}

async function scrollPage(client, times) {
  for (let i = 0; i < times; i++) {
    await executeHumanActions(client, [
      { type: 'scroll', delta_y: 900, x: 500, y: 500 },
      { type: 'wait', milliseconds: 450 },
    ], { width: 1600, height: 1200 });
  }
}

async function scrollXiaohongshuRow(client) {
  await executeHumanActions(client, [
    { type: 'scroll', delta_y: 360, x: 640, y: 620 },
    { type: 'wait', milliseconds: 360 },
  ], { width: 1600, height: 1200 });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { CDPClient } = await import('./cdp.js');
  const { launchChrome, killChrome } = await import('./chrome-launcher.js');
  const chrome = await launchChrome({ port: 9222, waitMs: 15000 });
  const client = new CDPClient();
  try {
    await client.connect(chrome.port);
    const result = await runPatrol(client, {
      onProgress: console.log,
      clientFactory: async () => {
        const c = new CDPClient();
        await c.connect(chrome.port);
        return c;
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
    if (chrome.closeOnDone && chrome.child) killChrome(chrome.child);
  }
}

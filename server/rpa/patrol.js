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
import { all } from '../db.js';
import {
  upsertCapture,
  upsertAccount,
  contentExistsByUrl,
  markAccountPatrolled,
} from '../store.js';
import { SCREENSHOTS_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { deriveMetricsWithEvidence } from '../../extension/extract-core.js';
import { clickRectLikeHuman, executeHumanActions } from './human-actions.js';
import { looksLikeRealProfile, platformSearchUrl } from '../lib/platform-links.js';

const DEFAULT_PLATFORMS = ['xiaohongshu', 'douyin'];
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_TABS_PER_PLATFORM = 3;

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
  } = opts;
  const maxTabsPerPlatform = normalizeMaxTabs(
    opts.maxTabsPerPlatform
      ?? process.env.VBP_RPA_MAX_TABS_PER_PLATFORM
      ?? process.env.VB_RPA_MAX_TABS_PER_PLATFORM
      ?? DEFAULT_MAX_TABS_PER_PLATFORM,
  );
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
    tabMode: clientFactory && maxTabsPerPlatform > 1 ? 'multi' : 'single',
    maxTabsPerPlatform: clientFactory && maxTabsPerPlatform > 1 ? maxTabsPerPlatform : 1,
  };

  progress(`开始自动巡检: ${platforms.join(', ')}`);

  if (discoverFollows) {
    const creators = await discoverFollowedCreators(client, { platforms, onProgress: progress });
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

  const placeholders = platforms.map(() => '?').join(',');
  const accounts = all(
    `SELECT * FROM accounts WHERE monitor_enabled = 1 AND platform IN (${placeholders}) ORDER BY priority ASC, last_patrolled_at ASC NULLS FIRST, created_at DESC`,
    platforms,
  );
  result.total = accounts.length;
  for (const acc of accounts) {
    initPlatformResult(result, acc.platform).total++;
  }

  if (clientFactory && maxTabsPerPlatform > 1) {
    progress(`启用多标签巡检: 每个平台最多同时打开 ${maxTabsPerPlatform} 个账号标签页`);
    const grouped = groupAccountsByPlatform(accounts, platforms);
    let primaryUsed = false;
    let displayIndex = 0;
    for (const platform of platforms) {
      const group = grouped.get(platform) || [];
      if (group.length === 0) continue;
      const tabs = Math.min(maxTabsPerPlatform, group.length);
      progress(`${platformName(platform)}: 准备同时打开 ${tabs} 个标签页巡检 ${group.length} 个账号`);
      const outcomes = await mapLimit(group, tabs, async (acc, localIndex) => {
        let worker = client;
        let shouldClose = false;
        if (primaryUsed) {
          worker = await clientFactory();
          shouldClose = true;
        } else {
          primaryUsed = true;
        }
        try {
          return await patrolAccount(worker, acc, progress, {
            index: displayIndex + localIndex,
            total: accounts.length,
            maxCandidates: maxCandidatesPerAccount,
          });
        } finally {
          if (shouldClose) worker.close();
        }
      });
      for (const outcome of outcomes) applyPatrolOutcome(result, outcome);
      displayIndex += group.length;
    }
  } else {
    for (let i = 0; i < accounts.length; i++) {
      const outcome = await patrolAccount(client, accounts[i], progress, {
        index: i,
        total: accounts.length,
        maxCandidates: maxCandidatesPerAccount,
      });
      applyPatrolOutcome(result, outcome);
      await client.sleep(1400 + Math.random() * 1600);
    }
  }

  progress(`巡检完成: 发现 ${result.discovered}, 成功 ${result.success}, 失败 ${result.failed}, 新增 ${result.newItems}, 去重 ${result.duplicates}`);
  return result;
}

function normalizeMaxTabs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TABS_PER_PLATFORM;
  return Math.max(1, Math.min(8, Math.floor(n)));
}

function platformName(platform) {
  if (platform === 'xiaohongshu') return '小红书';
  if (platform === 'douyin') return '抖音';
  return platform;
}

function groupAccountsByPlatform(accounts, platforms) {
  const grouped = new Map(platforms.map((p) => [p, []]));
  for (const acc of accounts) {
    if (!grouped.has(acc.platform)) grouped.set(acc.platform, []);
    grouped.get(acc.platform).push(acc);
  }
  return grouped;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
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
    if (outcome.item?.duplicate) {
      result.duplicates++;
      platformResult.duplicates++;
    } else {
      result.newItems++;
      platformResult.newItems++;
    }
  } else {
    result.failed++;
    platformResult.failed++;
  }
  result.details.push(outcome);
}

async function patrolAccount(client, acc, progress, { index, total, maxCandidates }) {
  const label = `${acc.platform}/${acc.nickname || acc.homepage_url || acc.id}`;
  const accountProgress = (msg) => progress(`[${label}] ${String(msg || '').trimStart()}`);

  if (!acc.homepage_url && !acc.nickname) {
    return { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'skipped', error: '缺少主页链接和昵称', item: null };
  }

  progress(`(${index + 1}/${total}) 打开标签页巡检 ${label}`);
  try {
    const item = acc.platform === 'douyin'
      ? await patrolDouyin(client, acc, accountProgress, { maxCandidates })
      : await patrolXiaohongshu(client, acc, accountProgress, { maxCandidates });

    if (!item) {
      return { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'error', error: '未能提取到新增内容', item: null };
    }

    markAccountPatrolled(acc.id, { lastSeenUrl: item.url, lastSeenPublishTime: item.publishTime });
    return { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'ok', item };
  } catch (e) {
    markAccountPatrolled(acc.id);
    log.warn(`[RPA] 巡检 ${label} 失败: ${e.message}`);
    return { accountId: acc.id, nickname: acc.nickname, platform: acc.platform, status: 'error', error: e.message, item: null };
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

async function patrolDouyin(client, acc, progress, { maxCandidates }) {
  const homepage = await openAccountHomepage(client, acc, 'douyin', progress, { waitMs: 4500 });
  if (!homepage) return null;

  const postCandidates = await waitForPostCandidates(client, 'douyin');
  if (postCandidates.length === 0) {
    progress('  未找到最新视频链接');
    return null;
  }

  return patrolCandidateUrls(client, acc, 'douyin', postCandidates, progress, { maxCandidates, waitMs: 4500 });
}

async function patrolXiaohongshu(client, acc, progress, { maxCandidates }) {
  const homepage = await openAccountHomepage(client, acc, 'xiaohongshu', progress, { waitMs: 5000 });
  if (!homepage) return null;

  const postCandidates = await waitForPostCandidates(client, 'xiaohongshu');
  if (postCandidates.length === 0) {
    progress('  未找到最新笔记链接');
    return null;
  }

  return patrolCandidateUrls(client, acc, 'xiaohongshu', postCandidates, progress, { maxCandidates, waitMs: 7000, homepage });
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

async function patrolCandidateUrls(client, acc, platform, postCandidates, progress, { maxCandidates, waitMs, homepage = null }) {
  progress(`  找到 ${postCandidates.length} 个候选内容，最多检查 ${maxCandidates} 条`);
  let duplicateUrl = null;
  for (let i = 0; i < Math.min(postCandidates.length, maxCandidates); i++) {
    const candidate = normalizePostCandidate(postCandidates[i]);
    const postUrl = candidate?.url;
    if (!postUrl) continue;
    if (contentExistsByUrl(postUrl)) {
      progress(`  候选 ${i + 1} 已采集，跳过`);
      duplicateUrl ||= postUrl;
      continue;
    }

    progress(`  进入候选 ${i + 1}: ${postUrl}`);
    if (platform === 'xiaohongshu' && candidate.rect && homepage) {
      await openXiaohongshuCandidateFromHomepage(client, homepage, candidate, progress, { waitMs });
    } else {
      if (platform === 'xiaohongshu') progress('  候选缺少可点击卡片范围，改用详情链接兜底');
      await client.goto(postUrl);
      await client.sleep(waitMs);
    }
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

    if (contentExistsByUrl(finalUrl)) {
      progress('  详情页已采集，跳过');
      duplicateUrl ||= finalUrl;
      continue;
    }
    if (isUnavailablePage(raw) || !hasCaptureSignal(data)) {
      progress(`  候选不可采，跳过: ${data.title || raw.pageUrl || postUrl}`);
      continue;
    }

    progress(`  抓取到数据: 点赞=${data.like}, 转发=${data.share}, 收藏=${data.favorite}, 证据=${data.metricsConfidence}`);
    const screenshotPath = await takeScreenshot(client, acc, platform);
    const item = saveData(acc, finalUrl, data, screenshotPath);
    if (item.duplicate) {
      progress('  内容重复，继续检查下一条');
      duplicateUrl ||= item.url;
      continue;
    }
    return item;
  }

  progress('  候选内容均已采集或不可采');
  if (duplicateUrl) {
    return {
      url: duplicateUrl,
      title: '候选内容已采集',
      duplicate: true,
      dataStatus: 'already_seen',
      publishTime: null,
      screenshotPath: null,
    };
  }
  return null;
}

async function openXiaohongshuCandidateFromHomepage(client, homepage, candidate, progress, { waitMs }) {
  const current = await safeCurrentUrl(client);
  if (!sameCleanUrl(current, homepage)) {
    await client.goto(homepage);
    await client.sleep(2200 + Math.random() * 1200);
  }

  const fresh = await findPostCandidateByUrl(client, 'xiaohongshu', candidate.url);
  const clickTarget = fresh?.rect ? fresh : candidate;
  if (!clickTarget.rect) {
    progress('  候选回到主页后未找到卡片范围，改用详情链接兜底');
    await client.goto(candidate.url);
    await client.sleep(waitMs);
    return;
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
            || /note|feed|card|cover|item|waterfall|media|作品|瀑布/i.test(name)
            || ['ARTICLE', 'LI', 'SECTION'].includes(el.tagName);
          if (likelyCard) rects.push(rect);
        }
        return rects.find((r) => r.width >= 80 && r.height >= 80) || rects[0] || visibleRect(link);
      };
      const out = [];
      const seen = new Set();
      const push = (link, allowWithoutRect = false) => {
        const href = toAbs(link.getAttribute('href') || link.href);
        if (!isDetail(href)) return;
        const key = detailKey(href);
        if (!key || seen.has(key)) return;
        if (targetKey && key !== targetKey) return;
        const rect = platform === 'xiaohongshu' ? findCardRect(link) : null;
        if (platform === 'xiaohongshu') {
          if (!rect && !allowWithoutRect) return;
          seen.add(key);
          out.push({ url: href, rect, viewport: { width: innerWidth, height: innerHeight } });
          return;
        }
        seen.add(key);
        out.push(href);
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
  return {
    url,
    rect: normalizeRect(item.rect),
    viewport: normalizeViewport(item.viewport),
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
      const bodyText = (document.body?.innerText || '').slice(0, 60000);
      const common = {
        dataBlobs: scripts,
        textSample: [bodyText, ariaText].filter(Boolean).join('\\n'),
        pageUrl: location.href,
      };
      if (platform === 'douyin') {
        return {
          ...common,
          domTexts: {
            like: getText(['[data-e2e="video-player-digg"]', '[data-e2e="digg-count"]', '[data-e2e*="like"]', '.like-cnt', '[aria-label*="点赞"]']),
            share: getText(['[data-e2e="video-player-share"]', '[data-e2e="share-count"]', '.share-cnt', '[aria-label*="分享"]', '[aria-label*="转发"]']),
            comment: getText(['[data-e2e="comment-count"]', '.comment-cnt', '[aria-label*="评论"]']),
            favorite: getText(['[data-e2e*="collect"]', '[data-e2e*="favorite"]', '[aria-label*="收藏"]']),
          },
          title: getText(['h1.video-title', '[data-e2e="video-desc"]', 'h1']) || meta('og:title') || document.title,
          pubTime: getText(['span[data-e2e="video-author-publishtime"]', '.video-publish-time', 'time']) || document.querySelector('time')?.dateTime || null,
          contentType: 'video',
        };
      }
      return {
        ...common,
        domTexts: {
          like: getText(['.interact-container .like-wrapper .count', '[class*="like-wrapper"] .count', '[class*="like"] [class*="count"]', '[aria-label*="点赞"]']),
          share: getText(['.interact-container .share-wrapper .count', '[class*="share-wrapper"] .count', '[class*="share"] [class*="count"]', '[aria-label*="分享"]', '[aria-label*="转发"]']),
          comment: getText(['.interact-container .chat-wrapper .count', '[class*="comment-wrapper"] .count', '[class*="comment"] [class*="count"]', '[aria-label*="评论"]']),
          favorite: getText(['.interact-container .collect-wrapper .count', '[class*="collect-wrapper"] .count', '[class*="collect"] [class*="count"]', '[aria-label*="收藏"]']),
        },
        title: getText(['#detail-title', '.note-title', '[class*="title"]', 'h1']) || meta('og:title') || document.title,
        pubTime: getText(['.bottom-container .date', '.note-publish-date', '[class*="date"]', 'time']) || document.querySelector('time')?.dateTime || null,
        contentType: 'article',
      };
    })()
  `);
}

function buildCaptureData(raw, platform) {
  const { metrics, evidence, confidence } = deriveMetricsWithEvidence(raw);
  return {
    ...metrics,
    title: cleanupTitle(raw.title, platform),
    pubTime: raw.pubTime,
    pageUrl: raw.pageUrl,
    contentType: raw.contentType,
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
  const publishTime = parseHumanTime(data.pubTime);
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
    publish_time: publishTime,
    screenshot_path: screenshotPath,
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
    client.close();
    if (chrome.closeOnDone && chrome.child) killChrome(chrome.child);
  }
}

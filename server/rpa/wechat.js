/**
 * 微信视频号 / 公众号 OS 级视觉巡检。
 *
 * 微信桌面端是内置 webview，无 CDP 调试端口，所以这里不走 Chrome 那套，
 * 而是「截图 → 视觉模型定位/读数 → CGEvent 坐标点击」（见 macos-input.js / ai/observe.js）。
 *
 * 关键不变量（与抖音/小红书一致）：
 *   - RPA 只负责顺序采集，不做入选判断；可采内容一律截图入库。
 *   - 视觉读出的数字以 metrics_source='desktop_agent' 入库 → needs_review，
 *     人工确认前绝不可信、绝不自动达标（不变量 #1）。
 *   - 视频号/公众号只进独立热点视图，不入正式每日日报（不变量 #4）。
 *
 * 导航规格（来自用户）：
 *   视频号：朋友圈下方视频号入口 → 右上小人 → 赞和收藏 → 关注 → 逐个关注博主
 *     → 首进先关掉自动播放的第一个视频 → 跳置顶 → 开第一条 → 读数入库
 *     → 点右侧下箭头翻页 → 默认每博主 maxVideosPerCreator 条 → 关标签回关注总览。
 *   公众号：左上搜索 → 搜博主 → 进主页（没进就点右上小人）→ 跳置顶/付费
 *     → 按时限开文章 → 读精确发布时间 → 评分 → 达标尝试复制正文 → 入库。
 *
 * 注意：坐标导航需在用户本机开着微信实跑校准；找不到目标时本模块会跳过并记原因，
 * 不会瞎点敏感按钮（视觉定位 prompt 已禁止点赞/支付/验证码等）。
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { all } from '../db.js';
import { upsertCapture, markAccountPatrolled, beijingDayStartISO } from '../store.js';
import { SCREENSHOTS_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { loadConfig, hasApiKey } from '../config.js';
import { wechatScoreConfig, scoreWechatContent } from '../wechat/score.js';
import { locateWechatTarget, readWechatDetail } from '../ai/observe.js';
import { isMac, MacInputSession, activateWeChat } from './macos-input.js';

const PLATFORM_LABEL = { wechat_channels: '视频号', wechat_article: '公众号' };

/**
 * 把中文发布时间文本解析为 ISO（UTC）。纯函数，便于测试。
 * 覆盖：刚刚 / X分钟前 / X小时前 / 昨天 / 前天 / X天前 / 今天 HH:MM /
 *       M月D日[ HH:MM] / YYYY年M月D日 / "编辑于 ..." 前缀 / 可被 Date 解析的串。
 * 缺省按北京时间（UTC+8）理解；解析不出返回 null（绝不瞎猜）。
 */
export function parseChinesePublishTime(raw, now = new Date()) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^编辑于\s*/, '').replace(/^发布于\s*/, '').trim();

  const fromBeijing = (y, mo, d, h = 0, mi = 0) =>
    new Date(Date.UTC(y, mo - 1, d, h - 8, mi)).toISOString();
  const bjNow = new Date(now.getTime() + 8 * 3600_000); // 北京"时钟"
  const by = bjNow.getUTCFullYear();
  const bmo = bjNow.getUTCMonth() + 1;
  const bd = bjNow.getUTCDate();

  if (/^刚刚/.test(s)) return new Date(now.getTime()).toISOString();
  let m = s.match(/^(\d+)\s*分钟前/);
  if (m) return new Date(now.getTime() - Number(m[1]) * 60_000).toISOString();
  m = s.match(/^(\d+)\s*小时前/);
  if (m) return new Date(now.getTime() - Number(m[1]) * 3600_000).toISOString();
  m = s.match(/^(\d+)\s*天前/);
  if (m) return new Date(now.getTime() - Number(m[1]) * 86400_000).toISOString();

  const hm = s.match(/(\d{1,2}):(\d{2})/);
  const h = hm ? Number(hm[1]) : 0;
  const mi = hm ? Number(hm[2]) : 0;
  if (/^今天/.test(s)) return fromBeijing(by, bmo, bd, h, mi);
  if (/^昨天/.test(s)) {
    const d = new Date(Date.UTC(by, bmo - 1, bd - 1));
    return fromBeijing(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi);
  }
  if (/^前天/.test(s)) {
    const d = new Date(Date.UTC(by, bmo - 1, bd - 2));
    return fromBeijing(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi);
  }

  m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return fromBeijing(Number(m[1]), Number(m[2]), Number(m[3]), h, mi);
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    // 没有年份：取「不晚于今天」的最近一年（避免把未来日期当今年）。
    let y = by;
    if (mo > bmo || (mo === bmo && d > bd)) y = by - 1;
    return fromBeijing(y, mo, d, h, mi);
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function saveAgentScreenshot(base64, acc, platform) {
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const safe = String(acc?.nickname || acc?.id || 'wechat').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    const filename = `wechat_${platform}_${safe}_${Date.now()}.png`;
    writeFileSync(join(SCREENSHOTS_DIR, filename), Buffer.from(base64, 'base64'));
    return `screenshots/${filename}`;
  } catch (e) {
    log.warn(`[WeChat] 截图保存失败: ${e.message}`);
    return null;
  }
}

/** 把一条视觉读出的详情入库（desktop_agent → needs_review）。 */
function ingestWechatDetail(acc, platform, detail, screenshotPath) {
  const metrics = detail.metrics || {};
  const result = upsertCapture({
    platform,
    account_id: acc.id,
    author_name: acc.nickname,
    url: null, // 微信详情无稳定网页 URL；靠 平台+作者+标题 指纹去重
    title: detail.title || '无标题',
    content_type: platform === 'wechat_channels' ? 'video' : 'article',
    publish_time: parseChinesePublishTime(detail.publish_time),
    screenshot_path: screenshotPath,
    metrics_source: 'desktop_agent',
    metrics_raw: {
      like: metrics.like ?? null,
      share: metrics.share ?? null,
      favorite: metrics.favorite ?? null,
      comment: metrics.comment ?? null,
      read: metrics.read ?? null,
    },
  });
  return result;
}

/**
 * 截图 → 视觉定位描述的目标 → 坐标点击。找不到/置信度过低则不点。
 * @returns {Promise<boolean>} 是否点击成功
 */
async function tap(session, description, progress, { afterMs = 600, minConfidence = 0.45 } = {}) {
  const shot = await session.screenshot();
  let hit;
  try {
    hit = await locateWechatTarget(shot.base64, {
      description, imageWidth: shot.width, imageHeight: shot.height,
    });
  } catch (e) {
    progress(`  定位「${description}」失败: ${e.message}`);
    return false;
  }
  if (!hit?.found || Number(hit.confidence) < minConfidence) {
    progress(`  未找到「${description}」(${hit?.note || '低置信度'})，跳过`);
    return false;
  }
  await session.clickImagePx({ x: hit.x, y: hit.y }, { afterMs });
  progress(`  已点击「${description}」`);
  return true;
}

/** 截当前详情 → 视觉读数 → 入库。返回 { result, detail, score } 或 null。 */
async function captureCurrentDetail(session, acc, platform, progress) {
  const shot = await session.screenshot();
  let detail;
  try {
    detail = await readWechatDetail(shot.base64, { platform, creator: acc.nickname });
  } catch (e) {
    progress(`  读数失败: ${e.message}`);
    return null;
  }
  const screenshotPath = saveAgentScreenshot(shot.base64, acc, platform);
  const result = ingestWechatDetail(acc, platform, detail, screenshotPath);
  const score = scoreWechatContent(
    {
      platform,
      publish_time: parseChinesePublishTime(detail.publish_time),
      // 用原始文本粗略带入评分（评分只用于日志提示；正式分数在热点视图按 DB 真值算）
    },
    loadConfig(),
  );
  progress(`  已采集「${(detail.title || '无标题').slice(0, 18)}」${detail.is_pinned ? '（置顶）' : ''} → ${result.duplicate ? '去重' : '新增'}`);
  return { result, detail, score };
}

/** 视频号：巡检单个关注博主，最多 maxVideos 条。 */
async function patrolChannelsCreator(session, acc, progress, { maxVideos, shouldStop }) {
  const items = { newItems: 0, duplicates: 0 };
  // 进入博主主页（在关注总览里点博主名）
  const entered = await tap(session, `关注列表里名为「${acc.nickname}」的视频号博主条目`, progress, { afterMs: 1500 });
  if (!entered) return { ...items, skipped: '未能进入博主主页' };

  // 首进：关掉自动播放的第一个视频，避免外放声音、占内存。
  await session.pressEscape();
  await session.sleep(600);

  let captured = 0;
  while (captured < maxVideos) {
    if (shouldStop?.()) break;
    // 第一条之前：跳过置顶。读当前详情时若识别为置顶，跳过但不计入条数。
    const got = await captureCurrentDetail(session, acc, 'wechat_channels', progress);
    if (got) {
      if (got.detail.is_pinned) {
        progress('  当前为置顶内容，跳过，不计入条数');
      } else {
        captured++;
        if (got.result.duplicate) items.duplicates++; else items.newItems++;
      }
    }
    if (captured >= maxVideos) break;
    // 右侧下箭头翻到下一条
    const next = await tap(session, '详情页右侧向下的「下一个视频」箭头按钮', progress, { afterMs: 1800 });
    if (!next) { progress('  没有下一个按钮，结束该博主'); break; }
  }
  // 关闭当前视频号详情，回到关注总览
  await session.pressEscape();
  await session.sleep(500);
  return items;
}

/** 公众号：搜索并巡检单个博主最近文章。 */
async function patrolArticlesCreator(session, acc, progress, { maxArticles, windowStartISO, shouldStop, scoreCfg }) {
  const items = { newItems: 0, duplicates: 0 };
  // 左上搜索框
  const openedSearch = await tap(session, '微信主窗口左上角的搜索框', progress, { afterMs: 700 });
  if (!openedSearch) return { ...items, skipped: '未找到搜索框' };
  await session.typeViaClipboard(acc.nickname);
  await session.sleep(900);
  // 点搜索结果里的该公众号
  const hitResult = await tap(session, `搜索结果里名为「${acc.nickname}」的公众号条目`, progress, { afterMs: 1600 });
  if (!hitResult) { await session.pressEscape(); return { ...items, skipped: '搜索无匹配公众号' }; }

  // 可能没直接进主页：尝试点右上角小人进主页（找不到就当已在主页/文章列表）
  await tap(session, '聊天窗口右上角进入公众号主页的「小人/头像」按钮', progress, { afterMs: 1200, minConfidence: 0.5 });

  let captured = 0;
  let guard = 0;
  while (captured < maxArticles && guard < maxArticles * 3) {
    if (shouldStop?.()) break;
    guard++;
    // 打开一篇文章（跳过置顶/付费由 readWechatDetail 标记后再判断）
    const opened = await tap(session, `公众号文章列表里第 ${captured + 1} 篇可点击的文章标题（跳过置顶和付费内容）`, progress, { afterMs: 2000 });
    if (!opened) { progress('  没有更多可读文章，结束该博主'); break; }

    const got = await captureCurrentDetail(session, acc, 'wechat_article', progress);
    if (got) {
      const pubISO = parseChinesePublishTime(got.detail.publish_time);
      if (got.detail.is_paid) {
        progress('  付费内容，跳过');
      } else if (windowStartISO && pubISO && pubISO < windowStartISO) {
        progress('  文章已早于时间窗口，结束该博主');
        await session.pressEscape();
        break;
      } else {
        captured++;
        if (got.result.duplicate) items.duplicates++; else items.newItems++;
      }
    }
    // 返回文章列表（关闭当前文章）
    await session.pressEscape();
    await session.sleep(600);
  }
  // 关掉公众号会话回主窗口
  await session.pressEscape();
  await session.sleep(400);
  return items;
}

/**
 * 运行一个平台阶段的微信热点巡检。
 * @param {object} opts
 * @param {'wechat_channels'|'wechat_article'} opts.platform
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldStop]
 * @param {boolean} [opts.includePatrolledToday]
 * @returns {Promise<object>} 巡检结果汇总
 */
export async function runWechatPatrol(opts = {}) {
  const platform = opts.platform === 'wechat_article' ? 'wechat_article' : 'wechat_channels';
  const shouldStop = opts.shouldStop || (() => false);
  const onProgress = opts.onProgress || (() => {});
  const progress = (msg) => { log.info(`[WeChat] ${msg}`); onProgress(msg); };

  const result = {
    platform, total: 0, success: 0, failed: 0, newItems: 0, duplicates: 0,
    platformResults: {}, details: [], stopped: false,
  };

  if (!isMac()) throw new Error('微信视觉巡检目前只支持 macOS（用 screencapture / osascript 驱动微信桌面端）。');
  if (!hasApiKey()) throw new Error('未配置 API Key，无法用视觉模型读取微信内容。请先在「设置」里填写。');

  const cfg = loadConfig();
  const scoreCfg = wechatScoreConfig(cfg);
  const maxPer = scoreCfg.maxVideosPerCreator;
  const windowType = scoreCfg.window;

  const accounts = all(
    'SELECT * FROM accounts WHERE monitor_enabled = 1 AND platform = ?',
    [platform],
  );
  const todayStart = beijingDayStartISO();
  const pending = opts.includePatrolledToday
    ? accounts
    : accounts.filter((a) => !(a.last_patrolled_at && a.last_patrolled_at >= todayStart));
  result.total = pending.length;

  if (pending.length === 0) {
    progress(`${PLATFORM_LABEL[platform]}：没有待巡检的关注博主（账号池里没有或今天都跑过了）。`);
    return result;
  }

  await activateWeChat();
  const session = new MacInputSession();
  await session.refreshScreenMetrics();
  await session.sleep(600);

  // 进入视频号关注总览（公众号走主窗口搜索，无需此步）。
  if (platform === 'wechat_channels') {
    progress('进入视频号关注总览：视频号(蝴蝶/W 图标)入口 → 右上小人 → 赞和收藏 → 关注');
    // 关键：视频号入口是「蝴蝶 / 横向 W 翅膀」形状的图标（视频号官方 logo），
    // 位于左侧竖排里「朋友圈」(相机光圈状圆形图标) 的正下方。
    // 千万别点成上方的光圈图标(那是看一看/朋友圈，会打开很像的推荐信息流)。
    await tap(session, '微信主窗口最左侧竖排图标里的「视频号」入口：一个像蝴蝶、横向 W 翅膀形状的图标（视频号官方 logo），就在相机光圈状的「朋友圈」图标正下方。不要点光圈图标。', progress, { afterMs: 2500 });
    // 首进关掉自动播放的第一个视频
    await session.pressEscape();
    await session.sleep(500);
    await tap(session, '视频号窗口右上角那个小人一样的按钮', progress, { afterMs: 1500 });
    await tap(session, '左侧一列里的「关注」入口', progress, { afterMs: 1500 });
  }

  const windowStartISO = new Date(Date.now() - windowDays(windowType) * 86400_000).toISOString();

  for (const acc of pending) {
    if (shouldStop()) { result.stopped = true; break; }
    const label = `${PLATFORM_LABEL[platform]}/${acc.nickname || acc.id}`;
    progress(`巡检 ${label}`);
    try {
      const r = platform === 'wechat_channels'
        ? await patrolChannelsCreator(session, acc, progress, { maxVideos: maxPer, shouldStop })
        : await patrolArticlesCreator(session, acc, progress, { maxArticles: maxPer, windowStartISO, shouldStop, scoreCfg });
      result.newItems += r.newItems || 0;
      result.duplicates += r.duplicates || 0;
      if (r.skipped) { result.details.push({ account: acc.nickname, skipped: r.skipped }); }
      result.success++;
      markAccountPatrolled(acc.id);
    } catch (e) {
      result.failed++;
      result.details.push({ account: acc.nickname, error: e.message });
      progress(`  ${label} 失败: ${e.message}`);
      markAccountPatrolled(acc.id);
    }
  }

  result.platformResults[platform] = { total: result.total, success: result.success, failed: result.failed };
  result.stopped = result.stopped || shouldStop();
  progress(`${PLATFORM_LABEL[platform]}巡检${result.stopped ? '已停止' : '完成'}：成功 ${result.success}，失败 ${result.failed}，新增 ${result.newItems}，去重 ${result.duplicates}`);
  return result;
}

function windowDays(windowType) {
  const m = String(windowType).match(/^last_(\d+)_days?$/);
  const d = m ? Number(m[1]) : 7;
  return d >= 1 ? d : 7;
}

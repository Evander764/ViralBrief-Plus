'use strict';
// 弹窗逻辑：注入页面采集原料 → 解析指标 → 截图 → 用户确认/修正 → POST 到本地桌面端。
import { deriveMetrics } from './extract-core.js';

const $ = (id) => document.getElementById(id);

/**
 * 注入到页面 MAIN world 运行：只负责「采集原料」，不做指标判定。
 * 关键：跑在 MAIN world 才能读到页面注入的 window.__INITIAL_STATE__ /
 * RENDER_DATA 等内嵌数据——真正的点赞/转发数字往往在这里，而不是 DOM class 上。
 */
function gatherRaw() {
  const host = location.hostname;
  let platform = 'other';
  if (host.includes('douyin.com')) platform = 'douyin';
  else if (host.includes('xiaohongshu.com') || host.includes('xhslink')) platform = 'xiaohongshu';
  else if (host.includes('channels.weixin') || location.href.includes('weixin.qq.com/channels')) platform = 'wechat_channels';
  else if (host.includes('mp.weixin.qq.com')) platform = 'wechat_article';

  const content_type = (platform === 'douyin' || platform === 'wechat_channels') ? 'video' : 'article';
  const text = (sel) => { try { const el = document.querySelector(sel); return el ? (el.textContent || '').trim() : null; } catch { return null; } };
  const meta = (name) => { const el = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`); return el ? el.content : null; };

  const title = meta('og:title') || document.title || text('h1') || '';
  let author = meta('og:author') || meta('author') || null;

  // ---- 1) 内嵌结构化数据：脚本里的大 JSON + 全局状态对象 ----
  const dataBlobs = [];
  try {
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.length > 40 && t.length < 5_000_000 && /(diggCount|liked_count|like_count|shareCount|share_count|commentCount|collectCount|interactInfo|statistics)/i.test(t)) {
        // 抽取脚本里第一个 {...} 大对象
        const i = t.indexOf('{'); const j = t.lastIndexOf('}');
        if (i !== -1 && j > i) dataBlobs.push(t.slice(i, j + 1));
      }
    }
    for (const key of ['__INITIAL_STATE__', '__INITIAL_SSR_STATE__', '__NUXT__', 'RENDER_DATA', '_ROUTER_DATA']) {
      try { if (window[key]) dataBlobs.push(JSON.stringify(window[key])); } catch { /* 循环引用等忽略 */ }
    }
  } catch { /* ignore */ }

  // ---- 2) DOM/aria 文本：就近取各平台已知位置 + aria-label ----
  const domTexts = { like: null, share: null, comment: null, favorite: null };
  try {
    if (platform === 'douyin') {
      domTexts.like = text('[data-e2e="like-count"]') || text('[data-e2e="video-like-count"]');
      domTexts.comment = text('[data-e2e="comment-count"]');
      domTexts.favorite = text('[data-e2e="collect-count"]') || text('[data-e2e="undefined-collect-count"]');
      domTexts.share = text('[data-e2e="share-count"]');
      author = author || text('[data-e2e="video-author-uniqueid"]') || text('[data-e2e="user-name"]');
    } else if (platform === 'xiaohongshu') {
      domTexts.like = text('.like-wrapper .count') || text('.like-active .count') || text('.engage-bar .like .count');
      domTexts.favorite = text('.collect-wrapper .count') || text('.collect .count');
      domTexts.comment = text('.chat-wrapper .count') || text('.comment .count') || text('.comments-count');
      domTexts.share = text('.share-wrapper .count') || text('.share .count');
      author = author || text('.author-wrapper .username') || text('.username');
    } else if (platform === 'wechat_article') {
      domTexts.like = text('#js_likes') || text('.like_num') || text('#js_like_count');
      domTexts.favorite = text('#js_collect_count');
      author = author || text('#js_name') || text('.account_nickname_inner');
    }
    // aria-label 兜底：很多平台把数字放在按钮的 aria-label（如 "点赞 1.2万"）
    const ariaParts = [];
    for (const el of document.querySelectorAll('[aria-label]')) {
      const a = el.getAttribute('aria-label') || '';
      if (/(赞|like|评论|comment|转发|分享|share|收藏|collect)/i.test(a)) ariaParts.push(a);
      if (ariaParts.length > 40) break;
    }
    var ariaText = ariaParts.join('  ');
  } catch { var ariaText = ''; }

  // ---- 3) 正文样本（含 aria 文本）给正则兜底 ----
  let visible = '';
  try { visible = (document.body.innerText || '').slice(0, 6000); } catch { /* ignore */ }
  const textSample = `${ariaText || ''}\n${visible}`;

  const body_excerpt = (meta('og:description') || (document.querySelector('article,#js_content,.note-content,.desc') || {}).innerText || '').slice(0, 1000);

  return { url: location.href, platform, content_type, title, author_name: author, body_excerpt, dataBlobs, domTexts, textSample };
}

async function init() {
  const cfg = await chrome.storage.local.get(['endpoint', 'token']);
  if (!cfg.endpoint || !cfg.token) {
    setMsg('请先点下方「配置桌面端连接」填写地址与配对 token。', 'bad');
  } else {
    // 先探测桌面端是否在运行，给出明确提示
    probeDesktop(cfg.endpoint);
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // world: 'MAIN' 才能读页面内嵌数据；失败再退回默认隔离世界。
    let result;
    try {
      [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: gatherRaw });
    } catch {
      [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: gatherRaw });
    }
    const d = result || {};
    const metrics = deriveMetrics(d); // 在 popup 上下文用可单测的核心解析
    d.metrics_raw = metrics;
    window.__extract = d;

    $('platform').value = d.platform || 'other';
    $('content_type').value = d.content_type || 'article';
    $('title').value = d.title || '';
    $('author_name').value = d.author_name || '';
    $('like').value = metrics.like ?? '';
    $('share').value = metrics.share ?? '';
    $('comment').value = metrics.comment ?? '';
    $('favorite').value = metrics.favorite ?? '';

    const got = ['like', 'share', 'comment', 'favorite'].filter((k) => metrics[k] !== null).length;
    if (got === 0) {
      setMsg('未能自动识别到指标（平台常改版/需登录）。请按页面显示手动填写点赞与转发，再保存。', '');
    } else if (metrics.like === null || metrics.share === null) {
      setMsg(`已识别 ${got} 项；点赞或转发仍需你核对补全（双 1000 必须准确）。`, '');
    } else {
      setMsg('已自动识别主要指标，请核对后保存。', 'ok');
    }
  } catch (e) {
    setMsg('无法读取此页面（可能是受限页面）。可手动填写后保存。', 'bad');
    window.__extract = { url: tab?.url || '', platform: 'other', content_type: 'article', metrics_raw: {} };
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 70 });
    $('shot').src = dataUrl;
    window.__shot = dataUrl;
  } catch { /* 截图失败不阻塞保存 */ }
}

function setMsg(t, kind) { $('msg').textContent = t; $('msg').className = 'msg' + (kind ? ' ' + kind : ''); }

async function probeDesktop(endpoint) {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/health`, { method: 'GET' });
    if (!res.ok) throw new Error();
  } catch {
    setMsg('连不上桌面端：请确认已启动（npm start / 打开 App），且地址端口正确。', 'bad');
  }
}

$('save').addEventListener('click', async () => {
  const cfg = await chrome.storage.local.get(['endpoint', 'token']);
  if (!cfg.endpoint || !cfg.token) { setMsg('未配置桌面端连接。', 'bad'); return; }
  const d = window.__extract || {};
  const payload = {
    url: d.url, platform: $('platform').value, content_type: $('content_type').value,
    title: $('title').value.trim(), author_name: $('author_name').value.trim(),
    body_excerpt: d.body_excerpt || '',
    publish_time: $('publish_time').value || null,
    metrics_raw: {
      like: $('like').value.trim() || null, share: $('share').value.trim() || null,
      comment: $('comment').value.trim() || null, favorite: $('favorite').value.trim() || null,
    },
    // 用户在弹窗里核对过，按人工确认来源记，省去桌面端再确认一遍。
    metrics_source: 'manual',
    screenshot: window.__shot || null,
  };
  $('save').disabled = true; setMsg('保存中…', '');
  try {
    const res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/api/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vb-token': cfg.token },
      body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    setMsg(r.duplicate ? '该内容已存在，已合并补充信息。' : `已保存（状态：${statusText(r.status)}）。可去桌面端查看。`, 'ok');
  } catch (e) {
    setMsg('保存失败：' + e.message + '（确认桌面端已启动、token 正确）', 'bad');
  } finally {
    $('save').disabled = false;
  }
});

function statusText(s) {
  return ({ confirmed: '已达标入库', missing_share: '缺转发数·待补录', below_threshold: '未达双千', needs_review: '待复核' })[s] || s || '已入库';
}

$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

init();

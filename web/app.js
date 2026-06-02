'use strict';
// 仪表盘前端逻辑（原生 JS，零框架）。所有 /api 调用都带配对 token。

let TOKEN = window.__VBP_TOKEN__ || window.__VB_TOKEN__; // 可变：重置配对 token 后即时更新，避免后续请求 401
const PORT = window.__VBP_PORT__ || window.__VB_PORT__;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const PLATFORM_LABEL = {
  douyin: '抖音', xiaohongshu: '小红书', wechat_channels: '视频号', wechat_article: '公众号文章', other: '其他',
};
const STATUS_LABEL = {
  confirmed: '已确认', needs_review: '待复核', missing_share: '缺转发数',
  missing_favorite: '缺收藏数', missing_like: '缺点赞数', below_threshold: '未达阈值',
  duplicate: '重复', archived: '已归档', monitoring: '发酵中',
};
let accountsCache = [];
let accountSuggestionCache = [];
const ACCOUNT_SEARCH_PLATFORMS = ['xiaohongshu', 'douyin'];
const ACCOUNT_FORM_PLATFORMS = ['douyin', 'xiaohongshu', 'wechat_channels', 'wechat_article', 'other'];
const WEB_PATROL_STAGES = [
  { platform: 'xiaohongshu', label: '小红书' },
  { platform: 'douyin', label: '抖音' },
];
const WECHAT_PATROL_STAGE = { platform: 'wechat_channels', label: '微信视频号' };
let patrolRunning = false;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-vb-token': TOKEN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  // 错误消息显示更久（6秒），成功消息显示3秒
  const duration = kind === 'bad' ? 6000 : 3200;
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const fmtBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 统一窗口格式与中文标签（与后端 filter.js 保持一致，单复数都解析为「最近 N 天」）。
const windowStr = (days) => `last_${Math.max(1, Number(days) || 1)}_days`;
const windowLabel = (wt) => { const m = String(wt).match(/last_(\d+)_days?/); return `最近 ${m ? m[1] : 1} 天`; };
function localScreenshotUrl(path) {
  const raw = String(path || '').trim().replace(/\\/g, '/');
  const name = raw.split('/').filter(Boolean).pop();
  return name ? `/screenshots/${encodeURIComponent(name)}` : '';
}
function itemMediaSources(it) {
  const shot = localScreenshotUrl(it.screenshot_path);
  const cover = String(it.cover_url || '').trim();
  const preferred = it.platform === 'xiaohongshu'
    ? [cover, shot]
    : (it.content_type === 'video' ? [shot, cover] : [cover, shot]);
  const seen = new Set();
  return preferred.filter((src) => {
    if (!src || seen.has(src)) return false;
    seen.add(src);
    return true;
  });
}
function mediaPreviewHtml(it) {
  const sources = itemMediaSources(it);
  if (sources.length === 0) return '<div class="shot"></div>';
  const fallback = sources[1] ? ` data-fallback-src="${esc(sources[1])}"` : '';
  return `<img class="shot" src="${esc(sources[0])}"${fallback} alt="封面或截图" />`;
}
function bindMediaFallbacks(root) {
  $$('img.shot', root).forEach((img) => {
    img.addEventListener('error', () => {
      const fallback = img.dataset.fallbackSrc || '';
      if (fallback && img.dataset.fallbackTried !== '1') {
        img.dataset.fallbackTried = '1';
        img.src = fallback;
        return;
      }
      const placeholder = document.createElement('div');
      placeholder.className = 'shot';
      img.replaceWith(placeholder);
    });
  });
}

function askConfirm(message, { okText = '确认', cancelText = '取消' } = {}) {
  const dialog = $('#confirmDialog');
  if (!dialog) return Promise.resolve(window.confirm(message));
  const msg = $('#confirmMessage');
  const ok = $('#confirmOk');
  const cancel = $('#confirmCancel');
  msg.textContent = message;
  ok.textContent = okText;
  cancel.textContent = cancelText;
  dialog.classList.remove('hidden');
  ok.focus();

  return new Promise((resolve) => {
    const cleanup = (value) => {
      dialog.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === dialog) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

async function getAccountsCache(force = false) {
  if (force || accountsCache.length === 0) accountsCache = await api('/accounts');
  return accountsCache;
}

// ---------------------------------------------------------------- tabs ----
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $$('.tab').forEach((t) => t.classList.add('hidden'));
  $(`#tab-${b.dataset.tab}`).classList.remove('hidden');
  loaders[b.dataset.tab]?.();
}));

// ---------------------------------------------------------------- overview ----
async function loadOverview() {
  const s = await api('/stats');
  const c = s.counts || {};
  const cards = [
    ['confirmed', '已入选/可入榜', 'ok'],
    ['needs_review', '待复核', 'warn'],
    ['missing_share', '缺转发数', 'warn'],
    ['below_threshold', '未达阈值', ''],
    ['duplicate', '重复', ''],
  ].map(([k, label, cls]) => `<div class="statcard ${cls}"><div class="n">${c[k] || 0}</div><div class="l">${label}</div></div>`);
  cards.push(`<div class="statcard"><div class="n">${fmt(s.usage.total)}</div><div class="l">今日 token（缓存 ${fmt(s.usage.cached)}）</div></div>`);
  $('#statCards').innerHTML = cards.join('');
  const candCount = $('#candCount');
  if (candCount) candCount.textContent = (c.needs_review || 0) + (c.missing_share || 0) + (c.missing_like || 0) || '';
  renderKeyState(s.hasApiKey, s.schedule);
}
function renderKeyState(hasKey, schedule) {
  const sch = schedule?.enabled ? `自动 ${schedule.time}` : '自动关';
  $('#keyState').innerHTML = `API Key：<b class="${hasKey ? 'on' : 'off'}">${hasKey ? '已配置' : '未配置'}</b> ｜ ${sch}`;
}

async function getDefaultWindowType() {
  const c = await api('/settings');
  return c.schedule?.window || 'last_1_day';
}

$('#ovGenerate').addEventListener('click', async () => {
  const skipRpa = !$('#ovAutoCollect').checked;
  try {
    await generateReport(await getDefaultWindowType(), $('#ovGenMsg'), skipRpa, {
      button: $('#ovGenerate'),
      reportType: 'web',
      reportLabel: '网页日报',
      patrolStages: WEB_PATROL_STAGES,
    });
  } catch (e) {
    toast('生成失败：' + e.message, 'bad');
  }
});

$('#ovRunWechatPatrol').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '巡检中...';
  const progressEl = $('#ovProgress');
  const progressText = $('#ovProgressText');
  $('#ovWechatMsg').textContent = '';
  if (progressEl) progressEl.style.display = 'block';
  if (progressText) progressText.textContent = '正在巡检微信视频号账号...';
  try {
    setPatrolRunning(true, btn);
    const res = await runPatrolStages(progressText, {
      includePatrolledToday: true,
      stages: [WECHAT_PATROL_STAGE],
    });
    const detail = `巡检账号 ${res.total || 0} 个，新增 ${res.newItems || 0} 条，今日跳过 ${res.skippedToday || 0} 个`;
    $('#ovWechatMsg').textContent = `${res.stopped ? '已停止' : '完成'}：${detail}`;
    toast(`${res.stopped ? '微信视频号巡检已停止' : '微信视频号巡检完成'}：${detail}`, res.stopped ? '' : 'ok');
    loadCandidates();
    loadOverview();
  } catch (err) {
    $('#ovWechatMsg').textContent = '巡检失败：' + err.message;
    toast('微信巡检失败：' + err.message, 'bad');
  } finally {
    if (progressEl) progressEl.style.display = 'none';
    setPatrolRunning(false);
    btn.disabled = false;
    btn.textContent = '巡检微信视频号';
  }
});

$('#ovGenerateWechat').addEventListener('click', async () => {
  try {
    await generateReport(await getDefaultWindowType(), $('#ovWechatMsg'), true, {
      button: $('#ovGenerateWechat'),
      reportType: 'wechat',
      reportLabel: '微信日报',
    });
  } catch (e) {
    toast('生成失败：' + e.message, 'bad');
  }
});

async function stopPatrol() {
  try {
    await api('/patrol/stop', { method: 'POST' });
    toast('已请求停止巡检，正在收尾关闭标签页...', 'ok');
  } catch (e) {
    toast('停止请求失败：' + e.message, 'bad');
  }
}

$('#ovStopPatrol').addEventListener('click', stopPatrol);
$('#candStopRpa').addEventListener('click', stopPatrol);

function setPatrolRunning(running, primaryButton = null) {
  patrolRunning = running;
  $('#ovStopPatrol').disabled = !running;
  $('#candStopRpa').disabled = !running;
  if (primaryButton) primaryButton.disabled = running;
}

function mergePatrolSummary(summary, res) {
  for (const key of ['total', 'success', 'failed', 'newItems', 'duplicates', 'discovered', 'skippedToday']) {
    summary[key] += Number(res?.[key] || 0);
  }
  summary.stopped ||= !!res?.stopped;
  summary.maxTabsPerBatch ||= res?.maxTabsPerBatch || res?.maxTabsPerPlatform || 0;
  return summary;
}

async function runPatrolStages(progressText = null, options = {}) {
  const includePatrolledToday = options.includePatrolledToday === true;
  const stages = Array.isArray(options.stages) && options.stages.length ? options.stages : WEB_PATROL_STAGES;
  const summary = { total: 0, success: 0, failed: 0, newItems: 0, duplicates: 0, discovered: 0, skippedToday: 0, stopped: false, maxTabsPerBatch: 0 };
  const cfg = await api('/settings');
  const wechatVideosPerAccount = cfg.rpa?.wechatVideosPerAccount || 3;
  for (const stage of stages) {
    if (progressText) progressText.textContent = `正在巡检${stage.label}账号...`;
    const res = await api('/patrol/run', {
      method: 'POST',
      body: JSON.stringify({ platform: stage.platform, includePatrolledToday, wechatVideosPerAccount }),
    });
    if (res.error) throw new Error(res.error);
    mergePatrolSummary(summary, res);
    if (res.stopped) break;
  }
  return summary;
}

async function generateReport(win, msgEl, skipRpa = false, options = {}) {
  const progressEl = Object.hasOwn(options, 'progressEl') ? options.progressEl : $('#ovProgress');
  const progressText = Object.hasOwn(options, 'progressText') ? options.progressText : $('#ovProgressText');
  const btn = options.button || $('#ovGenerate');
  const reportType = options.reportType === 'wechat' ? 'wechat' : 'web';
  const reportLabel = options.reportLabel || (reportType === 'wechat' ? '微信日报' : '日报');

  if (btn) btn.disabled = true;
  if (progressEl) progressEl.style.display = 'block';

  if (progressText && skipRpa) {
    progressText.textContent = `正在分析已有数据并生成${reportLabel}...`;
  } else if (progressText) {
    progressText.textContent = reportType === 'wechat' ? '正在启动微信巡检...' : '正在启动浏览器，自动采集最新网页数据...';
  }
  msgEl.textContent = '';

  try {
    let patrolSummary = null;
    if (!skipRpa) {
      setPatrolRunning(true, btn);
      patrolSummary = await runPatrolStages(progressText, {
        includePatrolledToday: true,
        stages: options.patrolStages || WEB_PATROL_STAGES,
      });
      setPatrolRunning(false, btn);
      if (patrolSummary.stopped) {
        msgEl.textContent = '已停止巡检，未生成日报。';
        return;
      }
      if (progressText) progressText.textContent = `巡检完成，正在调用模型生成${reportLabel}...`;
    }
    const r = await api('/reports/generate', {
      method: 'POST',
      body: JSON.stringify({ window: win, skipRpa: true, reportType }),
    });

    if (progressEl) progressEl.style.display = 'none';

    if (r.error) {
      toast('生成失败：' + r.error, 'bad');
      return;
    }

    let detail = `${reportType === 'wechat' ? '内容' : '达标'} ${r.eligibleCount} 条`;
    if (patrolSummary) {
      detail += ` | 巡检账号 ${patrolSummary.total}, 新增 ${patrolSummary.newItems}, 去重 ${patrolSummary.duplicates}, 今日跳过 ${patrolSummary.skippedToday}`;
    } else if (r.patrolResult) {
      detail += ` | 巡检账号 ${r.patrolResult.total || 0}, 采集新增 ${r.patrolResult.newItems}, 去重 ${r.patrolResult.duplicates}`;
    } else if (r.rpaError) {
      detail += ` | RPA 未完成：${r.rpaError}`;
    }
    if (!r.aiUsed) detail += '（0 条，未调用 AI）';
    msgEl.textContent = `完成：${detail}`;
    toast(`${reportLabel}已生成`, 'ok');
    loadReports();
    loadOverview();
    loadCandidates();
  } catch (e) {
    if (progressEl) progressEl.style.display = 'none';
    toast('生成失败：' + e.message, 'bad');
  } finally {
    setPatrolRunning(false);
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- candidates ----
let candFocusIdx = -1; // 当前键盘聚焦的卡片索引

async function loadCandidates() {
  const accounts = await getAccountsCache();
  const all = [];
  for (const st of ['confirmed', 'needs_review', 'missing_share', 'missing_favorite', 'missing_like', 'below_threshold', 'monitoring']) {
    const rows = await api(`/contents?status=${st}&today=1&include_observations=1`);
    all.push(...rows);
  }
  candFocusIdx = -1;
  const toolbar = $('#candToolbar');
  if (all.length > 0) {
    toolbar.style.display = 'flex';
    $('#candSelectedCount').textContent = '';
    $('#candSelectAll').checked = false;
  } else {
    toolbar.style.display = 'none';
  }
  $('#candList').innerHTML = all.length
    ? all.map((it, i) => itemCard(it, accounts, i)).join('')
    : '<p class="muted">今日暂无待处理内容。新抓取或重复补抓的内容会出现在这里，旧候选按北京时间自然清空。</p>';
  bindMediaFallbacks($('#candList'));
  bindItemCards($('#candList'));
  updateCandSelectedCount();
}

function accountOptions(it, accounts) {
  const rows = accounts.filter((a) => a.platform === it.platform);
  const opts = [`<option value="">未关联账号池（不入日报）</option>`];
  for (const a of rows) {
    const label = `${a.nickname}${a.category ? ` / ${a.category}` : ''}`;
    opts.push(`<option value="${esc(a.id)}" ${it.account_id === a.id ? 'selected' : ''}>${esc(label)}</option>`);
  }
  return opts.join('');
}

function itemCard(it, accounts, idx) {
  const shot = mediaPreviewHtml(it);
  
  let obsHtml = '';
  if (it.observation) {
    const obs = it.observation;
    const confidencePct = (obs.confidence * 100).toFixed(0);
    obsHtml = `
      <div class="obs-box">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="font-weight: 700; color: var(--brand-strong); font-size: 12px; display: flex; align-items: center; gap: 4px;">🤖 视觉观察报告</span>
          <span style="font-size: 11px; background: rgba(var(--brand-rgb),0.12); color: var(--brand-strong); padding: 2px 8px; border-radius: 999px; font-weight: 600;">置信度 ${confidencePct}%</span>
        </div>
        <div style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.5;">
          <div><strong>当前行为:</strong> <span style="color: var(--text);">${esc(obs.observed_activity)}</span></div>
          <div style="display: flex; gap: 12px; margin-top: 4px;">
            <span><strong>内容母题:</strong> <span style="color: var(--text);">${esc(obs.topic_category || '—')}</span></span>
            <span><strong>画面场景:</strong> <span style="color: var(--text);">${esc(obs.scene || '—')}</span></span>
          </div>
          <div class="obs-details-toggle" style="margin-top: 6px; border-top: 1px dashed var(--border-strong); padding-top: 6px;">
            <button type="button" class="text-btn obs-expand-btn" style="background:none; border:none; box-shadow:none; padding:0; color:var(--brand-strong); font-size:11px; cursor:pointer; font-weight:600; display:flex; align-items:center; gap:2px;">🔍 展开完整视觉详情 →</button>
            <div class="obs-details" style="margin-top: 6px; display: none; flex-direction: column; gap: 4px;">
              <div><strong>人物与道具:</strong> <span style="color: var(--text);">${esc(obs.people_objects || '—')}</span></div>
              <div><strong>屏幕文字:</strong> <span style="color: var(--text);">${esc(obs.text_on_screen || '—')}</span></div>
              <div><strong>引导行为 (CTA):</strong> <span style="color: var(--text);">${esc(obs.call_to_action || '—')}</span></div>
              <div><strong>视觉推导依据:</strong> <span style="color: var(--text);">${esc(obs.evidence_notes || '—')}</span></div>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">由 AI 视觉模型 ${esc(obs.model)} 识别并永久缓存</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  return `<div class="item" data-id="${it.id}" data-cidx="${idx}" tabindex="0">
    <div style="display:flex;align-items:flex-start;padding:2px 0 0 0">
      <input type="checkbox" class="cand-cb" data-id="${it.id}" style="margin:4px 8px 0 0;transform:scale(1.2)" />
    </div>
    ${shot}
    <div class="body">
      <div class="t">${esc(it.title) || '(无标题)'} <span class="badge ${it.data_status}">${STATUS_LABEL[it.data_status] || it.data_status}</span></div>
      <div class="sub">${PLATFORM_LABEL[it.platform] || it.platform} ｜ ${esc(it.author_name) || '未知作者'} ｜ 采集来源：${esc(it.metrics_source)}${it.duration_text ? ` ｜ 时长 ${esc(it.duration_text)}` : ''}${it.url ? ` ｜ <a href="${esc(it.url)}" target="_blank" rel="noreferrer">原链接</a>` : ''}</div>
      <div class="metricgrid">
        <label>点赞<input type="number" data-f="like_count" value="${it.like_count ?? ''}" placeholder="${esc(it.like_raw || '')}" /></label>
        <label>转发/分享<input type="number" data-f="share_count" value="${it.share_count ?? ''}" placeholder="${esc(it.share_raw || '')}" /></label>
        <label>评论<input type="number" data-f="comment_count" value="${it.comment_count ?? ''}" /></label>
        <label>收藏<input type="number" data-f="favorite_count" value="${it.favorite_count ?? ''}" /></label>
        <label>类型<select data-f="content_type"><option value="video" ${it.content_type === 'video' ? 'selected' : ''}>视频</option><option value="article" ${it.content_type === 'article' ? 'selected' : ''}>图文/文章</option></select></label>
        <label>账号池<select data-f="account_id">${accountOptions(it, accounts)}</select></label>
      </div>
      <div class="row" style="margin:6px 0 0">
        <label style="flex-direction:row;align-items:center;gap:6px">发布时间 <input type="date" data-f="publish_time" value="${it.publish_time ? it.publish_time.slice(0, 10) : ''}" /></label>
      </div>
      ${obsHtml}
      <div class="actions">
        <button class="primary" data-act="confirm">确认入库</button>
        <button data-act="archive">归档</button>
        <button class="danger" data-act="delete">删除</button>
      </div>
    </div>
  </div>`;
}

function collectCardData(card) {
  const o = {};
  $$('[data-f]', card).forEach((inp) => {
    const f = inp.dataset.f;
    if (f.endsWith('_count')) o[f] = inp.value === '' ? '' : inp.value;
    else o[f] = inp.value;
  });
  return o;
}

function updateCandSelectedCount() {
  const cbs = $$('.cand-cb');
  const checked = $$('.cand-cb:checked');
  const el = $('#candSelectedCount');
  if (el) el.textContent = checked.length > 0 ? `已选 ${checked.length} / ${cbs.length}` : `共 ${cbs.length} 条`;
}

function focusCandCard(idx) {
  const cards = $$('#candList .item');
  if (cards.length === 0) return;
  // 移除旧 focus 样式
  cards.forEach(c => c.style.outline = '');
  idx = Math.max(0, Math.min(idx, cards.length - 1));
  candFocusIdx = idx;
  const card = cards[idx];
  card.style.outline = '2px solid var(--brand)';
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function bindItemCards(root) {
  $$('.item', root).forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-act="confirm"]').addEventListener('click', async () => {
      try {
        const c = await api(`/contents/${id}/confirm`, { method: 'POST', body: JSON.stringify(collectCardData(card)) });
        toast(`已确认：${STATUS_LABEL[c.data_status] || c.data_status}`, c.data_status === 'confirmed' ? 'ok' : '');
        loadCandidates(); loadOverview();
      } catch (e) { toast('确认失败：' + e.message, 'bad'); }
    });
    card.querySelector('[data-act="archive"]').addEventListener('click', async () => {
      await api(`/contents/${id}/archive`, { method: 'POST' }); toast('已归档'); loadCandidates(); loadOverview();
    });
    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!(await askConfirm('确认删除这条内容？', { okText: '删除' }))) return;
      await api(`/contents/${id}`, { method: 'DELETE' }); toast('已删除'); loadCandidates(); loadOverview();
    });

    // 绑定视觉观察详情展开/折叠
    const toggleBtn = card.querySelector('.obs-expand-btn');
    const detailsDiv = card.querySelector('.obs-details');
    if (toggleBtn && detailsDiv) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = detailsDiv.style.display === 'none';
        detailsDiv.style.display = isHidden ? 'flex' : 'none';
        toggleBtn.textContent = isHidden ? '▼ 收起视觉详情' : '🔍 展开完整视觉详情 →';
      });
    }
  });
  // 复选框变更 → 更新计数
  $$('.cand-cb', root).forEach(cb => cb.addEventListener('change', updateCandSelectedCount));
}

// 全选
$('#candSelectAll').addEventListener('change', (e) => {
  $$('.cand-cb').forEach(cb => cb.checked = e.target.checked);
  updateCandSelectedCount();
});

// 批量确认
$('#candBatchConfirm').addEventListener('click', async () => {
  const checked = $$('.cand-cb:checked');
  if (checked.length === 0) return toast('请先勾选要确认的内容', 'bad');
  if (!(await askConfirm(`确认批量确认 ${checked.length} 条内容？`))) return;
  let ok = 0;
  for (const cb of checked) {
    const card = cb.closest('.item');
    try {
      await api(`/contents/${card.dataset.id}/confirm`, { method: 'POST', body: JSON.stringify(collectCardData(card)) });
      ok++;
    } catch (e) { console.error('批量确认失败:', e); }
  }
  toast(`已确认 ${ok} 条`, 'ok');
  loadCandidates(); loadOverview();
});

// 网页内容自动巡检
$('#candRunRpa').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '巡检中...';
  try {
    setPatrolRunning(true, btn);
    toast('正在巡检网页内容：小红书/抖音使用 Chrome...', 'ok');
    const res = await runPatrolStages(null, { includePatrolledToday: true });
    const tabInfo = res.maxTabsPerBatch ? `，每轮 ${res.maxTabsPerBatch} 个账号标签` : '';
    toast(`${res.stopped ? '网页巡检已停止' : '网页巡检完成'}：巡检账号 ${res.total || 0} 个，新增 ${res.newItems || 0} 条，今日跳过 ${res.skippedToday || 0} 个${tabInfo}`, res.stopped ? '' : 'ok');
    loadCandidates();
    loadOverview();
  } catch (err) {
    toast('自动巡检失败: ' + err.message, 'bad');
  } finally {
    setPatrolRunning(false);
    btn.disabled = false;
    btn.textContent = '巡检网页内容';
  }
});

// 粘贴链接抓取
async function runIngest() {
  const url = $('#ingestUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('请粘贴合法的 http(s) 链接', 'bad');
  $('#ingestBtn').disabled = true;
  $('#ingestMsg').textContent = '抓取中…（服务端请求该页面，约数秒）';
  try {
    const r = await api('/ingest', { method: 'POST', body: JSON.stringify({ url }) });
    if (!r.ok) { $('#ingestMsg').textContent = '抓取失败：' + (r.note || '未知原因'); toast('抓取失败', 'bad'); return; }
    const got = (r.found || []).length;
    $('#ingestMsg').textContent = `已入库（${STATUS_LABEL[r.status] || r.status}）：${r.title || '(无标题)'} ｜ 抓到 ${got} 项指标。${r.note || ''}`;
    $('#ingestUrl').value = '';
    toast(got ? `抓到 ${got} 项，去下方核对确认` : '已带回标题，指标需手填', got ? 'ok' : '');
    loadCandidates(); loadOverview();
  } catch (e) {
    $('#ingestMsg').textContent = '抓取失败：' + e.message;
    toast('抓取失败：' + e.message, 'bad');
  } finally {
    $('#ingestBtn').disabled = false;
  }
}
$('#ingestBtn').addEventListener('click', runIngest);
$('#ingestUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') runIngest(); });

// 批量归档
$('#candBatchArchive').addEventListener('click', async () => {
  const checked = $$('.cand-cb:checked');
  if (checked.length === 0) return toast('请先勾选要归档的内容', 'bad');
  if (!(await askConfirm(`确认批量归档 ${checked.length} 条内容？`))) return;
  let ok = 0;
  for (const cb of checked) {
    const card = cb.closest('.item');
    try {
      await api(`/contents/${card.dataset.id}/archive`, { method: 'POST' });
      ok++;
    } catch (e) { console.error('批量归档失败:', e); }
  }
  toast(`已归档 ${ok} 条`, 'ok');
  loadCandidates(); loadOverview();
});

// 键盘快捷键（仅在候选池 tab 激活时生效）
document.addEventListener('keydown', (e) => {
  // 如果焦点在 input/select/textarea 中，不拦截（让用户正常输入）
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  // 候选池现在位于概览页下方，仅概览可见时启用。
  if ($('#tab-overview')?.classList.contains('hidden')) return;

  const cards = $$('#candList .item');
  if (cards.length === 0) return;

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    focusCandCard(candFocusIdx + 1);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    focusCandCard(candFocusIdx - 1);
  } else if (e.key === 'Enter' && candFocusIdx >= 0) {
    e.preventDefault();
    const card = cards[candFocusIdx];
    card?.querySelector('[data-act="confirm"]')?.click();
  } else if (e.key === 'Escape') {
    candFocusIdx = -1;
    cards.forEach(c => c.style.outline = '');
  } else if (e.key === ' ' && candFocusIdx >= 0) {
    e.preventDefault();
    const cb = cards[candFocusIdx]?.querySelector('.cand-cb');
    if (cb) { cb.checked = !cb.checked; updateCandSelectedCount(); }
  }
});

// ---------------------------------------------------------------- library ----
async function loadLibrary() {
  const q = encodeURIComponent($('#libQ').value || '');
  const status = $('#libStatus').value;
  const platform = $('#libPlatform').value;
  const rows = await api(`/contents?q=${q}&status=${status}&platform=${platform}`);
  $('#libTable').innerHTML = rows.length ? `
    <table><thead><tr>
      <th>状态</th><th>平台</th><th>作者</th><th>标题</th><th>点赞</th><th>转发</th><th>收藏</th><th>入选原因</th><th>证据</th><th>发布</th><th>操作</th>
    </tr></thead><tbody>
    ${rows.map((it) => `<tr>
      <td><span class="badge ${it.data_status}">${STATUS_LABEL[it.data_status] || it.data_status}</span></td>
      <td>${PLATFORM_LABEL[it.platform] || it.platform}</td>
      <td>${esc(it.author_name)}</td>
      <td>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noreferrer">${esc(it.title) || '(无标题)'}</a>` : esc(it.title)}</td>
      <td class="num">${fmt(it.like_count)}</td>
      <td class="num">${fmt(it.share_count)}</td>
      <td class="num">${fmt(it.favorite_count)}</td>
      <td>${esc(it.eligible_reason || '—')}</td>
      <td>${esc(it.metrics_confidence || it.metrics_source || '—')}</td>
      <td>${it.publish_time ? it.publish_time.slice(0, 10) : '—'}</td>
      <td><button data-del="${it.id}">删除</button></td>
    </tr>`).join('')}
    </tbody></table>` : '<p class="muted">没有匹配的内容。</p>';
  $$('#libTable [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await askConfirm('删除这条内容？', { okText: '删除' }))) return;
    await api(`/contents/${b.dataset.del}`, { method: 'DELETE' }); loadLibrary(); loadOverview();
  }));
}
['libRefresh'].forEach((id) => $(`#${id}`).addEventListener('click', loadLibrary));
['libQ'].forEach((id) => $(`#${id}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLibrary(); }));
['libStatus', 'libPlatform'].forEach((id) => $(`#${id}`).addEventListener('change', loadLibrary));

// ---------------------------------------------------------------- accounts ----
async function loadAccounts() {
  const rows = await getAccountsCache(true);
  const platformOpts = (sel) => ACCOUNT_FORM_PLATFORMS.map(
    p => `<option value="${p}" ${p===sel?'selected':''}>${PLATFORM_LABEL[p]||p}</option>`
  ).join('');
  const prioOpts = (sel) => ['S','A','B'].map(
    p => `<option ${p===sel?'selected':''}>${p}</option>`
  ).join('');
  $('#acTable').innerHTML = rows.length ? `
    <table class="ac-table"><thead><tr>
      <th class="col-chk">巡检</th><th class="col-plat">平台</th><th class="col-nick">昵称</th>
      <th class="col-src">来源</th><th class="col-meta">最近发现</th><th class="col-meta">最近巡检</th>
      <th class="col-cat">分类</th><th class="col-prio">优先级</th><th class="col-url">主页链接</th><th class="col-act"></th>
    </tr></thead><tbody>
    ${rows.map((a) => `<tr data-acid="${a.id}">
      <td class="col-chk"><input type="checkbox" data-af="monitor_enabled" ${a.monitor_enabled ? 'checked' : ''} /></td>
      <td class="col-plat"><select data-af="platform">${platformOpts(a.platform)}</select></td>
      <td class="col-nick"><input data-af="nickname" value="${esc(a.nickname)}" /></td>
      <td class="col-src"><span class="src-tag">${esc(a.discovery_source || '手动')}</span></td>
      <td class="col-meta">${a.last_discovered_at ? esc(a.last_discovered_at.slice(0, 10)) : '—'}</td>
      <td class="col-meta">${a.last_patrolled_at ? esc(a.last_patrolled_at.slice(0, 10)) : '—'}</td>
      <td class="col-cat"><input data-af="category" value="${esc(a.category || '')}" placeholder="未分类" /></td>
      <td class="col-prio"><select data-af="priority">${prioOpts(a.priority||'B')}</select></td>
      <td class="col-url"><input data-af="homepage_url" value="${esc(a.homepage_url || '')}" placeholder="粘贴主页链接" /></td>
      <td class="col-act">
        <button data-save="${a.id}">保存</button>
        <button data-del="${a.id}" class="danger">删除</button>
      </td>
    </tr>`).join('')}
    </tbody></table>` : '<p class="muted">还没有账号。用上方「手动填写」或「搜索填空」添加。</p>';
  $$('#acTable [data-save]').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    const val = (f) => row.querySelector(`[data-af="${f}"]`).value;
    const checked = (f) => row.querySelector(`[data-af="${f}"]`).checked;
    await api(`/accounts`, {
      method: 'POST',
      body: JSON.stringify({
        id: b.dataset.save,
        platform: val('platform'),
        nickname: val('nickname').trim(),
        homepage_url: val('homepage_url').trim(),
        category: val('category').trim(),
        priority: val('priority'),
        monitor_enabled: checked('monitor_enabled'),
      })
    });
    accountsCache = [];
    toast('已保存', 'ok');
  }));
  $$('#acTable [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await askConfirm('删除该账号？', { okText: '删除' }))) return;
    await api(`/accounts/${b.dataset.del}`, { method: 'DELETE' });
    accountsCache = [];
    loadAccounts();
  }));
}
// 方式一「手动填写」：固定字段逐项填，系统给格式，用户不用自己排版。
$('#acAdd').addEventListener('click', async () => {
  const body = {
    platform: $('#acPlatform').value,
    nickname: $('#acNick').value.trim(),
    homepage_url: $('#acUrl').value.trim(),
    category: $('#acCategory').value.trim(),
    priority: $('#acPriority').value,
    monitor_enabled: true,
  };
  if (!body.nickname) return toast('请填写昵称', 'bad');
  await api('/accounts', { method: 'POST', body: JSON.stringify(body) });
  $('#acNick').value = ''; $('#acUrl').value = ''; $('#acCategory').value = '';
  accountsCache = [];
  toast('已添加', 'ok'); loadAccounts();
});

$('#acDiscoverFollows').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '发现中...';
  try {
    const res = await api('/follows/discover', { method: 'POST', body: JSON.stringify({ platforms: ['xiaohongshu', 'douyin'] }) });
    toast(`已发现 ${res.discovered || 0} 个关注账号`, 'ok');
    accountsCache = [];
    loadAccounts();
  } catch (err) {
    toast('发现失败: ' + err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '发现关注账号';
  }
});

$('#acOpenXhsLinks').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '打开中...';
  try {
    accountsCache = [];
    const res = await api('/accounts/open-platform', {
      method: 'POST',
      body: JSON.stringify({ platform: 'xiaohongshu' }),
    });
    const skipped = res.skippedCount ? `，跳过 ${res.skippedCount} 个无效链接` : '';
    const kind = res.openedCount > 0 ? 'ok' : 'bad';
    toast(`已在 Chrome 同时打开 ${res.openedCount || 0} 个小红书主页${skipped}`, kind);
  } catch (err) {
    toast('打开失败: ' + err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '打开全部小红书主页';
  }
});

// 搜索链接是确定性拼接（与 server/lib/platform-links.js 一致），不经过 AI，绝不给死链。
function platformSearchUrl(platform, nickname) {
  const q = encodeURIComponent(String(nickname || '').trim());
  if (!q) return '';
  switch (platform) {
    case 'douyin': return `https://www.douyin.com/search/${q}?type=user`;
    case 'xiaohongshu': return `https://www.xiaohongshu.com/search_result?keyword=${q}`;
    default: return `https://www.google.com/search?q=${q}`;
  }
}

function fallbackAccountSearchLinks(nickname) {
  const name = String(nickname || '').trim();
  if (!name) return [];
  return ACCOUNT_SEARCH_PLATFORMS.map((platform) => ({
    platform,
    nickname: name,
    homepage_url: '',
    search_url: platformSearchUrl(platform, name),
    link_verified: false,
  }));
}

async function openPlatformUrl(url) {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) {
    toast('未生成搜索链接，请检查平台和昵称', 'bad');
    return false;
  }
  try {
    await api('/browser/open', { method: 'POST', body: JSON.stringify({ url: targetUrl }) });
    toast('已在 Chrome 打开平台页面', 'ok');
    return true;
  } catch (err) {
    toast('打开失败: ' + err.message, 'bad');
    return false;
  }
}

function bindAccountOpenButtons(root = document) {
  $$('[data-ac-open-url]', root).forEach((b) => b.addEventListener('click', async () => {
    await openPlatformUrl(b.dataset.acOpenUrl);
  }));
}

// 右侧「搜索填空」运行在工作台窗口里；平台页统一交给已登录 Chrome 打开。
function syncSearchJumpLink() {
  const p = $('#acSearchPlatform').value;
  const nick = $('#acSearchNick').value.trim();
  const link = $('#acSearchJump');
  const url = platformSearchUrl(p, nick);
  link.textContent = `打开${PLATFORM_LABEL[p] || '平台'}搜索`;
  link.dataset.acOpenUrl = url;
  link.disabled = !url;
}
$('#acSearchPlatform').addEventListener('change', syncSearchJumpLink);
$('#acSearchNick').addEventListener('input', syncSearchJumpLink);
syncSearchJumpLink();

$('#acSearchJump').addEventListener('click', async (e) => {
  e.preventDefault();
  const nick = $('#acSearchNick').value.trim();
  if (!nick) {
    return toast('请先输入昵称或关键词', 'bad');
  }
  const url = $('#acSearchJump').dataset.acOpenUrl || platformSearchUrl($('#acSearchPlatform').value, nick);
  if (!url) {
    return toast('未生成搜索链接，请检查平台和昵称', 'bad');
  }
  const opened = await openPlatformUrl(url);
  if (opened) $('#acSearchHint').textContent = '已在 Chrome 打开搜索页 → 找到本人后，复制其主页链接粘贴到上方，再点「添加到账号池」。';
});

function normalizeAccountSuggestion(item, fallbackNickname = '') {
  const platform = item?.platform || 'other';
  const nickname = String(item?.nickname || fallbackNickname || '').trim();
  return {
    platform,
    nickname,
    homepage_url: String(item?.homepage_url || '').trim(),
    search_url: String(item?.search_url || platformSearchUrl(platform, nickname) || '').trim(),
    category: String(item?.category || '').trim(),
    priority: ['S', 'A', 'B'].includes(item?.priority) ? item.priority : 'B',
    monitor_enabled: item?.monitor_enabled !== false,
    description: String(item?.description || '').trim(),
    link_verified: item?.link_verified === true,
  };
}

function accountSuggestionUrl(item) {
  return item.homepage_url || item.search_url || platformSearchUrl(item.platform, item.nickname);
}

function renderAiAccountResults(data = {}, query = '', error = '') {
  const shortcuts = (Array.isArray(data.search_links) && data.search_links.length
    ? data.search_links
    : fallbackAccountSearchLinks(query)).map((item) => normalizeAccountSuggestion(item, query));
  accountSuggestionCache = (Array.isArray(data.suggestions) ? data.suggestions : [])
    .map((item) => normalizeAccountSuggestion(item, query))
    .filter((item) => ACCOUNT_SEARCH_PLATFORMS.includes(item.platform) && item.nickname);

  const shortcutHtml = shortcuts.length ? `
    <div class="ac-ai-shortcuts">
      ${shortcuts.map((item) => `<button type="button" class="filebtn" data-ac-open-url="${esc(accountSuggestionUrl(item))}">打开${esc(PLATFORM_LABEL[item.platform] || item.platform)}搜索</button>`).join('')}
    </div>` : '';

  const suggestionsHtml = accountSuggestionCache.length
    ? accountSuggestionCache.map((item, idx) => {
      const label = PLATFORM_LABEL[item.platform] || item.platform;
      const openUrl = accountSuggestionUrl(item);
      const openText = item.link_verified ? '打开主页' : `打开${label}搜索`;
      const meta = [label, item.category || '未分类', item.priority].filter(Boolean).join(' ｜ ');
      return `
        <div class="ac-ai-item">
          <div class="ac-ai-title">${esc(item.nickname)}</div>
          <div class="muted">${esc(meta)}${item.description ? ` ｜ ${esc(item.description)}` : ''}</div>
          <div class="ac-ai-actions">
            ${openUrl ? `<button type="button" class="filebtn" data-ac-open-url="${esc(openUrl)}">${esc(openText)}</button>` : ''}
            <button data-ac-ai-fill="${idx}">填到搜索填空</button>
            <button class="primary" data-ac-ai-add="${idx}">添加到账号池</button>
          </div>
        </div>`;
    }).join('')
    : `<p class="muted">${error ? 'AI 搜索暂不可用，先用上方平台搜索链接定位。' : 'AI 没有返回候选，先用上方平台搜索链接定位。'}</p>`;

  $('#acAiResults').innerHTML = `
    ${error ? `<p class="muted">AI 搜索失败：${esc(error)}</p>` : ''}
    ${shortcutHtml}
    ${suggestionsHtml}`;

  bindAccountOpenButtons($('#acAiResults'));

  $$('#acAiResults [data-ac-ai-fill]').forEach((b) => b.addEventListener('click', () => {
    const item = accountSuggestionCache[Number(b.dataset.acAiFill)];
    if (!item) return;
    $('#acSearchPlatform').value = item.platform;
    $('#acSearchNick').value = item.nickname;
    $('#acSearchUrl').value = item.homepage_url;
    syncSearchJumpLink();
    $('#acSearchHint').textContent = item.homepage_url
      ? '已填入真实主页链接，可直接添加到账号池。'
      : '已填入昵称；点左侧平台搜索链接找到本人主页后再回填。';
  }));

  $$('#acAiResults [data-ac-ai-add]').forEach((b) => b.addEventListener('click', async () => {
    const item = accountSuggestionCache[Number(b.dataset.acAiAdd)];
    if (!item) return;
    await api('/accounts', {
      method: 'POST',
      body: JSON.stringify({
        platform: item.platform,
        nickname: item.nickname,
        homepage_url: item.homepage_url,
        category: item.category,
        priority: item.priority,
        monitor_enabled: item.monitor_enabled,
      }),
    });
    accountsCache = [];
    toast('已添加', 'ok');
    loadAccounts();
  }));
}

$('#acAiQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#acAiSearch').click();
});

$('#acAiSearch').addEventListener('click', async (e) => {
  const q = $('#acAiQuery').value.trim();
  if (!q) return toast('请先输入要搜索的名称', 'bad');
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '搜索中...';
  renderAiAccountResults({ search_links: fallbackAccountSearchLinks(q), suggestions: [] }, q);
  try {
    const data = await api('/accounts/search-suggest', { method: 'POST', body: JSON.stringify({ q }) });
    renderAiAccountResults(data, q);
  } catch (err) {
    renderAiAccountResults({ search_links: fallbackAccountSearchLinks(q), suggestions: [] }, q, err.message);
    toast('AI 搜索暂不可用，已显示平台搜索链接', 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 搜索';
  }
});

$('#acSearchAdd').addEventListener('click', async () => {
  const body = {
    platform: $('#acSearchPlatform').value,
    nickname: $('#acSearchNick').value.trim(),
    homepage_url: $('#acSearchUrl').value.trim(),
    category: '',
    priority: 'B',
    monitor_enabled: true,
  };
  if (!body.nickname) return toast('请填写昵称', 'bad');
  await api('/accounts', { method: 'POST', body: JSON.stringify(body) });
  $('#acSearchNick').value = ''; $('#acSearchUrl').value = '';
  $('#acSearchHint').textContent = '';
  accountsCache = [];
  toast('已添加', 'ok'); loadAccounts();
});

// ---------------------------------------------------------------- reports ----
let reportsCache = [];

function reportExportUrl(id, format, { inline = false } = {}) {
  const qs = new URLSearchParams({ format, token: TOKEN });
  if (inline) qs.set('inline', '1');
  return `/api/reports/${encodeURIComponent(id)}/export?${qs.toString()}`;
}

function closeReportPreview() {
  const viewer = $('#rpViewer');
  const frame = $('#rpViewerFrame');
  if (frame) frame.removeAttribute('src');
  if (viewer) viewer.classList.add('hidden');
}

async function showReportPreview(id) {
  const report = reportsCache.find((r) => r.id === id) || await api(`/reports/${encodeURIComponent(id)}`);
  const typeLabel = report.report_type === 'wechat' ? '微信日报' : '网页日报';
  const countLabel = report.report_type === 'wechat' ? '内容' : '达标';
  $('#rpViewerTitle').textContent = `${typeLabel} ｜ ${report.report_date} ｜ ${windowLabel(report.window_type)} ｜ ${countLabel} ${report.eligible_count} 条`;
  $('#rpViewerMeta').textContent = `生成于 ${new Date(report.created_at).toLocaleString('zh-CN')}`;
  $('#rpViewerFrame').src = reportExportUrl(id, 'html', { inline: true });
  $('#rpViewer').classList.remove('hidden');
  $('#rpViewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function revealReportExport(id, format, button) {
  const oldText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '打开中...';
  }
  try {
    await api(`/reports/${encodeURIComponent(id)}/reveal?format=${encodeURIComponent(format)}`, { method: 'POST' });
    toast('已在 Finder 显示导出文件', 'ok');
  } catch (e) {
    toast('打开导出文件失败：' + e.message, 'bad');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText;
    }
  }
}

async function loadReports() {
  const rows = await api('/reports');
  reportsCache = rows;
  $('#rpList').innerHTML = rows.length ? rows.map((r) => `
    <div class="item"><div class="body">
      <div class="t"><span class="badge ${r.report_type === 'wechat' ? 'wechat' : 'confirmed'}">${r.report_type === 'wechat' ? '微信日报' : '网页日报'}</span> ${r.report_date} ｜ ${windowLabel(r.window_type)} ｜ ${r.report_type === 'wechat' ? '内容' : '达标'} ${r.eligible_count} 条</div>
      <div class="sub">生成于 ${new Date(r.created_at).toLocaleString('zh-CN')}</div>
      <div class="actions">
        <button type="button" class="filebtn" data-rp-view="${esc(r.id)}">查看日报</button>
        <button type="button" class="filebtn" data-rp-reveal="${esc(r.id)}" data-rp-format="md">显示 Markdown</button>
        <button type="button" class="filebtn" data-rp-reveal="${esc(r.id)}" data-rp-format="csv">显示 CSV</button>
        ${r.export_zip_path ? `<button type="button" class="filebtn" data-rp-reveal="${esc(r.id)}" data-rp-format="zip">显示压缩包</button>` : ''}
        <button class="danger" data-rp-del="${r.id}">删除日报</button>
      </div>
    </div></div>`).join('') : '<p class="muted">还没有日报。点上方「生成日报」。</p>';
  $$('#rpList [data-rp-view]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await showReportPreview(b.dataset.rpView);
    } catch (e) {
      toast('查看日报失败：' + e.message, 'bad');
    }
  }));
  $$('#rpList [data-rp-reveal]').forEach((b) => b.addEventListener('click', async () => {
    await revealReportExport(b.dataset.rpReveal, b.dataset.rpFormat, b);
  }));
  $$('#rpList [data-rp-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await askConfirm('确认删除这份日报及其导出文件？', { okText: '删除日报' }))) return;
    try {
      const deletingVisibleReport = $('#rpViewerFrame')?.src?.includes(`/reports/${encodeURIComponent(b.dataset.rpDel)}/export`);
      await api(`/reports/${b.dataset.rpDel}`, { method: 'DELETE' });
      if (deletingVisibleReport) closeReportPreview();
      toast('日报已删除', 'ok');
    } catch (e) {
      toast('删除失败: ' + e.message, 'bad');
    }
    loadReports();
  }));
}
$('#rpViewerClose').addEventListener('click', closeReportPreview);
$('#rpGenerate').addEventListener('click', async () => {
  try {
    await generateReport(await getDefaultWindowType(), $('#rpMsg'), true, {
      button: $('#rpGenerate'),
      progressEl: null,
      progressText: null,
      reportType: 'web',
      reportLabel: '网页日报',
    });
  } catch (e) {
    toast('生成失败：' + e.message, 'bad');
  }
});

// ---------------------------------------------------------------- settings ----
// 供应商预设：选了就自动填 Base URL，并给模型名/获取 Key 的提示。
// 接口地址均为各家官方公开的 OpenAI/Anthropic 兼容地址（已核对）。
const VENDORS = {
  openai:      { name: 'OpenAI（官方）',        baseUrl: '',                                              models: ['gpt-4o-mini', 'gpt-4o'],                apply: 'https://platform.openai.com/api-keys' },
  deepseek:    { name: 'DeepSeek 深度求索',     baseUrl: 'https://api.deepseek.com',                      models: ['deepseek-chat', 'deepseek-reasoner'],   apply: 'https://platform.deepseek.com/api_keys' },
  xiaomi:      { name: '小米 MiMo',             baseUrl: 'https://api.xiaomimimo.com/v1',                 models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash'], apply: 'https://platform.xiaomimimo.com' },
  moonshot:    { name: '月之暗面 Kimi',         baseUrl: 'https://api.moonshot.cn/v1',                    models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2-0905-preview', 'moonshot-v1-8k'], apply: 'https://platform.moonshot.cn/console/api-keys' },
  zhipu:       { name: '智谱 GLM',              baseUrl: 'https://open.bigmodel.cn/api/paas/v4',          models: ['glm-4-flash', 'glm-4-plus'],            apply: 'https://open.bigmodel.cn/usercenter/apikeys' },
  qwen:        { name: '通义千问（阿里百炼）',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'], apply: 'https://bailian.console.aliyun.com/?apiKey=1' },
  siliconflow: { name: '硅基流动 SiliconFlow',  baseUrl: 'https://api.siliconflow.cn/v1',                 models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct'], apply: 'https://cloud.siliconflow.cn/account/ak' },
  anthropic:   { name: 'Anthropic Claude',      baseUrl: 'https://api.anthropic.com',                     models: ['claude-haiku-4-5', 'claude-sonnet-4-6'], apply: 'https://console.anthropic.com/settings/keys' },
  custom:      { name: '自定义', baseUrl: '', models: [], apply: '' },
};

function providerForVendor(vendorKey, baseUrl = '', apiKey = '') {
  const b = String(baseUrl || '').toLowerCase();
  if (vendorKey === 'anthropic' || apiKey.startsWith('sk-ant-') || b.includes('anthropic')) return 'anthropic';
  if (vendorKey === 'openai' || !b || b.includes('openai.com')) return 'openai';
  return 'openai-compatible';
}

function normalizeVendorBaseUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  b = b.replace(/\/chat\/completions$/i, '');
  b = b.replace(/\/v1\/messages$/i, '');
  return b;
}

/** 根据已保存的 baseUrl 反推选中哪个供应商（用于回填下拉框）。 */
function vendorFromBaseUrl(baseUrl) {
  const b = normalizeVendorBaseUrl(baseUrl);
  if (!b) return 'openai';
  if (['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'].includes(b)) return 'moonshot';
  for (const [key, v] of Object.entries(VENDORS)) {
    if (v.baseUrl && normalizeVendorBaseUrl(v.baseUrl) === b) return key;
  }
  return 'custom';
}

/** 应用某个供应商预设到表单（填 Base URL、模型示例、获取 Key 链接）。 */
function applyVendor(vendorKey, { overwriteModel = false } = {}) {
  const v = VENDORS[vendorKey] || VENDORS.custom;
  const isCustom = vendorKey === 'custom';
  $('#stBaseUrl').value = isCustom ? $('#stBaseUrl').value : v.baseUrl;
  $('#stBaseUrl').readOnly = !isCustom && vendorKey !== 'openai' ? false : false; // 始终允许编辑，仅自动填默认
  // 模型名：仅在用户没填或要求覆盖时给出第一个示例
  if ((overwriteModel || !$('#stModel').value.trim()) && v.models.length) {
    $('#stModel').value = v.models[0];
  }
  $('#modelHints').innerHTML = v.models.map((m) => `<option value="${m}">`).join('');
  const applyLink = v.apply ? ` ｜ <a href="${v.apply}" target="_blank" rel="noreferrer">获取 ${v.name} 的 Key →</a>` : '';
  const urlNote = isCustom ? '自定义：请手动填写接口地址（OpenAI 兼容则填到 /v1）。' : `已自动填入 ${v.name} 的接口地址。`;
  $('#stVendorHint').innerHTML = `${urlNote}粘贴对应平台的 Key 即可。${applyLink}`;
}

$('#stVendor').addEventListener('change', (e) => applyVendor(e.target.value, { overwriteModel: true }));

async function loadSettings() {
  const c = await api('/settings');
  $('#stBaseUrl').value = c.baseUrl || '';
  $('#stModel').value = c.model || '';
  // 回填供应商下拉框 + 提示（不覆盖已保存的模型名）
  const vendor = vendorFromBaseUrl(c.baseUrl);
  $('#stVendor').value = vendor;
  applyVendor(vendor, { overwriteModel: false });
  $('#stSchedEnabled').checked = !!c.schedule.enabled;
  $('#stSchedTime').value = c.schedule.time || '09:00';
  const wm = (c.schedule.window || 'last_1_day').match(/last_(\d+)_days?/);
  $('#stSchedDays').value = wm ? Number(wm[1]) : 1;
  $('#stBudget').value = c.budgetDailyTokens || 0;
  $('#stRpaMaxTabs').value = c.rpa?.maxTabsPerBatch || 6;
  $('#stWechatVideosPerAccount').value = c.rpa?.wechatVideosPerAccount || 3;
  $('#stToken').textContent = c.pairingToken;
  $('#stEndpoint').textContent = `http://127.0.0.1:${PORT}`;
  renderSettingsKeyState(c);
  renderKeyState(c.hasApiKey, c.schedule);
  loadStorageSummary().catch(() => {});
}

function fmtSavedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `，保存于 ${d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
}

function renderSettingsKeyState(c) {
  $('#stKeyState').textContent = c.hasApiKey ? `已配置（末4位 ${c.apiKeyLast4}${fmtSavedAt(c.apiKeyUpdatedAt)}）` : '未配置';
  $('#stKeyState2').textContent = c.hasApiKey2 ? `已配置（末4位 ${c.apiKey2Last4}${fmtSavedAt(c.apiKey2UpdatedAt)}）` : '未配置';
}

function currentAiTestBody({ includeTypedKey = true, keySlot = 'primary' } = {}) {
  const inputId = keySlot === 'backup' ? '#stApiKey2' : '#stApiKey';
  const apiKey = $(inputId).value.trim();
  const baseUrl = $('#stBaseUrl').value.trim();
  return {
    keySlot,
    provider: providerForVendor($('#stVendor').value, baseUrl, apiKey),
    baseUrl,
    model: $('#stModel').value.trim(),
    ...(includeTypedKey && apiKey ? { apiKey } : {}),
  };
}

function renderAiTestResult(r) {
  const usage = r.usage ? ` ｜ token ${fmt((r.usage.input || 0) + (r.usage.output || 0))}` : '';
  const keyLabel = r.keySlot === 'backup' ? '备用 Key' : '主 Key';
  $('#stTestDetail').textContent = r.ok
    ? `${keyLabel} 可用：${r.provider || '—'} ｜ 模型 ${r.model || '—'} ｜ endpoint ${r.endpoint || '—'}${usage}`
    : `${keyLabel} 不可用：${r.stage || 'request'}${r.status ? ` / HTTP ${r.status}` : ''} ｜ ${r.error || '测试失败'} ｜ endpoint ${r.endpoint || '—'}`;
}

async function testCurrentAiSettings({ includeTypedKey = true, keySlot = 'primary' } = {}) {
  const r = await api('/settings/test', {
    method: 'POST',
    body: JSON.stringify(currentAiTestBody({ includeTypedKey, keySlot })),
  });
  renderAiTestResult(r);
  const keyLabel = keySlot === 'backup' ? '备用 Key' : '主 Key';
  toast(r.ok ? `${keyLabel} 连通正常（模型 ${r.model}）` : `${keyLabel} 测试失败：${r.error}`, r.ok ? 'ok' : 'bad');
  return r;
}

function renderSavedButTestFailed(keyLabel, r) {
  $('#stTestDetail').textContent = `${keyLabel} 已覆盖保存，但测试失败：${r.error || '测试失败'}${r.status ? `（HTTP ${r.status}）` : ''} ｜ endpoint ${r.endpoint || '—'}`;
}

$('#stSaveKey').addEventListener('click', async () => {
  const apiKey = $('#stApiKey').value.trim();
  if (!apiKey) return toast('请粘贴 API Key', 'bad');
  let saved = false;
  try {
    // 先持久化接口地址/模型，再存 Key——否则刚选的供应商地址还没落库，
    // setApiKey 会用旧地址推断 provider（小米的 Key 配 DeepSeek 地址 = 401）。
    await api('/settings', { method: 'PUT', body: JSON.stringify({ baseUrl: $('#stBaseUrl').value.trim(), model: $('#stModel').value.trim() }) });
    const pub = await api('/settings/apikey', { method: 'POST', body: JSON.stringify({ apiKey }) });
    saved = true;
    renderSettingsKeyState(pub);
    renderKeyState(pub.hasApiKey, pub.schedule);
    $('#stApiKey').value = '';
    $('#stTestDetail').textContent = '主 Key 已覆盖保存，正在测试...';
    toast('主 Key 已覆盖保存，正在测试...', 'ok');
  } catch (e) {
    $('#stTestDetail').textContent = `主 Key 保存失败：${e.message}`;
    return toast('主 Key 保存失败：' + e.message, 'bad');
  }

  try {
    const r = await testCurrentAiSettings({ includeTypedKey: false, keySlot: 'primary' });
    if (!r.ok) renderSavedButTestFailed('主 Key', r);
  } catch (e) {
    if (saved) {
      $('#stTestDetail').textContent = `主 Key 已覆盖保存，但测试请求失败：${e.message}`;
      toast('主 Key 已覆盖保存，但测试失败：' + e.message, 'bad');
    }
  }
  loadSettings(); loadOverview();
});
$('#stClearKey').addEventListener('click', async () => {
  if (!(await askConfirm('确认清除已保存的 API Key？', { okText: '清除' }))) return;
  await api('/settings/apikey', { method: 'DELETE' }); toast('已清除'); loadSettings(); loadOverview();
});
$('#stSaveKey2').addEventListener('click', async () => {
  const apiKey = $('#stApiKey2').value.trim();
  if (!apiKey) return toast('请粘贴备用 API Key', 'bad');
  let saved = false;
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ baseUrl: $('#stBaseUrl').value.trim(), model: $('#stModel').value.trim() }) });
    const pub = await api('/settings/apikey2', { method: 'POST', body: JSON.stringify({ apiKey }) });
    saved = true;
    renderSettingsKeyState(pub);
    $('#stApiKey2').value = '';
    $('#stTestDetail').textContent = '备用 Key 已覆盖保存，正在测试...';
    toast('备用 Key 已覆盖保存，正在测试...', 'ok');
  } catch (e) {
    $('#stTestDetail').textContent = `备用 Key 保存失败：${e.message}`;
    return toast('备用 Key 保存失败：' + e.message, 'bad');
  }

  try {
    const r = await testCurrentAiSettings({ includeTypedKey: false, keySlot: 'backup' });
    if (!r.ok) renderSavedButTestFailed('备用 Key', r);
  } catch (e) {
    if (saved) {
      $('#stTestDetail').textContent = `备用 Key 已覆盖保存，但测试请求失败：${e.message}`;
      toast('备用 Key 已覆盖保存，但测试失败：' + e.message, 'bad');
    }
  }
  loadSettings();
});
$('#stClearKey2').addEventListener('click', async () => {
  if (!(await askConfirm('确认清除备用 API Key？', { okText: '清除' }))) return;
  await api('/settings/apikey2', { method: 'DELETE' }); toast('已清除'); loadSettings();
});
$('#stTestKey').addEventListener('click', async () => {
  toast('测试中…');
  try {
    await testCurrentAiSettings({ keySlot: 'primary' });
  } catch (e) {
    $('#stTestDetail').textContent = '';
    toast('测试失败：' + e.message, 'bad');
  }
});
$('#stTestKey2').addEventListener('click', async () => {
  toast('备用 Key 测试中…');
  try {
    await testCurrentAiSettings({ keySlot: 'backup' });
  } catch (e) {
    $('#stTestDetail').textContent = '';
    toast('备用 Key 测试失败：' + e.message, 'bad');
  }
});
$('#stSaveSettings').addEventListener('click', async () => {
  const body = {
    baseUrl: $('#stBaseUrl').value.trim(),
    model: $('#stModel').value.trim(),
    budgetDailyTokens: Number($('#stBudget').value) || 0,
    schedule: {
      enabled: $('#stSchedEnabled').checked,
      time: $('#stSchedTime').value || '09:00',
      window: windowStr($('#stSchedDays').value),
    },
    rpa: {
      maxTabsPerBatch: Number($('#stRpaMaxTabs').value) || 6,
      wechatVideosPerAccount: Number($('#stWechatVideosPerAccount').value) || 3,
    },
  };
  const pub = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
  $('#stRpaMaxTabs').value = pub.rpa?.maxTabsPerBatch || 6;
  $('#stWechatVideosPerAccount').value = pub.rpa?.wechatVideosPerAccount || 3;
  $('#stSaveMsg').textContent = `已保存：每轮 ${pub.rpa?.maxTabsPerBatch || 6} 个账号标签，每个视频号 ${pub.rpa?.wechatVideosPerAccount || 3} 条`;
  toast('设置已保存', 'ok'); loadOverview();
});

function renderStorageSummary(s) {
  if (!$('#stStorageTotal')) return;
  $('#stStorageTotal').textContent = fmtBytes(s.totalBytes);
  $('#stStorageChrome').textContent = fmtBytes(s.chromeProfileBytes);
  $('#stStorageShots').textContent = fmtBytes(s.screenshotsBytes);
  const oldShots = $('#stCleanOldScreenshots')?.checked ? s.oldScreenshotBytes : 0;
  $('#stStorageCleanable').textContent = fmtBytes((s.safeCleanableBytes || 0) + (oldShots || 0));
  const top = (s.chromeTargets || [])[0];
  $('#stStorageMsg').textContent = top
    ? `最大项：${top.label} ${fmtBytes(top.bytes)}`
    : '暂无可清理缓存';
}

async function loadStorageSummary() {
  const s = await api('/storage');
  renderStorageSummary(s);
  return s;
}

$('#stRefreshStorage')?.addEventListener('click', async () => {
  $('#stStorageMsg').textContent = '正在刷新...';
  try {
    await loadStorageSummary();
    toast('存储占用已刷新', 'ok');
  } catch (e) {
    $('#stStorageMsg').textContent = '';
    toast('刷新失败：' + e.message, 'bad');
  }
});
$('#stCleanOldScreenshots')?.addEventListener('change', () => loadStorageSummary().catch(() => {}));
$('#stCleanupStorage')?.addEventListener('click', async () => {
  const includeOldScreenshots = !!$('#stCleanOldScreenshots')?.checked;
  const suffix = includeOldScreenshots ? '，并删除 30 天前截图' : '';
  if (!(await askConfirm(`清理 Chrome 自动缓存和模型${suffix}？登录态和数据库会保留。`, { okText: '开始清理' }))) return;
  $('#stCleanupStorage').disabled = true;
  $('#stStorageMsg').textContent = '正在清理...';
  try {
    const r = await api('/storage/cleanup', {
      method: 'POST',
      body: JSON.stringify({ includeOldScreenshots, screenshotDays: 30 }),
    });
    renderStorageSummary(r.after);
    $('#stStorageMsg').textContent = `已释放 ${fmtBytes(r.removedBytes)}`;
    toast(`已释放 ${fmtBytes(r.removedBytes)}`, 'ok');
  } catch (e) {
    $('#stStorageMsg').textContent = '';
    toast('清理失败：' + e.message, 'bad');
  } finally {
    $('#stCleanupStorage').disabled = false;
  }
});
$('#stCopyToken').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#stToken').textContent); toast('已复制 token');
});
$('#stRegenToken').addEventListener('click', async () => {
  if (!(await askConfirm('重置后，已配对的插件需要重新填入新 token。继续？', { okText: '重置' }))) return;
  const r = await api('/settings/pairing/regenerate', { method: 'POST' });
  TOKEN = r.pairingToken; // 同步更新内存中的 token，后续请求与导出链接都用新值
  $('#stToken').textContent = r.pairingToken; toast('已重置 token，请更新插件设置', 'ok');
});

// ---------------------------------------------------------------- boot ----
async function loadOverviewPage() {
  await loadOverview();
  await loadCandidates();
}

const loaders = {
  overview: loadOverviewPage, library: loadLibrary,
  accounts: loadAccounts, reports: loadReports, settings: loadSettings,
};
loadOverviewPage().catch((e) => toast('加载失败：' + e.message, 'bad'));

/**
 * 日报渲染 —— 把 AI 的定性 JSON + 数据库里的硬数据，渲染成 Markdown / HTML / CSV。
 *
 * 「关键数据绝不出错」的最后一道保险都在这里：
 *   达标内容清单的每一个互动数字，都从传入的 items（数据库行）渲染，
 *   绝不使用 AI 文本里的数字。AI 只提供母题、原因、改写标题等定性内容。
 */

import { windowLabel } from '../filter.js';

const STATUS_LABEL = {
  needs_review: '待复核', missing_share: '缺转发数', missing_favorite: '缺收藏数', missing_like: '缺点赞数',
  below_threshold: '未达阈值', duplicate: '重复', archived: '已归档', confirmed: '已确认',
  monitoring: '发酵中',
};

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = (s) => {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function resolveRef(ref, items) {
  const m = String(ref).match(/C(\d+)/i);
  if (!m) return null;
  return items[Number(m[1]) - 1] || null;
}

function clusterRefs(c) {
  return c.representative_content_ids || c.representative_contents || [];
}

/** 汇总所有可复用标题（母题级 + 单条级），去重。 */
function gatherReusableTitles(reportData, analyses) {
  const set = new Set();
  for (const c of reportData.top_topic_clusters || []) {
    for (const t of c.rewrite_titles || []) if (t) set.add(String(t).trim());
  }
  for (const a of Object.values(analyses)) {
    try {
      for (const t of JSON.parse(a.rewrite_titles_json || '[]')) if (t) set.add(String(t).trim());
    } catch { /* ignore */ }
  }
  return [...set].slice(0, 30);
}

function excludedSummary(counts) {
  const parts = [];
  for (const k of ['needs_review', 'missing_share', 'missing_favorite', 'missing_like', 'below_threshold', 'duplicate']) {
    if (counts[k]) parts.push(`${STATUS_LABEL[k]} ${counts[k]} 条`);
  }
  return parts.join('，');
}

export function fallbackReportData(windowType, counts) {
  const ex = excludedSummary(counts);
  return {
    daily_summary: `过去${windowLabel(windowType)}内，暂无满足「小红书点赞和收藏都达标；抖音点赞、收藏和转发都达标」且证据可信的内容，样本不足。${ex ? `当前库内：${ex}。建议在「今日候选」里补录/确认指标后再生成。` : ''}`,
    top_topic_clusters: [],
    recommended_actions: [],
    data_warnings: ['样本不足：达标内容为 0 条，本期不做方向结论。'],
  };
}

// ---------------------------------------------------------------- Markdown ----

export function renderMarkdown(reportData, items, analyses, meta) {
  const L = windowLabel(meta.windowType);
  const out = [];
  out.push(`# 每日爆款选题总结 — ${L}`);
  out.push('');
  out.push(`> 生成时间：${meta.generatedAt}　｜　窗口：${L}　｜　达标内容：**${items.length}** 条　｜　入选条件：账号池内小红书/抖音 + 平台必需指标都达标（小红书：点赞+收藏；抖音：点赞+收藏+转发）`);
  out.push('');

  out.push('## 一、AI 观察摘要');
  out.push('');
  out.push(reportData.daily_summary || '（无）');
  out.push('');
  out.push('> ⚠️ 以上内容由 AI 基于下方达标清单自动生成，仅供参考，不代表事实判断。');
  out.push('');

  const clusters = reportData.top_topic_clusters || [];
  if (clusters.length) {
    out.push(`## 二、AI 母题聚类 TOP ${clusters.length}（仅供参考）`);
    out.push('');
    clusters.forEach((c, i) => {
      out.push(`### ${i + 1}. ${c.cluster_name || '（未命名母题）'}`);
      if (c.why_it_spread) out.push(`- **为什么传播**：${c.why_it_spread}`);
      const reps = clusterRefs(c).map((r) => resolveRef(r, items)).filter(Boolean);
      if (reps.length) {
        out.push('- **代表内容**：');
        for (const it of reps) {
          const link = it.url ? `[${it.title || '(无标题)'}](${it.url})` : (it.title || '(无标题)');
          out.push(`  - ${link} — ${it.platform || '?'}｜${it.author_name || '?'}｜点赞 ${fmt(it.like_count)}｜转发 ${fmt(it.share_count)}｜收藏 ${fmt(it.favorite_count)}`);
        }
      }
      if ((c.rewrite_titles || []).length) {
        out.push('- **AI 建议标题**（仅供参考）：');
        for (const t of c.rewrite_titles) out.push(`  - ${t}`);
      }
      out.push('');
    });
  }

  out.push('## 三、达标内容清单（数据来自本地库，精确值）');
  out.push('');
  if (items.length) {
    out.push('| 内容编号 | 平台 | 作者 | 标题 | 点赞 | 转发/分享 | 收藏 | 评论 | 入选原因 | 发布时间 | 链接 |');
    out.push('|----------|------|------|------|------|-----------|------|------|----------|----------|------|');
    items.forEach((it, i) => {
      const t = (it.title || '').replace(/\|/g, '／');
      const link = it.url ? `[打开](${it.url})` : '—';
      const pub = it.publish_time ? it.publish_time.slice(0, 10) : '—';
      out.push(`| C${i + 1} | ${it.platform || '?'} | ${(it.author_name || '?').replace(/\|/g, '／')} | ${t} | ${fmt(it.like_count)} | ${fmt(it.share_count)} | ${fmt(it.favorite_count)} | ${fmt(it.comment_count)} | ${(it.eligible_reason || '—').replace(/\|/g, '／')} | ${pub} | ${link} |`);
    });
  } else {
    out.push('_本期无达标内容。_');
  }
  out.push('');

  const titles = gatherReusableTitles(reportData, analyses);
  if (titles.length) {
    out.push('## 四、AI 建议选题（仅供参考）');
    out.push('');
    titles.forEach((t, i) => out.push(`${i + 1}. ${t}`));
    out.push('');
  }

  const actions = reportData.recommended_actions || [];
  if (actions.length) {
    out.push('## 五、AI 商业承接建议（仅供参考）');
    out.push('');
    for (const a of actions) out.push(`- ${a}`);
    out.push('');
  }

  out.push('## 六、数据备注');
  out.push('');
  out.push('- **数据口径**：点赞/转发/收藏等数字来自稳定页面数据、插件采集或人工确认；截图/OCR 等弱证据只进待复核，不直接入榜。');
  const ex = excludedSummary(meta.counts || {});
  if (ex) out.push(`- **本期未入选统计**：${ex}（这些内容因缺数据或未达标，未计入正式榜单）。`);
  out.push(`- **样本量**：达标 ${items.length} 条。`);
  if (items.length <= 2) {
    out.push('- ⚠️ **少样本提示**：本期达标内容仅 ' + items.length + ' 条，AI 摘录和归类仅供参考，请结合更长窗口数据综合判断。');
  }
  for (const w of reportData.data_warnings || []) out.push(`- ${w}`);
  out.push('');
  out.push('---');
  out.push(`_由「Viral Brief Plus」生成${meta.aiUsed ? `（分析模型：${meta.model || '—'}）` : '（本期 0 达标，未调用 AI）'}。日报中的互动数字为本地库记录值。_`);
  return out.join('\n');
}

// -------------------------------------------------------------------- HTML ----

export function renderHtml(reportData, items, analyses, meta) {
  const L = windowLabel(meta.windowType);
  const clusters = reportData.top_topic_clusters || [];
  const titles = gatherReusableTitles(reportData, analyses);
  const actions = reportData.recommended_actions || [];
  const ex = excludedSummary(meta.counts || {});

  const clusterHtml = clusters.map((c, i) => {
    const reps = clusterRefs(c).map((r) => resolveRef(r, items)).filter(Boolean);
    const repLi = reps.map((it) => {
      const link = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noreferrer">${esc(it.title || '(无标题)')}</a>` : esc(it.title || '(无标题)');
      return `<li>${link} <span class="muted">— ${esc(it.platform)}｜${esc(it.author_name)}｜点赞 ${fmt(it.like_count)}｜转发 ${fmt(it.share_count)}｜收藏 ${fmt(it.favorite_count)}</span></li>`;
    }).join('');
    const titleLi = (c.rewrite_titles || []).map((t) => `<li>${esc(t)}</li>`).join('');
    return `<div class="cluster">
      <h3>${i + 1}. ${esc(c.cluster_name || '（未命名母题）')}</h3>
      ${c.why_it_spread ? `<p><b>为什么传播：</b>${esc(c.why_it_spread)}</p>` : ''}
      ${repLi ? `<p><b>代表内容：</b></p><ul>${repLi}</ul>` : ''}
      ${titleLi ? `<p><b>AI 建议标题（仅供参考）：</b></p><ul>${titleLi}</ul>` : ''}
    </div>`;
  }).join('');

  const rows = items.map((it, i) => {
    const link = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noreferrer">打开</a>` : '—';
    const pub = it.publish_time ? esc(it.publish_time.slice(0, 10)) : '—';
    return `<tr>
      <td>C${i + 1}</td><td>${esc(it.platform)}</td><td>${esc(it.author_name)}</td>
      <td class="title">${esc(it.title)}</td>
      <td class="num">${fmt(it.like_count)}</td><td class="num">${fmt(it.share_count)}</td>
      <td class="num">${fmt(it.favorite_count)}</td><td class="num">${fmt(it.comment_count)}</td>
      <td>${esc(it.eligible_reason || '—')}</td><td>${pub}</td><td>${link}</td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>每日爆款选题总结 — ${esc(L)}</title>
<style>
  :root { --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --brand:#2563eb; --bg:#f8fafc; }
  * { box-sizing:border-box; }
  body { font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); margin:0; background:var(--bg); }
  .wrap { max-width:860px; margin:0 auto; padding:40px 28px 80px; background:#fff; }
  h1 { font-size:26px; margin:0 0 6px; }
  h2 { font-size:20px; margin:34px 0 12px; padding-bottom:6px; border-bottom:2px solid var(--brand); color:var(--brand); }
  h3 { font-size:17px; margin:18px 0 8px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:8px; }
  .badge { display:inline-block; background:#eff6ff; color:var(--brand); border:1px solid #bfdbfe; border-radius:999px; padding:2px 10px; font-size:12px; }
  .cluster { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:14px 18px; margin:12px 0; }
  ul { margin:6px 0 6px 0; padding-left:22px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13.5px; }
  th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#f1f5f9; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.title { max-width:300px; }
  .muted { color:var(--muted); font-size:12.5px; }
  .notes li { color:#374151; }
  footer { margin-top:40px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:12px; }
  @media print { body { background:#fff; } .wrap { max-width:none; padding:0; } .noprint { display:none; } }
</style></head>
<body><div class="wrap">
  <h1>每日爆款选题总结 <span class="badge">${esc(L)}</span></h1>
  <div class="meta">生成时间：${esc(meta.generatedAt)}　｜　达标内容：<b>${items.length}</b> 条　｜　入选条件：账号池内小红书/抖音 + 平台必需指标都达标（小红书：点赞+收藏；抖音：点赞+收藏+转发）</div>
  <p class="noprint muted">提示：按 Cmd/Ctrl + P 可「打印为 PDF」。</p>

  <h2>一、AI 观察摘要</h2>
  <p>${esc(reportData.daily_summary || '（无）')}</p>
  <p class="muted">⚠️ 以上内容由 AI 基于下方达标清单自动生成，仅供参考，不代表事实判断。</p>

  ${clusters.length ? `<h2>二、AI 母题聚类 TOP ${clusters.length}（仅供参考）</h2>${clusterHtml}` : ''}

  <h2>三、达标内容清单 <span class="muted">（数据来自本地库，为精确值）</span></h2>
  ${items.length ? `<table><thead><tr><th>内容编号</th><th>平台</th><th>作者</th><th>标题</th><th>点赞</th><th>转发/分享</th><th>收藏</th><th>评论</th><th>入选原因</th><th>发布</th><th>链接</th></tr></thead><tbody>${rows}</tbody></table>` : '<p><i>本期无达标内容。</i></p>'}

  ${titles.length ? `<h2>四、AI 建议选题（仅供参考）</h2><ol>${titles.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}

  ${actions.length ? `<h2>五、AI 商业承接建议（仅供参考）</h2><ul>${actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}

  <h2>六、数据备注</h2>
  <ul class="notes">
    <li><b>数据口径：</b>点赞/转发/收藏等数字来自稳定页面数据、插件采集或人工确认；截图/OCR 等弱证据只进待复核，不直接入榜。</li>
    ${ex ? `<li><b>本期未入选统计：</b>${esc(ex)}（缺数据或未达标，不计入榜单）。</li>` : ''}
    <li><b>样本量：</b>达标 ${items.length} 条。</li>
    ${items.length <= 2 ? `<li>⚠️ <b>少样本提示：</b>本期达标内容仅 ${items.length} 条，AI 摘录和归类仅供参考，请结合更长窗口数据综合判断。</li>` : ''}
    ${(reportData.data_warnings || []).map((w) => `<li>${esc(w)}</li>`).join('')}
  </ul>

  <footer>由「Viral Brief Plus」生成${meta.aiUsed ? `（分析模型：${esc(meta.model || '—')}）` : '（本期 0 达标，未调用 AI）'}。日报中的互动数字为本地库记录值。</footer>
</div></body></html>`;
}

// --------------------------------------------------------------------- CSV ----

export function renderCsv(items, analyses = {}) {
  const header = ['内容编号', '平台', '作者', '标题', '点赞', '转发/分享', '评论', '收藏', '入选原因', '发布时间', '链接', '选题', '钩子'];
  const lines = [header.map(csvCell).join(',')];
  for (const [i, it] of items.entries()) {
    const a = analyses[it.id] || {};
    lines.push([
      `C${i + 1}`,
      it.platform, it.author_name, it.title,
      it.like_count, it.share_count, it.comment_count, it.favorite_count,
      it.eligible_reason || '', it.publish_time || '', it.url || '', a.extracted_topic || '', a.hook_type || '',
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\n'); // BOM 让 Excel 正确识别 UTF-8
}

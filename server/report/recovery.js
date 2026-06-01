import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXPORTS_DIR } from '../lib/paths.js';
import { createZip } from './archive.js';

const FORMATS = new Set(['md', 'html', 'csv', 'zip']);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[c]));

const stripMarkdown = (s) => String(s ?? '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .trim();

function csvCell(value) {
  const s = stripMarkdown(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseMarkdownTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => stripMarkdown(cell));
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line);
}

export function normalizeReportExportFormat(format = 'md') {
  const fmt = String(format || 'md').toLowerCase();
  return FORMATS.has(fmt) ? fmt : 'md';
}

export function reportExportPath(report, format = 'md') {
  const fmt = normalizeReportExportFormat(format);
  return fmt === 'html' ? report.export_html_path
    : fmt === 'csv' ? report.export_csv_path
      : fmt === 'zip' ? report.export_zip_path
        : report.export_md_path;
}

function fallbackBaseName(report, format) {
  const stored = reportExportPath(report, format);
  if (stored) return basename(stored);
  const stamp = [
    report.report_date || 'unknown-date',
    report.window_type || 'unknown-window',
    String(report.id || '').slice(0, 8),
  ].filter(Boolean).join('_').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return `report_${stamp}.${format}`;
}

function renderInline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderTable(lines) {
  const rows = lines.filter((line) => !isSeparatorRow(line)).map(parseMarkdownTableRow);
  if (rows.length === 0) return '';
  const [head, ...body] = rows;
  return `<table><thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function markdownToReportHtml(markdown, report = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const openList = (type) => {
    if (listType === type) return;
    closeList();
    out.push(`<${type}>`);
    listType = type;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') {
      closeList();
      continue;
    }
    if (trimmed.startsWith('|') && lines[i + 1] && isSeparatorRow(lines[i + 1])) {
      closeList();
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      i--;
      out.push(renderTable(tableLines));
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (trimmed.startsWith('>')) {
      closeList();
      out.push(`<blockquote>${renderInline(trimmed.replace(/^>\s*/, ''))}</blockquote>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      openList('ul');
      out.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      openList('ol');
      out.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${renderInline(trimmed)}</p>`);
  }
  closeList();

  const title = report.report_date
    ? `每日爆款选题总结 - ${report.report_date}`
    : '每日爆款选题总结';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --brand:#2563eb; --bg:#f8fafc; }
  * { box-sizing:border-box; }
  body { font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); margin:0; background:var(--bg); }
  .wrap { max-width:900px; margin:0 auto; padding:40px 28px 80px; background:#fff; }
  h1 { font-size:26px; margin:0 0 18px; }
  h2 { font-size:20px; margin:34px 0 12px; padding-bottom:6px; border-bottom:2px solid var(--brand); color:var(--brand); }
  h3 { font-size:17px; margin:18px 0 8px; }
  blockquote { margin:12px 0; padding:10px 14px; border-left:4px solid var(--brand); background:#eff6ff; color:#334155; }
  table { width:100%; border-collapse:collapse; margin:12px 0; font-size:13.5px; }
  th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#f1f5f9; }
  code { background:#f1f5f9; padding:1px 5px; border-radius:4px; }
  footer { margin-top:36px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:12px; }
</style></head><body><div class="wrap">
${out.join('\n')}
<footer>此预览由数据库中保存的日报正文恢复。原导出文件缺失时，系统会自动重建可查看版本。</footer>
</div></body></html>`;
}

export function markdownTableToCsv(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !isSeparatorRow(lines[i + 1])) continue;
    const tableLines = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      tableLines.push(lines[i]);
      i++;
    }
    const rows = tableLines.filter((line) => !isSeparatorRow(line)).map(parseMarkdownTableRow);
    if (rows.length > 0) return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\n');
  }
  return '\ufeff提示\n旧日报的 CSV 导出文件已丢失；系统只能从数据库恢复 Markdown 和 HTML 预览。';
}

export function recoveredReportExport(report, format = 'md') {
  const fmt = normalizeReportExportFormat(format);
  const markdown = String(report?.report_markdown || '').trimEnd();
  if (!markdown) return null;
  const html = markdownToReportHtml(markdown, report);
  const csv = markdownTableToCsv(markdown);
  if (fmt === 'html') return { format: fmt, data: html, fileName: fallbackBaseName(report, fmt) };
  if (fmt === 'csv') return { format: fmt, data: csv, fileName: fallbackBaseName(report, fmt) };
  if (fmt === 'zip') {
    const zip = createZip([
      { name: fallbackBaseName(report, 'md'), data: markdown },
      { name: fallbackBaseName(report, 'html'), data: html },
      { name: fallbackBaseName(report, 'csv'), data: csv },
    ]);
    return { format: fmt, data: zip, fileName: fallbackBaseName(report, fmt) };
  }
  return { format: fmt, data: markdown, fileName: fallbackBaseName(report, 'md') };
}

export function materializeReportExport(report, format = 'md', { exportsDir = EXPORTS_DIR } = {}) {
  const fmt = normalizeReportExportFormat(format);
  const storedPath = reportExportPath(report, fmt);
  if (storedPath && existsSync(storedPath)) return storedPath;
  const recovered = recoveredReportExport(report, fmt);
  if (!recovered) return null;
  mkdirSync(exportsDir, { recursive: true });
  const filePath = join(exportsDir, recovered.fileName);
  writeFileSync(filePath, recovered.data);
  return filePath;
}

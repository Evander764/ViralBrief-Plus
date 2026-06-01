/**
 * 本地服务入口。
 *  - 监听 127.0.0.1（绝不对外暴露）。
 *  - 托管浏览器仪表盘（桌面端 UI）。
 *  - 提供 /api/capture、/api/ingest、/api/agent/* 三类本地内容入口。
 *  - 启动自动调度器：接入 API Key + 开启调度后，每天自动产出日报。
 *
 * 安全：所有 /api/*（除 /api/health）都需要配对 token；仪表盘从本地服务
 * 注入 token，插件由用户手动粘贴 token。可防普通网页 CSRF / 越权调用。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync, existsSync, createReadStream, statSync, unlinkSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { CDPClient } from './rpa/cdp.js';
import { runPatrol, discoverFollowedCreators } from './rpa/patrol.js';
import { launchChrome, killChrome } from './rpa/chrome-launcher.js';
import { beginPatrolRun, endPatrolRun, requestPatrolStop, getPatrolRunState } from './rpa/control.js';

import { WEB_DIR, SCREENSHOTS_DIR, ensureDirs, PROJECT_ROOT } from './lib/paths.js';
import { log } from './lib/log.js';
import {
  loadConfig, getPublicConfig, saveConfig, setApiKey, clearApiKey, hasApiKey,
  setApiKey2, clearApiKey2, regeneratePairingToken,
} from './config.js';
import {
  upsertCapture, confirmContent, archiveContent, deleteContent, getContent, listContents,
  beijingDayStartISO,
  countsByStatus, listAccounts, upsertAccount, deleteAccount, importAccountsCsv, importAccountsLines,
  listReports, getReport, deleteReport, getUsageForDay, getAnalysis, getObservation, upsertObservation,
} from './store.js';
import { runDailyReport } from './pipeline.js';
import { materializeReportExport } from './report/recovery.js';
import { startScheduler, restartScheduler } from './scheduler.js';
import { testConnection } from './ai/client.js';
import { analyzeContent, suggestAccountsFromAI } from './ai/analyze.js';
import { recognizePageState, observeVideo } from './ai/observe.js';
import { fetchAndExtract } from './ingest/scrape.js';
import { openExternalBrowser, openExternalBrowserUrls } from './lib/browser-open.js';
import { accountOpenUrlsForPlatform } from './lib/account-open.js';
import { cleanupStorage, inspectStorage } from './lib/storage-cleanup.js';
import { safeUrlBasename } from './lib/url-path.js';


ensureDirs();
const cfg = loadConfig();
const PORT = Number(process.env.VBP_PORT ?? process.env.VB_PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 
    'content-type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  });
  res.end(body);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  return JSON.parse(b.toString('utf8'));
}

function tokenOf(req, url) {
  return req.headers['x-vb-token'] || url.searchParams.get('token');
}

function saveScreenshot(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = join(SCREENSHOTS_DIR, `${randomUUID()}.${ext}`);
  writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

async function serveStatic(res, filePath, { inline = true, downloadName } = {}) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const headers = { 
    'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  };
  if (!inline) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(downloadName || basename(filePath))}"`;
  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

function revealInFileManager(filePath) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('open', ['-R', filePath], (error) => (error ? reject(error) : resolve()));
      return;
    }
    if (process.platform === 'win32') {
      execFile('explorer.exe', ['/select,', filePath], (error) => (error ? reject(error) : resolve()));
      return;
    }
    execFile('xdg-open', [dirname(filePath)], (error) => (error ? reject(error) : resolve()));
  });
}

function removeReportFiles(report) {
  for (const p of [
    report.export_md_path, report.export_html_path, report.export_csv_path, report.export_zip_path,
  ]) {
    if (!p) continue;
    try { if (existsSync(p)) unlinkSync(p); } catch (e) { log.warn(`删除日报文件失败：${p} ${e.message}`); }
  }
}

async function serveIndex(res) {
  let html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
  const version = Date.now();
  html = html
    .replace(/%%VBP_TOKEN%%|%%VB_TOKEN%%/g, cfg.pairingToken)
    .replace(/%%VBP_PORT%%|%%VB_PORT%%/g, String(PORT))
    .replace('href="styles.css"', `href="styles.css?v=${version}"`)
    .replace('src="app.js"', `src="app.js?v=${version}"`);
  res.writeHead(200, { 
    'content-type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  });
  res.end(html);
}

// ---------------------------------------------------------------- dispatch ----

async function handleApi(req, res, url, segs) {
  const method = req.method;
  const p = segs.slice(1); // 去掉 'api'

  // health 不需要 token，供插件探测桌面端是否在运行
  if (p[0] === 'health') {
    return sendJson(res, 200, { ok: true, app: 'viral-brief-plus', version: '1.0.1', hasApiKey: hasApiKey() });
  }

  // 鉴权
  if (tokenOf(req, url) !== cfg.pairingToken) {
    return sendJson(res, 401, { error: '配对 token 无效或缺失' });
  }

  // ---- capture（插件入口）----
  if (p[0] === 'capture' && method === 'POST') {
    const payload = await readJson(req);
    if (payload.screenshot) {
      const sp = saveScreenshot(payload.screenshot);
      if (sp) payload.screenshot_path = sp;
      delete payload.screenshot;
    }
    const r = upsertCapture(payload);
    return sendJson(res, 200, r);
  }

  // ---- ingest（粘贴链接，服务端抓取解析）----
  if (p[0] === 'ingest' && method === 'POST') {
    const { url } = await readJson(req);
    if (!url || !/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: '请提供合法的 http(s) 链接' });
    const r = await fetchAndExtract(url);
    if (!r.ok) return sendJson(res, 200, { ok: false, note: r.note });
    // 抓到的指标来源标记 scraped → 走 needs_review（待复核），不自动入榜。
    const cap = upsertCapture({
      url: r.url,
      platform: r.platform,
      content_type: r.content_type,
      title: r.title,
      author_name: r.author_name,
      body_excerpt: r.body_excerpt,
      metrics_source: 'scraped',
      metrics_raw: r.metrics_raw,
    });
    return sendJson(res, 200, {
      ok: true, id: cap.id, duplicate: cap.duplicate, status: cap.status,
      platform: r.platform, title: r.title, author_name: r.author_name,
      metrics: r.metrics_raw, found: r.found, note: r.note,
    });
  }

  // ---- stats ----
  if (p[0] === 'stats' && method === 'GET') {
    return sendJson(res, 200, {
      counts: countsByStatus(),
      usage: getUsageForDay(),
      schedule: cfg.schedule,
      hasApiKey: hasApiKey(),
    });
  }

  // ---- storage ----
  if (p[0] === 'storage') {
    if (p.length === 1 && method === 'GET') {
      return sendJson(res, 200, inspectStorage());
    }
    if (p[1] === 'cleanup' && method === 'POST') {
      const active = getPatrolRunState();
      if (active) return sendJson(res, 409, { error: '巡检运行中，先停止巡检再清理缓存', active });
      const body = await readJson(req);
      return sendJson(res, 200, cleanupStorage({
        includeOldScreenshots: body.includeOldScreenshots === true,
        screenshotDays: body.screenshotDays || 30,
      }));
    }
  }

  // ---- settings ----
  if (p[0] === 'settings') {
    if (p.length === 1 && method === 'GET') return sendJson(res, 200, getPublicConfig());
    if (p.length === 1 && method === 'PUT') {
      const body = await readJson(req);
      const pub = saveConfig(body);
      restartScheduler();
      return sendJson(res, 200, pub);
    }
    if (p[1] === 'apikey' && method === 'POST') {
      const { apiKey } = await readJson(req);
      setApiKey(apiKey);
      return sendJson(res, 200, getPublicConfig());
    }
    if (p[1] === 'apikey' && method === 'DELETE') {
      clearApiKey();
      return sendJson(res, 200, getPublicConfig());
    }
    if (p[1] === 'apikey2' && method === 'POST') {
      const { apiKey } = await readJson(req);
      setApiKey2(apiKey);
      return sendJson(res, 200, getPublicConfig());
    }
    if (p[1] === 'apikey2' && method === 'DELETE') {
      clearApiKey2();
      return sendJson(res, 200, getPublicConfig());
    }
  }

  // ---- rpa patrol ----
  if (p[0] === 'patrol' && p[1] === 'stop' && method === 'POST') {
    return sendJson(res, 200, requestPatrolStop());
  }
  if (p[0] === 'patrol' && p[1] === 'state' && method === 'GET') {
    return sendJson(res, 200, { active: getPatrolRunState() });
  }
  if (p[0] === 'patrol' && p[1] === 'run' && method === 'POST') {
    let runCtrl = null;
    try {
      const body = await readJson(req);
      const cfg = loadConfig();
      const windowType = body.window || cfg.schedule?.window || 'last_1_days';
      const maxTabsPerBatch = body.maxTabsPerBatch ?? cfg.rpa?.maxTabsPerBatch;
      const includePatrolledToday = body.includePatrolledToday === true;
      const platforms = body.platform ? [body.platform] : (Array.isArray(body.platforms) && body.platforms.length ? body.platforms : ['xiaohongshu', 'douyin']);
      runCtrl = beginPatrolRun({ source: 'api', platforms });
      log.info(`正在执行 Node.js CDP 自动巡检（${platforms.join(', ')}）...`);
      const client = new CDPClient();
      const chrome = await launchChrome({ port: 9222, waitMs: 15000 });
      let result;
      try {
        await client.connect(chrome.port);
        result = await runPatrol(client, {
          onProgress: (msg) => log.info(`[RPA] ${msg}`),
          windowType,
          platforms,
          maxTabsPerBatch,
          includePatrolledToday,
          shouldStop: runCtrl.shouldStop,
          clientFactory: async () => {
            const c = new CDPClient();
            await c.connect(chrome.port);
            return c;
          },
        });
      } finally {
        await client.close();
        if (chrome.closeOnDone && chrome.child) killChrome(chrome.child);
      }
      return sendJson(res, 200, {
        success: true,
        message: result.stopped ? '自动巡检已停止。' : '自动巡检完成。',
        platformComplete: !result.stopped,
        platforms,
        ...result
      });
    } catch (e) {
      if (e.code === 'VBP_PATROL_ACTIVE') {
        return sendJson(res, 409, { error: e.message, active: e.active });
      }
      log.error('桌面 Agent (Node CDP) 运行失败: ' + e.message);
      return sendJson(res, 500, { error: '桌面 Agent 运行失败: ' + e.message });
    } finally {
      if (runCtrl) endPatrolRun(runCtrl.id);
    }
  }

  // ---- follows discovery only ----
  if (p[0] === 'follows' && p[1] === 'discover' && method === 'POST') {
    try {
      const body = await readJson(req);
      const platforms = Array.isArray(body.platforms) && body.platforms.length ? body.platforms : undefined;
      const client = new CDPClient();
      const chrome = await launchChrome({ port: 9222, waitMs: 15000 });
      let creators;
      try {
        await client.connect(chrome.port);
        creators = await discoverFollowedCreators(client, {
          platforms,
          onProgress: (msg) => log.info(`[RPA] ${msg}`),
        });
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
      } finally {
        await client.close();
        if (chrome.closeOnDone && chrome.child) killChrome(chrome.child);
      }
      return sendJson(res, 200, { ok: true, discovered: creators.length, creators });
    } catch (e) {
      return sendJson(res, 500, { error: '关注发现失败: ' + e.message });
    }
  }

  // ---- agent（桌面视觉 Agent 端点）----
  if (p[0] === 'agent') {
    // 页面状态识别
    if (p[1] === 'recognize' && method === 'POST') {
      const body = await readJson(req);
      if (!body.screenshot) return sendJson(res, 400, { error: '缺少 screenshot' });
      try {
        const b64 = body.screenshot.replace(/^data:image\/\w+;base64,/, '');
        const result = await recognizePageState(b64, {
          platform: body.platform,
          creator: body.creator,
        });
        return sendJson(res, 200, result.json);
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message) });
      }
    }

    // 视频详情页观察
    if (p[1] === 'observe' && method === 'POST') {
      const body = await readJson(req);
      if (!body.screenshot) return sendJson(res, 400, { error: '缺少 screenshot' });
      try {
        const b64 = body.screenshot.replace(/^data:image\/\w+;base64,/, '');
        const result = await observeVideo(b64, {
          content_id: body.content_id,
          platform: body.platform,
          creator: body.creator,
          title: body.title,
        });
        return sendJson(res, 200, result.observation);
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message) });
      }
    }

    // Agent 数据入库（截图 + 指标 + 观察）
    if (p[1] === 'ingest' && method === 'POST') {
      const body = await readJson(req);
      if (!body.platform || !body.url) return sendJson(res, 400, { error: '缺少 platform 或 url' });
      try {
        // 保存截图
        let screenshotPath = null;
        if (body.screenshot) {
          screenshotPath = saveScreenshot(body.screenshot);
        }
        // 入库（metrics_source='desktop_agent' → needs_review）
        const captureResult = upsertCapture({
          platform: body.platform,
          account_id: body.account_id,
          author_name: body.author_name,
          url: body.url,
          title: body.title,
          body_excerpt: body.body_excerpt,
          content_type: body.content_type || 'video',
          publish_time: body.publish_time,
          screenshot_path: screenshotPath,
          metrics_source: 'desktop_agent',
          metrics_raw: body.metrics_raw || {},
        });
        // 如果有观察数据，一并入库
        if (body.observation && captureResult.id) {
          upsertObservation(captureResult.id, body.observation, body.observation_model || '');
        }
        return sendJson(res, 200, captureResult);
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message) });
      }
    }
  }

  // ---- settings - additional ----
  if (p[0] === 'settings') {
    if (p[1] === 'test' && method === 'POST') {
      const body = await readJson(req);
      const r = await testConnection(body);
      return sendJson(res, 200, r);
    }
    if (p[1] === 'pairing' && p[2] === 'regenerate' && method === 'POST') {
      const t = regeneratePairingToken();
      return sendJson(res, 200, { pairingToken: t });
    }
  }

  // ---- contents ----
  if (p[0] === 'contents') {
    if (p.length === 1 && method === 'GET') {
      const items = listContents({
        status: url.searchParams.get('status') || undefined,
        platform: url.searchParams.get('platform') || undefined,
        window: url.searchParams.get('window') || undefined,
        q: url.searchParams.get('q') || undefined,
        capturedSince: url.searchParams.get('today') === '1'
          ? beijingDayStartISO()
          : url.searchParams.get('captured_since') || undefined,
      });
      // 附加观察数据（候选池展示用）
      if (url.searchParams.get('include_observations') === '1') {
        for (const it of items) {
          const obs = getObservation(it.id);
          if (obs) it.observation = obs;
        }
      }
      return sendJson(res, 200, items);
    }
    const id = p[1];
    if (id && p.length === 2 && method === 'GET') {
      const c = getContent(id);
      return c ? sendJson(res, 200, { ...c, analysis: getAnalysis(id), observation: getObservation(id) }) : sendJson(res, 404, { error: '未找到' });
    }
    if (id && p[2] === 'confirm' && method === 'POST') {
      const body = await readJson(req);
      const c = confirmContent(id, body);
      return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: '未找到' });
    }
    if (id && p[2] === 'archive' && method === 'POST') {
      return sendJson(res, 200, archiveContent(id));
    }
    if (id && p[2] === 'analyze' && method === 'POST') {
      const c = getContent(id);
      if (!c) return sendJson(res, 404, { error: '未找到' });
      try {
        const r = await analyzeContent(c, { force: url.searchParams.get('force') === '1' });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 200, { error: String(e.message) });
      }
    }
    if (id && p.length === 2 && method === 'DELETE') {
      deleteContent(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- browser ----
  if (p[0] === 'browser' && p[1] === 'open' && method === 'POST') {
    const body = await readJson(req);
    const target = Array.isArray(body.urls) ? body.urls : body.url;
    try {
      const opened = await openExternalBrowser(target);
      return sendJson(res, 200, { ok: true, ...opened });
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  // ---- accounts ----
  if (p[0] === 'accounts') {
    if (p.length === 1 && method === 'GET') return sendJson(res, 200, listAccounts());
    if (p.length === 1 && method === 'POST') return sendJson(res, 200, upsertAccount(await readJson(req)));
    if (p[1] === 'open-platform' && method === 'POST') {
      const body = await readJson(req);
      const selected = accountOpenUrlsForPlatform(listAccounts(), body.platform || 'xiaohongshu');
      if (!selected.platform) return sendJson(res, 400, { error: '不支持的平台' });
      if (selected.urls.length > 0) await openExternalBrowserUrls(selected.urls);
      return sendJson(res, 200, {
        ok: true,
        platform: selected.platform,
        openedCount: selected.urls.length,
        skippedCount: selected.skippedCount,
        urls: selected.urls,
      });
    }
    if (p[1] === 'search-suggest' && method === 'POST') {
      const { q } = await readJson(req);
      if (!q || !q.trim()) return sendJson(res, 400, { error: '查询内容不能为空' });
      try {
        const r = await suggestAccountsFromAI(q);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message) });
      }
    }
    if (p[1] === 'import' && method === 'POST') {
      const { csv } = await readJson(req);
      return sendJson(res, 200, importAccountsCsv(csv || ''));
    }
    if (p[1] === 'import-lines' && method === 'POST') {
      const { text } = await readJson(req);
      return sendJson(res, 200, importAccountsLines(text || ''));
    }
    if (p[1] && method === 'DELETE') { deleteAccount(p[1]); return sendJson(res, 200, { ok: true }); }
  }

  // ---- reports ----
  if (p[0] === 'reports') {
    if (p.length === 1 && method === 'GET') return sendJson(res, 200, listReports());
    if (p[1] === 'generate' && method === 'POST') {
      const body = await readJson(req);
      let runCtrl = null;
      try {
        if (body.skipRpa !== true) runCtrl = beginPatrolRun({ source: 'report-generate', platforms: ['xiaohongshu', 'douyin'] });
        const r = await runDailyReport({
          windowType: body.window || cfg.schedule.window,
          force: !!body.force,
          skipRpa: body.skipRpa === true,
          shouldStop: runCtrl?.shouldStop || (() => false),
        });
        return sendJson(res, 200, {
          id: r.report.id,
          eligibleCount: r.eligibleCount,
          aiUsed: r.aiUsed,
          patrolResult: r.patrolResult || null,
          rpaError: r.rpaError || null,
        });
      } catch (e) {
        if (e.code === 'VBP_PATROL_ACTIVE') {
          return sendJson(res, 409, { error: e.message, active: e.active });
        }
        return sendJson(res, 200, { error: String(e.message || e) });
      } finally {
        if (runCtrl) endPatrolRun(runCtrl.id);
      }
    }
    const id = p[1];
    if (id && p.length === 2 && method === 'GET') {
      const r = getReport(id);
      return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: '未找到' });
    }
    if (id && p.length === 2 && method === 'DELETE') {
      const r = deleteReport(id);
      if (!r) return sendJson(res, 404, { error: '未找到' });
      removeReportFiles(r);
      return sendJson(res, 200, { ok: true });
    }
    if (id && p[2] === 'reveal' && method === 'POST') {
      const r = getReport(id);
      if (!r) return sendJson(res, 404, { error: '未找到' });
      const fmt = url.searchParams.get('format') || 'md';
      const path = materializeReportExport(r, fmt);
      if (!path) return sendJson(res, 404, { error: '导出文件不存在，且数据库中没有可恢复的日报正文' });
      try {
        await revealInFileManager(path);
        return sendJson(res, 200, { ok: true, format: fmt, file: basename(path) });
      } catch (e) {
        return sendJson(res, 500, { error: `打开导出文件失败：${e.message}` });
      }
    }
    if (id && p[2] === 'export' && method === 'GET') {
      const r = getReport(id);
      if (!r) return sendJson(res, 404, { error: '未找到' });
      const fmt = url.searchParams.get('format') || 'md';
      const path = materializeReportExport(r, fmt);
      if (!path) return sendJson(res, 404, { error: '导出文件不存在，且数据库中没有可恢复的日报正文' });
      const inline = url.searchParams.get('inline') === '1';
      return serveStatic(res, path, { inline, downloadName: basename(path) });
    }
  }

  return sendJson(res, 404, { error: '未知接口' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const segs = url.pathname.split('/').filter(Boolean);

  // CORS（主要给浏览器插件跨源访问 /api/capture）
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-vb-token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (segs[0] === 'api') return await handleApi(req, res, url, segs);

    // 静态：截图
    if (segs[0] === 'screenshots' && segs[1]) {
      return serveStatic(res, join(SCREENSHOTS_DIR, safeUrlBasename(segs[1])));
    }
    // 静态：仪表盘
    if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
    if (url.pathname === '/favicon.ico') {
      const iconPath = join(PROJECT_ROOT, 'app_icon.png');
      if (existsSync(iconPath)) {
        return serveStatic(res, iconPath);
      }
      res.writeHead(204); res.end(); return;
    }
    const staticFile = join(WEB_DIR, basename(url.pathname));
    if (existsSync(staticFile)) return serveStatic(res, staticFile);

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    log.error('请求处理出错：', e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const urlStr = `http://127.0.0.1:${PORT}`;
  log.info(`Viral Brief Plus 已启动：${urlStr}`);
  log.info(`API Key：${hasApiKey() ? '已配置' : '未配置（请在仪表盘「设置」里填写）'}`);
  startScheduler();
  if ((process.env.VBP_OPEN_BROWSER ?? process.env.VB_OPEN_BROWSER ?? 'true') !== 'false') {
    // 用 execFile + 参数数组，避免 shell 字符串拼接（更安全、无弃用告警）。
    try {
      if (process.platform === 'darwin') {
        const chromePath = '/Applications/Google Chrome.app';
        if (existsSync(chromePath)) {
          execFile('open', ['-a', 'Google Chrome', '--args', `--app=${urlStr}`], () => {});
        } else {
          execFile('open', [urlStr], () => {});
        }
      }
      else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', urlStr], () => {});
      else execFile('xdg-open', [urlStr], () => {});
    } catch { /* 打不开浏览器不影响服务 */ }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log.error(`端口 ${PORT} 已被占用。可设置环境变量 VBP_PORT 换一个端口后重试。`);
  else log.error('服务器错误：', e);
  process.exit(1);
});

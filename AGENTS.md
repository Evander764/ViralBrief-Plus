# AGENTS.md — 项目工程笔记（给开发者 / AI 协作者）

爆款选题雷达 Local：本地内容情报工作台。浏览器插件采集 → 本地 Node 服务（node:sqlite）筛选 → AI 生成每日爆款选题日报。
用户需求与规格来源：《每日爆款选题雷达 Local - 实施计划》。面向用户的说明见 `README.md`。

## 运行 / 测试
- 启动：`npm start`（= `node --disable-warning=ExperimentalWarning server/index.js`），仪表盘 `http://127.0.0.1:8787`。
- 测试：`npm test`（node 内置 test runner）。
- 命令行出日报：`npm run report -- last_7_days`。
- 环境变量：`VB_PORT`、`VB_DATA_DIR`、`VB_OPEN_BROWSER`。
- **要求 Node ≥ 22.5**（用内置 `node:sqlite`、全局 `fetch`）。**运行时零 npm 依赖、零原生编译**——这是「别人本地拿起来即可运行」的硬约束，新增依赖前务必三思。

## 关键不变量（改代码时必须守住）
1. **关键数据绝不靠 AI**。点赞/转发数、双 1000 判定、时间窗口、去重、达标清单的数字，全部走确定性代码（`normalize.js` / `filter.js` / `dedup.js` / `store.js`）。AI 只产出定性内容（选题/聚类/标题/建议）。
2. **未知 ≠ 0**。`normalizeMetric` 识别不到时返回 `value:null`；`null` → `missing_*`（待补录），`< 1000` → `below_threshold`。不要把 null 当 0。
3. **只有 `confirmed` 入榜**。`computeDataStatus` 优先级：duplicate > archived > needs_review(自动且未确认) > below_threshold(已知<1000) > missing_* > confirmed。自动识别的数据在用户确认前一律 `needs_review`。
4. **入榜范围必须收紧**。正式日报只收 `douyin` / `xiaohongshu` / `wechat_channels`，且内容必须关联 `accounts` 账号池；公众号文章和未关联账号的内容可保存、不可入日报。
5. **日报数字从 DB 渲染，不采信 AI 文本**。`report/render.js` 的达标清单只用传入的 `items`（DB 行）。AI 返回 JSON 仅提供母题/原因/标题，且引用的编号（C1..Cn）会被校验必须真实存在。
6. **API Key 安全**：只存桌面端、AES-256-GCM 加密（`lib/secret.js`）、日志脱敏（`lib/log.js` 的 `addRedaction`）、不导出、可清除。插件不存 Key、不调模型。
7. **服务只绑 127.0.0.1**；`/api/*`（除 `/api/health`）需配对 token。

## 数据流
- 采集：插件 `popup.js` 注入页面提取 → `POST /api/capture`（带 `x-vb-token`）→ `store.upsertCapture()`：标准化指标、算 url_key/fingerprint、去重合并、`computeDataStatus`、落库。截图存 `data/screenshots/`，DB 存路径。
- 确认：仪表盘候选池 → `POST /api/contents/:id/confirm` → `store.confirmContent()`：重算指标、强制 `metrics_source='manual'` + `user_confirmed=1`、重算状态。
- 出报：`pipeline.runDailyReport({windowType})`：`recomputeAll(窗口)` → `getEligible(窗口起点)`（三平台 + 账号池 + confirmed + 双 1000）→ 逐条 `analyzeContent`（按 content_id 缓存）→ `generateReportData`（校验编号）→ `render*` → 落 `daily_reports` + 写 `data/exports/`（MD/HTML/CSV/ZIP）。0 达标则用 `fallbackReportData` 跳过 AI。
- 自动：`scheduler.startScheduler()`，setTimeout 到点跑；用 `meta.last_auto_run_date` 防重复；可补跑。设置变更后调 `restartScheduler()`。

## Token 策略（既省又准）
- 省：只分析达标内容；分析永久缓存（`ai_analysis` 按 content_id UNIQUE）；0 达标跳过 AI；日报喂精简摘要；prompt cache（Anthropic ephemeral / OpenAI 前缀）。
- 准：`ai/client.callJSON` 校验失败带原因重试（`cfg.retries`）；用量始终记账（即便 JSON 不合法）；预算仅软提醒，不为省钱牺牲日报。

## 数据库（node:sqlite，`db.js`）
表：`accounts` / `contents` / `ai_analysis`(content_id UNIQUE) / `daily_reports` / `usage_log` / `meta`。
`db.js` 暴露 `run/get/all` 三个 helper，参数经 `sanitize`（boolean→0/1，undefined→null）；node:sqlite 只接受 null/number/bigint/string/Uint8Array，用位置参数 `?`。

## AI 供应商（`ai/client.js`）
- `openai` / `openai-compatible`：`POST {base}/chat/completions`，Bearer。仅官方 openai 用 `response_format:json_object`。
- `anthropic`：`POST {base}/v1/messages`，`x-api-key` + `anthropic-version`，system 块打 `cache_control:ephemeral`。
- 用量统一 `{input, output, cached}` 入 `usage_log`。

## 约定
- ESM（`"type":"module"`），CommonJS 勿混。
- 业务/UI 文案中文；代码注释解释「为什么」。
- 平台代码：`douyin` / `xiaohongshu` / `wechat_channels` / `wechat_article` / `other`。
- 窗口：`last_3_days`（72h）/ `last_7_days`（7×24h）。

## 已知边界 / 待办
- 插件页面指标识别是「尽力而为」，平台改版会失效；**人工修正是主路径**（设计如此）。视频号网页端指标基本靠手填。
- PDF：当前出 Markdown/HTML/CSV，HTML 可浏览器「打印为 PDF」；如需服务端直出 PDF，可选接 puppeteer（会引入大依赖，与「零依赖」目标权衡）。
- 桌面安装包：可用 Tauri/Electron 包壳，内嵌本服务 + `web/`。
- 增强：OS 钥匙串存 Key；RPA 低频巡检账号池（默认进待复核，文档 4.3）。

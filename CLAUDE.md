# CLAUDE.md — 项目工程笔记（给开发者 / AI 协作者）

爆款选题雷达 Local：本地内容情报工作台。浏览器插件采集 → 本地 Node 服务（node:sqlite）筛选 → AI 生成每日爆款选题日报。
用户需求与规格来源：《每日爆款选题雷达 Local - 实施计划》。面向用户的说明见 `README.md`。

## 运行 / 测试
- 启动：`npm start`（= `node --disable-warning=ExperimentalWarning server/index.js`），仪表盘 `http://127.0.0.1:8787`。
- 测试：`npm test`（node 内置 test runner）。
- 命令行出日报：`npm run report -- last_7_days`。
- 环境变量：`VBP_PORT`、`VBP_DATA_DIR`、`VBP_OPEN_BROWSER`（旧 `VB_*` 前缀仍兼容）。
- **要求 Node ≥ 22.5**（用内置 `node:sqlite`、全局 `fetch`）。**运行时零 npm 依赖、零原生编译**——这是「别人本地拿起来即可运行」的硬约束，新增依赖前务必三思。

## 关键不变量（改代码时必须守住）
1. **关键数据绝不靠 AI**。点赞/转发/收藏、1000 阈值判定、时间窗口、去重、达标清单的数字，全部走确定性代码（`normalize.js` / `filter.js` / `dedup.js` / `store.js`）。AI 只产出定性内容（选题/聚类/标题/建议）。
2. **未知 ≠ 0**。`normalizeMetric` 识别不到时返回 `value:null`；`null` 表示待复核/待补录，已知值 `< 1000` 才是 `below_threshold`。不要把 null 当 0。
3. **只有 `confirmed` 入榜**。`computeDataStatus` 优先级：duplicate > archived > monitoring(未确认且 24h 内) > needs_review(自动且未确认) > confirmed / below_threshold。自动弱来源在用户确认前不入榜。
4. **入榜范围必须收紧**。正式日报只收 `douyin` / `xiaohongshu`，且内容必须关联 `accounts` 账号池；视频号、公众号文章和未关联账号的内容可保存、不可入日报。
   - 小红书入选必须 `like` 和 `favorite` 都达标；抖音入选必须 `like`、`favorite`、`share` 都达标。`1000+` 按超过 1000，纯 1000 不达标。
5. **日报数字从 DB 渲染，不采信 AI 文本**。`report/render.js` 的达标清单只用传入的 `items`（DB 行）。AI 返回 JSON 仅提供母题/原因/标题，且引用的编号（C1..Cn）会被校验必须真实存在。
6. **API Key 安全**：只存桌面端、AES-256-GCM 加密（`lib/secret.js`）、日志脱敏（`lib/log.js` 的 `addRedaction`）、不导出、可清除。插件不存 Key、不调模型。
7. **服务只绑 127.0.0.1**；`/api/*`（除 `/api/health`）需配对 token。
8. **RPA 只负责顺序采集，不负责入选判断**。每读完一条详情内容，先记录/规范化发布时间和指标，再截图入库；未知时间、超窗口、未达阈值都要进入内容库。巡检阶段不因时间窗口或标题匹配判断而丢弃已打开详情；小红书/抖音非置顶详情若已确认早于窗口，保存本条后可结束当前博主巡检。正式日报只在巡检结束后的 `recomputeAll()` / `getEligible()` 阶段筛选。

## 巡检流程（当前唯一口径）
- 巡检前先排序：前端/API 实际按平台阶段执行，小红书阶段整体先于抖音阶段；每个阶段内部评级越高越前，同评级按 `created_at` 更早优先；缺少时间时随机打散。`sortPatrolAccounts()` 仍保留混合列表的同评级小红书优先规则。
- API 阶段拆开：前端先调用 `/api/patrol/run` 跑 `{ platform: "xiaohongshu" }`，完成后再调用 `{ platform: "douyin" }`；`/api/reports/generate` 在前端阶段巡检后只负责生成日报。服务端 pipeline 自跑 RPA 时也按小红书、抖音两个阶段。
- 单活跃巡检：同一时间只允许一个巡检运行；已有巡检时，新的 `/api/patrol/run` 或含 RPA 的 `/api/reports/generate` 必须返回 409，并保留原巡检的停止控制。
- 并发标签：`rpa.maxTabsPerBatch` 默认 6，允许 1-10；内存不足可自动下调。多标签模式每个账号标签使用独立 CDP client，账号跑完立即关标签。
- 停止控制：`POST /api/patrol/stop` 设置当前巡检 stop flag；长循环、批次和详情采集都要检查 `shouldStop` 并收尾关闭标签；尚未实际处理完成的账号不得写 `last_patrolled_at`。
- 当天防重复：账号实际处理完成后写 `last_patrolled_at`；默认跳过北京时间当天已经跑过的账号。

### 小红书阶段
- 只打开已登录 Chrome 中的小红书主页，每批默认 6 个账号 URL。
- 主页卡片按行从左到右、从上到下检查；每个账号最多检查 `maxCandidatesPerAccount` 条候选；置顶内容不进详情。
- 每次点击记录卡片位置；同一账号内下一次点击必须在上一次点击右侧。发现同一候选 URL 或同一详情 URL 在本轮打开两次，立刻停止该账号。
- 已采集过的数据库重复内容只记录去重，不作为最终停止条件；是否结束当前账号以详情页读到的发布时间为准。本轮重复打开检测只用于防止页面卡在同一处。
- 点开详情后读取标题、作者、封面、视频时长、正文、发布时间、点赞/红心、收藏、评论；可采内容一律截图并入库。
- 主动读取详情页标题/正文下方的“编辑于 XXX”发布时间；发布时间缺失、标题不匹配或互动未达标都不阻断保存；若非置顶详情发布时间早于窗口，保存本条后结束该博主巡检；是否入选留到巡检后判断。
- 保存或不可采跳过详情后优先点击左上角关闭按钮回主页，不重新打开主页 URL。

### 抖音阶段
- 小红书阶段结束后再发起新的抖音巡检 API。
- 账号有主页 URL 则打开；无 URL 时通过搜索找博主主页。
- 从主页候选中跳过置顶，先点击第一条非置顶视频进入详情页；随后优先点击右侧“下一个/下箭头”连续翻后续视频，按钮缺失、点击无变化或离开详情页时再回退到逐候选详情链接方案。
- 每条详情必须读取封面/首帧、标题、正文、发布时间、点赞、收藏、转发、评论。发布日期优先读取详情页“举报”附近的可见文本。
- 详情页先暂停视频，再提取数据；可采内容一律截图并入库。
- 发布时间缺失、超窗口、标题不匹配或互动未达标都不阻断保存；抖音详情发布日期早于窗口时，保存本条后结束该博主巡检；是否入选留到巡检后判断。
- 全部账号完成或剩余账号正在跑时不再额外开新标签；单个账号跑完立即关闭自己的标签。

### 微信视觉巡检阶段（视频号 / 公众号，OS 级，独立于抖音/小红书）
- **为什么不一样**：视频号/公众号互动数只在微信桌面端 App 内显示，微信不暴露 CDP 调试端口，Chrome 那套 `goto`/`evaluate` 够不到。所以这条线走 **OS 级视觉 Agent**：`screencapture` 截图 + `osascript`（JXA + CoreGraphics CGEvent）坐标点击/滚动（`server/rpa/macos-input.js`，零依赖、仅 macOS），视觉模型 `ai/observe.js` 的 `locateWechatTarget`（定位按钮像素坐标）/ `readWechatDetail`（读标题/发布时间/互动数）驱动导航（`server/rpa/wechat.js`）。
- **数字不可信**：视觉读出的数字一律 `metrics_source='desktop_agent'` → needs_review，人工确认前绝不自动达标（不变量 #1）。视觉定位 prompt 禁止点击点赞/支付/验证码等敏感按钮。
- **不入日报**：视频号/公众号只进独立「视频号·公众号热点」视图（`GET /api/wechat/hotspots`，前端「微信热点」页），按 `server/wechat/score.js` 的时间衰减档位（early_breakout/qualified/watch/below/unknown）排序；绝不进正式每日日报（不变量 #4）。
- **视频号导航**：朋友圈下方视频号入口 → 右上小人 → 赞和收藏 → 关注 → 逐个关注博主 → 首进先 Esc 关掉自动播放的第一个视频（防外放/省内存）→ 跳置顶 → 开第一条读数入库 → 点右侧下箭头翻页 → 默认每博主 `cfg.wechat.maxVideosPerCreator`(3) 条 → 关详情回关注总览。
- **公众号导航**：左上搜索 → 搜博主 → 进主页（没进就点右上小人）→ 跳置顶/付费 → 按窗口开文章 → `parseChinesePublishTime` 读精确发布时间（北京时间）→ 早于窗口即结束该博主 → 入库。
- **入口**：`POST /api/wechat/patrol/run`（body `{platform:'wechat_channels'|'wechat_article'}`），复用 `control.js` 单活跃巡检 + `/api/patrol/stop` 停止控制（与抖音/小红书互斥）。前端「微信热点巡检」先视频号阶段、后公众号阶段。
- **坐标导航需在本机实跑校准**：窗口位置因人而异，找不到目标时记录跳过原因、不瞎点。

## 数据流
- 采集（三条入口，殊途同归到 `store.upsertCapture()`）：
  - 插件 `popup.js` 注入页面提取 → `POST /api/capture`（`metrics_source='manual'`/`page_text'`）。
  - 桌面视觉 Agent（CDP/截图）→ `POST /api/agent/ingest`（`metrics_source='desktop_agent'` → needs_review）。
  - **粘贴链接服务端抓取** `POST /api/ingest`：`ingest/scrape.js` 用 `fetch` 拉 HTML → `extractFromHtml`（复用 `extension/extract-core.js`，从 `__INITIAL_STATE__`/`RENDER_DATA`/og 解析）→ `metrics_source='scraped'` → needs_review。纯 HTTP 抓取「尽力而为」：常只拿到 JS 外壳/验证页，抓不到数字属正常，缺的进待补录。**不做反爬绕过/验证码/签名伪造**。
  - 共同：`upsertCapture()` 标准化指标、算 url_key/fingerprint、去重合并、账号池自动关联、`computeDataStatus`、落库；截图存 `data/screenshots/`。
- 确认：仪表盘候选池 → `POST /api/contents/:id/confirm` → `store.confirmContent()`：重算指标、强制 `metrics_source='manual'` + `user_confirmed=1`、重算状态。
- 账号池打开：`POST /api/accounts/open-platform` 从当前 DB 筛选有效平台主页（小红书 `/user/profile/<id>`），一次性交给 Chrome 打开为多个标签页；`POST /api/browser/open` 保留单 URL 兼容并支持 `{ urls: [...] }`。
- 出报：`pipeline.runDailyReport({windowType})`：可选先跑小红书、抖音 RPA 阶段 → `recomputeAll(窗口)` → `getEligible(窗口起点)`（小红书/抖音 + 账号池 + confirmed + 平台必需指标都达标）→ 逐条 `analyzeContent`（按 content_id 缓存）→ `generateReportData`（校验编号）→ `render*` → 落 `daily_reports` + 写 `data/exports/`（MD/HTML/CSV/ZIP）。0 达标则用 `fallbackReportData` 跳过 AI。
- 自动：`scheduler.startScheduler()`，setTimeout 到点跑；用 `meta.last_auto_run_date` 防重复；可补跑。设置变更后调 `restartScheduler()`。

## Token 策略（既省又准）
- 省：只分析达标内容；分析永久缓存（`ai_analysis` 按 content_id UNIQUE）；0 达标跳过 AI；日报喂精简摘要；prompt cache（Anthropic ephemeral / OpenAI 前缀）。
- 准：`ai/client.callJSON` 校验失败带原因重试（`cfg.retries`）；用量始终记账（即便 JSON 不合法）；预算仅软提醒，不为省钱牺牲日报。

## 数据库（node:sqlite，`db.js`）
表：`accounts` / `contents` / `ai_analysis`(content_id UNIQUE) / `daily_reports` / `usage_log` / `meta` / `agent_observations`。`contents` 的指标列：`like/share/comment/favorite/read`（`read_count` 是公众号阅读量，热点评分主信号，非 1000 阈值入选指标）。
`db.js` 暴露 `run/get/all` 三个 helper，参数经 `sanitize`（boolean→0/1，undefined→null）；node:sqlite 只接受 null/number/bigint/string/Uint8Array，用位置参数 `?`。

## AI 供应商（`ai/client.js`）
- `openai` / `openai-compatible`：`POST {base}/chat/completions`，Bearer。仅官方 openai 用 `response_format:json_object`。
- `anthropic`：`POST {base}/v1/messages`，`x-api-key` + `anthropic-version`，system 块打 `cache_control:ephemeral`。
- 用量统一 `{input, output, cached}` 入 `usage_log`。

## 约定
- ESM（`"type":"module"`），CommonJS 勿混。
- 业务/UI 文案中文；代码注释解释「为什么」。
- 平台代码：`douyin` / `xiaohongshu` / `wechat_channels` / `wechat_article` / `other`。
- 窗口：程序接受 `last_N_day(s)` 并统一规范化成 `last_N_days`；常用 `last_1_day` / `last_3_days` / `last_7_days`。

## 已知边界 / 待办
- 插件页面指标识别是「尽力而为」，平台改版会失效；**人工修正是主路径**（设计如此）。视频号网页端指标基本靠手填。
- PDF：当前出 Markdown/HTML/CSV，HTML 可浏览器「打印为 PDF」；如需服务端直出 PDF，可选接 puppeteer（会引入大依赖，与「零依赖」目标权衡）。
- 桌面安装包：可用 Tauri/Electron 包壳，内嵌本服务 + `web/`。
- 增强：OS 钥匙串存 Key；浏览器上下滑动控制 API。

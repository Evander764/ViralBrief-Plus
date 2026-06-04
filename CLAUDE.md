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
4. **入榜范围必须收紧**。网页正式日报只收 `douyin` / `xiaohongshu`，且内容必须关联 `accounts` 账号池；视频号、公众号文章和未关联账号的内容可保存、不可入网页日报。微信日报是独立入口，只收 `wechat_channels` / `wechat_article` 中已人工确认、已关联账号池、未归档且非重复的窗口内内容，不走 1000 阈值。
   - 小红书入选必须 `like` 和 `favorite` 都达标；抖音入选必须 `like`、`favorite`、`share` 都达标。`1000+` 按超过 1000，纯 1000 不达标。
5. **日报数字从 DB 渲染，不采信 AI 文本**。`report/render.js` 的达标清单只用传入的 `items`（DB 行）。AI 返回 JSON 仅提供母题/原因/标题，且引用的编号（C1..Cn）会被校验必须真实存在。
6. **API Key 安全**：只存桌面端、AES-256-GCM 加密（`lib/secret.js`）、日志脱敏（`lib/log.js` 的 `addRedaction`）、不导出、可清除。插件不存 Key、不调模型。
7. **服务只绑 127.0.0.1**；`/api/*`（除 `/api/health`）需配对 token。
8. **RPA 只负责顺序采集，不负责入选判断**。每读完一条详情内容，先记录/规范化发布时间和指标，再截图入库；未知时间、超窗口、未达阈值都要进入内容库。巡检阶段不因时间窗口或标题匹配判断而丢弃已打开详情；小红书/抖音非置顶详情若已确认早于窗口，保存本条后可结束当前博主巡检。正式日报只在巡检结束后的 `recomputeAll()` / `getEligible()` 阶段筛选。

## 巡检流程（当前唯一口径）
- 巡检前先排序：前端/API 实际按平台阶段执行，网页内容小红书阶段整体先于抖音阶段（视频号桌面巡检已移除）；每个阶段内部评级越高越前，同评级按 `created_at` 更早优先；缺少时间时随机打散。`sortPatrolAccounts()` 仍保留混合列表的同评级小红书优先规则。
- API 阶段拆开：网页内容前端依次调用 `/api/patrol/run` 跑 `{ platform: "xiaohongshu" }`、`{ platform: "douyin" }`；微信视频号由独立按钮调用 `/api/patrol/run` 跑 `{ platform: "wechat_channels" }`。小红书/抖音由 Chrome CDP 巡检，`wechat_channels` 只操作 macOS 微信客户端内的视频号，不打开网页版视频号；`/api/reports/generate` 默认生成 `reportType:"web"` 网页日报，`reportType:"wechat"` 生成微信日报。
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

### 视频号阶段（已移除，待重做）
- 旧的视频号桌面巡检（`server/rpa/wechat-desktop.js` / `wechat-locator.js` / `wechat-swift.js`，靠系统截图 + 合成鼠标驱动 macOS 桌面微信）已**整体删除**：太慢、太脆——微信几乎不向 Accessibility 暴露可读控件（实测窗口正文「控件 0」），只能截图猜像素，进个视频号要 100s 还经常失败。将从零重做。当前**没有任何 `wechat_channels` 自动采集入口**（API/前端按钮都已移除）。
- 仍保留的：`wechat_channels` 作为平台/内容类型，以及 store / filter / 链接 / 阈值 / 去重 的处理；**微信日报**（`pipeline.runWechatReport`）只基于已人工确认、已关联账号池、未归档、非重复的窗口内微信内容生成，**不再触发任何 RPA 巡检**。视频号内容目前只能通过其他方式进入内容库（手动确认、或未来重做的巡检）。
- 重做时可参考的关键事实（实测）：① 微信主窗口对 AX 不暴露正文，但**窗口几何 + 红黄绿按钮**用 AX C API 可秒读；② 点左栏「视频号」蝴蝶/光圈图标会新开一个标题含「窗口」的独立窗口（`com.tencent.flue.WeChatAppEx`），「是否冒出该窗口」是比暗色像素稳得多的进入成功判据；③ 视频号首页是白色 feed，不是黑视频，旧的「黑屏=已进入」判据是错的。这些验证记录在 `speed/wechat-entry` 分支里（本分支即从它复制而来）。

## 数据流
- 采集（三条入口，殊途同归到 `store.upsertCapture()`）：
  - 插件 `popup.js` 注入页面提取 → `POST /api/capture`（`metrics_source='manual'`/`page_text'`）。
  - 桌面视觉 Agent（CDP/截图）→ `POST /api/agent/ingest`（`metrics_source='desktop_agent'` → needs_review）。
  - **粘贴链接服务端抓取** `POST /api/ingest`：`ingest/scrape.js` 用 `fetch` 拉 HTML → `extractFromHtml`（复用 `extension/extract-core.js`，从 `__INITIAL_STATE__`/`RENDER_DATA`/og 解析）→ `metrics_source='scraped'` → needs_review。纯 HTTP 抓取「尽力而为」：常只拿到 JS 外壳/验证页，抓不到数字属正常，缺的进待补录。**不做反爬绕过/验证码/签名伪造**。
  - 共同：`upsertCapture()` 标准化指标、算 url_key/fingerprint、去重合并、账号池自动关联、`computeDataStatus`、落库；截图存 `data/screenshots/`。
- 确认：仪表盘候选池 → `POST /api/contents/:id/confirm` → `store.confirmContent()`：重算指标、强制 `metrics_source='manual'` + `user_confirmed=1`、重算状态。
- 账号池打开：`POST /api/accounts/open-platform` 只筛选小红书 `/user/profile/<id>` 和抖音 `/user/<id>` 主页并交给 Chrome 打开；视频号不走浏览器打开（桌面巡检已移除，待重做）。
- 出报：`pipeline.runDailyReport({windowType})` 生成网页日报：可选先跑小红书、抖音 Chrome RPA 阶段 → `recomputeAll(窗口)` → `getEligible(窗口起点)`（小红书/抖音 + 账号池 + confirmed + 平台必需指标都达标）→ 逐条 `analyzeContent`（按 content_id 缓存）→ `generateReportData`（校验编号）→ `render*` → 落 `daily_reports(report_type='web')` + 写 `data/exports/`（MD/HTML/CSV/ZIP）。`pipeline.runWechatReport({windowType})` 生成微信日报：只取 `wechat_channels` / `wechat_article` 中窗口内、已人工确认、已关联账号池、未归档、非重复内容，落 `daily_reports(report_type='wechat')`。0 条则用 `fallbackReportData` 跳过 AI。
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

## 打包与版本命名（macOS app）
- 只有一个正式 app，名字固定 `Viral Brief Plus`，数据目录 `~/Library/Application Support/Viral Brief Plus`。不要用 `VBP_MAC_APP_NAME` 改名打包。
- 版本号即唯一标识，遵循语义化版本；`scripts/package-macos-app.js` 的 `versionTag = pkg.version`，产物名只带版本号、不再拼时间戳。
- 新功能使用 `npm run release:feature`，优化/修复使用 `npm run release:fix`；只改版本号可用 `npm run version:feature` / `npm run version:fix`。
- Info.plist 的 `CFBundleShortVersionString` 与 `CFBundleVersion` 都取 `pkg.version`。

## 约定
- ESM（`"type":"module"`），CommonJS 勿混。
- 业务/UI 文案中文；代码注释解释「为什么」。
- 平台代码：`douyin` / `xiaohongshu` / `wechat_channels` / `wechat_article` / `other`。
- 窗口：程序接受 `last_N_day(s)` 并统一规范化成 `last_N_days`；常用 `last_1_day` / `last_3_days` / `last_7_days`。

## 已知边界 / 待办
- 插件页面指标识别是「尽力而为」，平台改版会失效；**人工修正是主路径**（设计如此）。视频号桌面端会采集最新若干条视频的文案、截图和互动指标，但仍默认进入待复核，不自动入微信日报。
- PDF：当前出 Markdown/HTML/CSV，HTML 可浏览器「打印为 PDF」；如需服务端直出 PDF，可选接 puppeteer（会引入大依赖，与「零依赖」目标权衡）。
- 桌面安装包：可用 Tauri/Electron 包壳，内嵌本服务 + `web/`。
- 增强：OS 钥匙串存 Key；浏览器上下滑动控制 API。

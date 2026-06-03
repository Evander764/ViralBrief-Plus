---
name: rpa-report
description: |
  RPA 驱动的全链路爆款选题日报生成。
  通过 Chrome DevTools Protocol 控制小红书/抖音真实浏览器，并通过 macOS System Events 控制桌面微信视频号，
  然后自动调用 AI 做定性摘录和内容归类，最终输出包含母题/标题/建议的完整日报。
---

# RPA 驱动的全链路日报生成 Skill

## 概述

本 Skill 封装了「爆款选题雷达 Local」的核心工作流：

1. **启动 RPA** → 自动拉起带有调试端口的独立 Chrome 实例；微信视频号优先从桌面微信主窗口左侧栏进入，程序坞视频号独立窗口只作兜底
2. **逐账号采集** → 小红书/抖音跳转主页并采集详情；视频号进入当前视频号窗口后点击右上角小人，进入关注总览，按昵称打开博主并采集最新若干条视频
3. **截图存档** → 对每个详情页自动截图，存入 `data/screenshots/`
4. **数据入库** → 采集的数据通过去重机制写入本地 SQLite 数据库
5. **确定性筛选** → 巡检全部结束后按窗口、账号池、确认状态和平台必需指标筛出达标内容
6. **AI 摘录** → 对达标内容逐条调用 AI 做结构化摘录（结果按 content_id 永久缓存）
7. **生成日报** → AI 归类出母题、可复用标题、商业建议，渲染为 Markdown/HTML/CSV

## 前置条件

- **Node.js ≥ 22.5**（使用内置 `node:sqlite` 和全局 `fetch`）
- **Google Chrome** 已安装（小红书/抖音）
- **macOS 微信客户端** 已登录且允许辅助功能控制；巡检微信视频号前，主微信窗口左侧栏需要能看到视频号入口，程序坞里的绿色视频号独立窗口只作为主入口失败后的兜底
- **API Key** 已在设置中配置（支持 OpenAI / DeepSeek / 小米 MiMo / Anthropic 等）
- **账号池** 中至少有 1 个开启了 `monitor_enabled` 的账号

## 调用方式

### 方式一：网页 UI（推荐）

1. 启动应用：`npm start` 或双击 `Viral Brief Plus.app`
2. 打开 `http://127.0.0.1:8787`
3. 在「概览」页面：
   - 回溯天数使用「设置」里的默认回溯天数
   - 勾选「先自动采集（RPA）」
   - 点击「生成网页日报」
   - 如需微信内容，单独点击「巡检微信视频号」和「生成微信日报」
4. 网页日报会自动完成 小红书巡检 API → 抖音巡检 API → 候选/内容库刷新 → AI 摘录/归类 → 日报输出；微信日报只整理已人工确认的微信视频号/公众号内容

### 方式二：API 调用

```bash
# 含 RPA 采集的完整日报
curl -X POST http://127.0.0.1:8787/api/reports/generate \
  -H "Content-Type: application/json" \
  -H "x-vb-token: YOUR_PAIRING_TOKEN" \
  -d '{"window": "last_3_days"}'

# 跳过 RPA，仅用已有数据生成日报
curl -X POST http://127.0.0.1:8787/api/reports/generate \
  -H "Content-Type: application/json" \
  -H "x-vb-token: YOUR_PAIRING_TOKEN" \
  -d '{"window": "last_3_days", "skipRpa": true}'

# 仅执行 RPA 巡检（不生成日报）
curl -X POST http://127.0.0.1:8787/api/patrol/run \
  -H "Content-Type: application/json" \
  -H "x-vb-token: YOUR_PAIRING_TOKEN" \
  -d '{"window": "last_3_days", "platform": "xiaohongshu", "maxTabsPerBatch": 6}'

# 停止当前巡检
curl -X POST http://127.0.0.1:8787/api/patrol/stop \
  -H "x-vb-token: YOUR_PAIRING_TOKEN"
```

说明：网页 UI 的网页日报主路径是先分两次调用 `/api/patrol/run`（小红书 → 抖音），再用 `skipRpa:true` 调 `/api/reports/generate` 出 `reportType:"web"`；微信视频号巡检由独立按钮/API 调用 `platform:"wechat_channels"`，微信日报用 `reportType:"wechat"` 生成。`/api/reports/generate` 不带 `skipRpa` 仍保留为脚本/兼容调用，但会按 `reportType` 只跑对应 RPA 阶段。

### 方式三：命令行

```bash
# 完整日报（含 RPA）
npm run report -- last_3_days

# 仅巡检
npm run patrol
```

## 技术架构

### 模块组成

| 模块 | 路径 | 职责 |
|------|------|------|
| CDP 客户端 | `server/rpa/cdp.js` | 零依赖 WebSocket 封装，提供 `goto / evaluate / screenshot / waitForSelector` |
| Chrome 启动器 | `server/rpa/chrome-launcher.js` | 管理 Chrome 进程生命周期：启动、端口就绪检测、关闭 |
| 巡检模块 | `server/rpa/patrol.js` | Chrome 平台级采集逻辑（抖音/小红书），返回结构化结果 |
| 桌面微信视频号 | `server/rpa/wechat-desktop.js` | 通过 macOS System Events 操作桌面微信视频号，采集待复核的视频文案、截图和互动指标 |
| Pipeline | `server/pipeline.js` | 编排全流程：RPA → 筛选 → AI 摘录/归类 → 渲染 → 导出 |

### 数据流向

```
Chrome (小红书/抖音)
  ↓ CDP WebSocket
CDPClient.evaluate() → 注入 JS 提取 DOM 数据
桌面微信 (视频号，优先从主微信左侧栏进入)
  ↓ osascript / System Events
红黄绿窗口锚点 → 左侧栏视频号入口 → 右上角小人 → 左侧栏关注 → 悬停关闭关注左侧随机推荐标签 → 按昵称打开博主 → 采集最新视频文案/指标/截图
  ↓
patrol.saveData() → upsertCapture() → SQLite contents 表
  ↓
pipeline.getEligible() → 确定性筛选（平台必需指标）
  ↓
analyzeContent() → AI API → ai_analysis 表（缓存）
  ↓
generateReportData() → AI 内容归类
  ↓
renderMarkdown/Html/Csv → data/exports/
```

### 关键不变量

1. **所有互动数字来自数据库，不来自 AI** — 日报中的点赞/转发/收藏/评论由 RPA 采集或人工确认，AI 只提供定性内容
2. **RPA 失败不阻断日报管线** — 通过 `/api/reports/generate` 或 `runDailyReport()` 自跑 RPA 时，如果浏览器连接失败，pipeline 会降级使用已有数据继续；单独调用 `/api/patrol/run` 仍会把巡检错误返回给调用方
3. **截图作为证据链** — 每次采集自动截图，存入 `data/screenshots/`，与内容记录关联
4. **采集结果按证据强度入库** — 稳定 RPA 证据可直接 `confirmed`，弱证据/缺数仍进「今日候选」等待人工确认
5. **置顶内容绝不进入详情页** — 小红书左上角红色“置顶”、抖音左上角黄色“置顶”必须由 DOM 位置和颜色规则先过滤；不要让 AI/API 模型判断，也不要点进详情页后再补救
6. **巡检按排序和平台阶段执行** — 网页日报前端先跑小红书 API，再跑抖音 API；桌面微信视频号由独立入口发起；每个阶段内评级越高越先，同评级按添加时间
7. **并发范围固定** — 默认每批 6 个账号标签，允许 1-10；内存保护可降到 1；上一批标签确认关闭后才开下一批
8. **巡检阶段不做入选判断** — 详情时间未知、超窗口、标题不匹配、未达阈值都先保存；是否入日报只在巡检后的筛选阶段决定
9. **小红书详情采集口径** — 详情页必须读取标题、作者、封面、视频时长、正文、发布时间、点赞/红心、收藏、评论；可采详情一律截图入库
10. **抖音详情采集口径** — 详情页必须读取封面/首帧、标题、正文、发布时间、点赞、收藏、转发、评论；可采详情一律截图入库
11. **小红书保留主页瀑布流状态** — 从博主主页点开笔记后，采集完成优先点击左上角关闭/返回按钮回到主页；不要每条都重开主页 URL
12. **重复打开保护** — 小红书同账号内每次点击必须在上次点击右侧；同一候选 URL 或详情 URL 打开两次，立即停止该账号
13. **单活跃巡检** — 同一时间只允许一个巡检；重复启动 `/api/patrol/run` 或含 RPA 的 `/api/reports/generate` 必须返回 409，不能覆盖原巡检的停止状态
14. **停止巡检可收尾退出** — `/api/patrol/stop` 设置停止标记；长循环和批次处理都必须检查 `shouldStop`，并关闭已经打开的标签页
15. **当天防重复巡检** — 账号实际处理完成后才写 `last_patrolled_at`；停止前尚未处理完成的账号不得标记，当天已跑过的账号默认跳过
16. **每读完一条详情必须立即记录时效** — 详情页数据读取完成后，先记录并标准化发布时间，再检查是否落在本次窗口内；未知时间和超出窗口都保存后待复核或筛选排除，是否入日报只在巡检后的筛选阶段决定

## 当前巡检流程清单

### 巡检前

1. 网页巡检读取账号池中 `monitor_enabled = true` 的小红书、抖音账号；微信视频号巡检由独立入口读取视频号账号。
2. 默认跳过北京时间当天已经巡检过的账号，除非调用方显式要求包含。
3. 排序：网页内容小红书阶段整体先于抖音阶段；桌面微信视频号单独发起。每个阶段内评级高优先，同评级添加更早优先；缺添加时间随机。
4. 读取设置中的 `rpa.maxTabsPerBatch`，默认 6，范围 1-10，并按可用内存下调。

### 小红书

1. 开始小红书阶段，按批次同时打开最多 6 个已登录 Chrome 主页标签。
2. 每个标签独立 CDP client，只负责一个账号。
3. 主页候选按左到右、上到下检查；每个账号最多检查 `maxCandidatesPerAccount` 条；置顶跳过。
4. 点击卡片前记录位置；下一次点击必须在上一次右侧。
5. 点开详情后读取标题、作者、封面、视频长短、正文、发布时间、红心/点赞、收藏、评论。
6. 发布时间缺失或超窗口都保存；标题不匹配和互动未达标也不阻断保存。
7. 详情 URL 或候选 URL 在同一账号本轮重复：停止该账号。
8. 只要详情可采就截图、入库，内容会出现在今日候选和内容库；点赞和收藏是否达标留给巡检后的筛选阶段。
9. 详情处理后优先点击左上角关闭按钮回主页。
10. 账号实际处理完成后标记当日已巡检，然后关闭该标签；停止前未处理完成则不标记。

### 抖音

1. 小红书阶段结束后，应用发起新的抖音巡检 API。
2. 账号有主页 URL 就直接打开；没有 URL 时从搜索页找对应博主。
3. 从主页候选中跳过置顶，先点击第一条非置顶视频进入详情页。
4. 详情页处理完成后优先点击右侧“下一个/下箭头”连续翻后续视频；按钮缺失、点击无变化或离开详情页时，回退到逐候选详情链接方案。
5. 每条详情先暂停视频，再读取封面/首帧、标题、正文、发布时间、点赞、收藏、转发、评论。
6. 发布时间缺失或超窗口都保存；标题不匹配和互动未达标也不阻断保存。
7. 只要详情可采就截图、入库；点赞、收藏和转发是否达标留给巡检后的筛选阶段。
8. 账号实际处理完成后标记当日已巡检，标签页立即关闭；已在跑的账号继续收尾，不再额外开新标签，停止前未处理完成则不标记。

### 视频号

1. 视频号只指 macOS 微信客户端内的视频号，不打开或识别任何网页视频号链接。
2. 系统先激活桌面微信主窗口，通过红黄绿窗口按钮确定窗口位置，再从左侧栏点击视频号入口；进入后用系统全屏截图确认当前微信窗口已经是视频号界面。程序坞里的绿色视频号独立窗口只在主入口失败时兜底。系统不打开网页视频号、不点击主微信 Dock 图标或相邻应用，也不重启微信。
3. 进入视频号后，系统点击右上角小人入口，必要时先从视频详情页点击左上返回，最多返回 2 次；随后进入赞和收藏/个人总览。
4. “关注”只允许在右上角小人入口后的左侧栏点击；禁止把顶部视频流“关注”当成目标入口。由于视频号窗口可移动、可缩放，左侧栏“关注”必须通过当前系统截图或可读 AX 控件现场识别；识别不到时只输出窗口锚点和几何参考诊断，不允许按参考坐标继续点击。
5. 进入关注总览后保护标题含“关注”的标签，关闭其左侧紧邻的随机推荐视频标签。关闭时必须先把鼠标悬停在该标签页上，等待 `×` 显示后再点击当前截图或 AX 识别到的 `×`；没有左侧随机推荐标签时返回 no-op success，识别不到 `×` 时停止并给诊断。
6. 按账号池昵称打开博主主页；每个博主默认读取 `rpa.wechatVideosPerAccount = 3` 条，可在 1-10 间调整。
7. 跳过置顶、直播和预约内容；打开第一条非置顶视频，暂停/展开文案，采集点赞、转发、收藏/红心、评论和截图，再用右侧向下箭头切到下一条。
8. 采集结果写入 `wechat-desktop://content/<account-id>/<date>/<index>`，指标证据写入 `metrics_evidence_json`；默认待复核，不自动确认，人工确认后才进入微信日报。

### 巡检后

1. 前端刷新今日候选和内容库。
2. 再调用 `/api/reports/generate` 且 `skipRpa = true`，先跑 `recomputeAll` / `getEligible` 做确定性筛选，再基于达标内容生成日报。
3. 0 条达标时跳过 AI，直接生成样本不足报告。

## 故障排除

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| "无法连接到浏览器" | Chrome 未启动或端口被占用 | 确保 9222 端口未被其他进程占用 |
| 页面加载超时 | 网络慢或页面结构变化 | 增大 `cdp.goto()` 的超时时间 |
| 指标提取为 null | 平台改版导致 CSS 选择器失效 | 更新 `patrol.js` 中的选择器 |
| Chrome 启动后无页面 | user-data-dir 损坏 | 删除当前数据目录下的 `chrome-profile` 目录重试；打包 App 默认在 `~/Library/Application Support/Viral Brief Plus/chrome-profile`，开发启动默认在 `data/chrome-profile` |
| 登录态失效 | Cookie 过期 | 手动在 RPA Chrome 中重新登录 |

## 扩展指南

### 添加新平台支持

在 `server/rpa/patrol.js` 中：

1. 新增 `patrolNewPlatform(client, acc, progress)` 函数
2. 在 `runPatrol()` 的 switch 分支中添加对应 case
3. 实现平台特定的 CSS 选择器和数据提取逻辑

### 自定义选择器

所有 CSS 选择器都在 `patrol.js` 的 `evaluate()` 调用中以数组形式定义，支持多个备选选择器自动降级：

```javascript
const like = getText([
  '[data-e2e="video-player-digg"]',  // 首选
  '[data-e2e="digg-count"]',          // 备选 1
  '.like-cnt',                         // 备选 2
]);
```

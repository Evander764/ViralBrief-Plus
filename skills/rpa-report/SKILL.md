---
name: rpa-report
description: |
  RPA 驱动的全链路爆款选题日报生成。
  通过 Chrome DevTools Protocol 控制真实浏览器，逐账号跳转主页提取最新内容数据并截图，
  然后自动调用 AI 进行分析聚类，最终输出包含母题/标题/建议的完整日报。
---

# RPA 驱动的全链路日报生成 Skill

## 概述

本 Skill 封装了「爆款选题雷达 Local」的核心工作流：

1. **启动 RPA 浏览器** → 自动拉起带有调试端口的独立 Chrome 实例
2. **逐账号采集** → 跳转到每个关注博主的主页，定位最新内容，提取点赞/转发等指标
3. **截图存档** → 对每个详情页自动截图，存入 `data/screenshots/`
4. **数据入库** → 采集的数据通过去重机制写入本地 SQLite 数据库
5. **AI 分析** → 对达标内容逐条调用 AI 进行深度分析（结果按 content_id 永久缓存）
6. **生成日报** → AI 聚类出母题、可复用标题、商业建议，渲染为 Markdown/HTML/CSV

## 前置条件

- **Node.js ≥ 22.5**（使用内置 `node:sqlite` 和全局 `fetch`）
- **Google Chrome** 已安装
- **API Key** 已在设置中配置（支持 OpenAI / DeepSeek / 小米 MiMo / Anthropic 等）
- **账号池** 中至少有 1 个开启了 `monitor_enabled` 的账号

## 调用方式

### 方式一：网页 UI（推荐）

1. 启动应用：`npm start` 或双击 `Viral Brief.app`
2. 打开 `http://127.0.0.1:8787`
3. 在「概览」页面：
   - 设置回溯天数
   - 勾选 ✅「先自动采集（RPA）」
   - 点击「立即生成日报」
4. 系统会自动完成 浏览器采集 → AI 分析 → 日报输出 的全流程

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
  -H "x-vb-token: YOUR_PAIRING_TOKEN"
```

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
| 巡检模块 | `server/rpa/patrol.js` | 平台级采集逻辑（抖音/小红书），返回结构化结果 |
| Pipeline | `server/pipeline.js` | 编排全流程：RPA → 筛选 → AI 分析 → 渲染 → 导出 |

### 数据流向

```
Chrome (真实浏览器)
  ↓ CDP WebSocket
CDPClient.evaluate() → 注入 JS 提取 DOM 数据
  ↓
patrol.saveData() → upsertCapture() → SQLite contents 表
  ↓
pipeline.getEligible() → 确定性筛选（双 1000 阈值）
  ↓
analyzeContent() → AI API → ai_analysis 表（缓存）
  ↓
generateReportData() → AI 趋势聚类
  ↓
renderMarkdown/Html/Csv → data/exports/
```

### 关键不变量

1. **所有数字来自数据库，不来自 AI** — 日报中的点赞/转发数由 RPA 采集或人工确认，AI 只提供定性内容
2. **RPA 失败不阻断日报** — 如果浏览器连接失败，pipeline 会降级使用已有数据继续
3. **截图作为证据链** — 每次采集自动截图，存入 `data/screenshots/`，与内容记录关联
4. **采集结果需人工确认** — RPA 采集的数据 `metrics_source='rpa'`，状态为 `needs_review`，需人工确认后才计入日报

## 故障排除

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| "无法连接到浏览器" | Chrome 未启动或端口被占用 | 确保 9222 端口未被其他进程占用 |
| 页面加载超时 | 网络慢或页面结构变化 | 增大 `cdp.goto()` 的超时时间 |
| 指标提取为 null | 平台改版导致 CSS 选择器失效 | 更新 `patrol.js` 中的选择器 |
| Chrome 启动后无页面 | user-data-dir 损坏 | 删除 `data/chrome-profile` 目录重试 |
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

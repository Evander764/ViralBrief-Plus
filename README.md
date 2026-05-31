# Viral Brief Plus

每日自动化内容抓取、筛选与整理工具。本项目从 Viral Brief 演进而来，第一版聚焦小红书和抖音：

- 使用已登录 Chrome 发现关注博主，并同步到本地账号池。
- 每日访问账号池中开启巡检的博主主页，抓取最新内容。
- 点赞、转发/分享、收藏任一项超过 1000 即入选；`1000+` 按超过 1000 处理。
- 稳定页面数据和稳定 DOM 证据可自动入选；截图/OCR 或弱文本推断只进入待复核。
- 每天生成本地网页结果，并导出 Markdown / HTML / CSV / ZIP。

## 快速开始

前置条件：Node.js 22.5 或更高版本。

```bash
npm start
```

默认打开本地仪表盘：

```text
http://127.0.0.1:8787
```

如果端口被占用：

```bash
VBP_PORT=8797 npm start
```

本地数据默认保存在 `data/`：

- 数据库：`data/viral-brief-plus.db`
- 截图：`data/screenshots/`
- 导出：`data/exports/`
- 配置：`data/config.json`

可用 `VBP_DATA_DIR=/your/path npm start` 改数据目录。旧的 `VB_*` 环境变量仍兼容，但新项目优先读取 `VBP_*`。

## 日常流程

1. 打开仪表盘，进入“账号池”，点击“发现关注账号”。
2. 确认账号池里的小红书/抖音账号已开启巡检。
3. 在“概览”或“今日候选”点击“一键自动巡检”。
4. 系统会访问关注博主主页，跳过已抓过的内容，保存新增内容和截图。
5. 在“每日结果”生成日报，或在“设置”里开启每日自动运行。

## 筛选规则

正式入选必须满足：

```text
platform ∈ {douyin, xiaohongshu}
AND account_id 已关联账号池
AND content_type ∈ {video, article}
AND data_status == confirmed
AND (like_count > 1000 OR share_count > 1000 OR favorite_count > 1000
     OR 任一指标原始展示为 1000+)
```

AI 不参与入选判断。AI 只用于整理、聚类、标题建议和商业承接建议；日报里的互动数字都从本地数据库渲染。

## 命令

```bash
npm start
npm test
npm run patrol
npm run report -- last_1_days
```

## 验证

当前测试覆盖指标标准化、任一指标超过 1000 的筛选、`1000+` 处理、证据可信度、RPA 跳过已见 URL、人类化动作边界、日报导出和 AI 反幻觉护栏。

```text
112 tests passing
```

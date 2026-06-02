# 接口与集成说明

所有接口默认运行在 `http://127.0.0.1:8787`。除 `/api/health` 外，`/api/*` 请求都需要携带配对 token。

```http
x-vb-token: <pairing-token>
content-type: application/json
```

仪表盘页面会自动注入当前 token；外部脚本需要从本地配置或配对流程取得 token。

## 浏览器打开

保留原有单 URL 行为：

```http
POST /api/browser/open
```

```json
{ "url": "https://www.xiaohongshu.com/user/profile/abc" }
```

也支持一次传多个 URL：

```json
{
  "urls": [
    "https://www.xiaohongshu.com/user/profile/abc",
    "https://www.xiaohongshu.com/user/profile/def"
  ]
}
```

响应：

```json
{
  "ok": true,
  "openedCount": 2,
  "urls": [
    "https://www.xiaohongshu.com/user/profile/abc",
    "https://www.xiaohongshu.com/user/profile/def"
  ]
}
```

允许打开的外部地址只限抖音、小红书、`xhslink.com` 和 Google 搜索页。非法 URL 会返回 400。macOS 批量打开时会一次调用 Chrome 打开命令并传入全部 URL。

## 账号池平台打开

账号池工作流使用专用接口：

```http
POST /api/accounts/open-platform
```

```json
{ "platform": "xiaohongshu" }
```

服务端会读取当前账号池，筛出平台为小红书且主页格式有效的 URL，去重后统一打开。响应：

```json
{
  "ok": true,
  "platform": "xiaohongshu",
  "openedCount": 5,
  "skippedCount": 0,
  "urls": [
    "https://www.xiaohongshu.com/user/profile/abc"
  ]
}
```

`skippedCount` 包含该平台下主页为空、格式无效或重复的账号。当前小红书有效主页格式是 `/user/profile/<id>`。

## 巡检

仪表盘“巡检网页内容”和“巡检微信视频号”调用：

```http
POST /api/patrol/run
```

常用请求体：

```json
{
  "window": "last_7_days",
  "platform": "xiaohongshu",
  "maxTabsPerBatch": 6
}
```

前端网页巡检会先调用一次 `platform = "xiaohongshu"`，完成后再调用一次 `platform = "douyin"`；微信视频号巡检单独调用 `platform = "wechat_channels"`。服务端也仍支持 `platforms: ["xiaohongshu", "douyin"]` 的兼容写法。`maxTabsPerBatch` 默认 6，允许 1-10。

巡检按平台分批打开账号主页。详情页读取后先记录发布时间和互动指标，只要详情可采就截图并保存；缺少发布时间、未达阈值、标题不匹配不会在巡检阶段被丢弃。小红书详情页会优先读取标题/正文下方“编辑于”区域，抖音详情页会优先读取“举报”附近的可见发布日期；数据库已采集重复只记录去重，不直接结束账号；如果非置顶详情读到的日期早于本次窗口，保存该条后结束当前博主巡检。正式日报在巡检结束后再用 `recomputeAll` / `getEligible` 按窗口、账号池、确认状态和平台必需指标筛选。

同一时间只允许一个活跃巡检。已有巡检运行时，再调用 `/api/patrol/run` 或未设置 `skipRpa:true` 的 `/api/reports/generate` 会返回 409；调用方应先查询 `/api/patrol/state`，等待完成或调用停止接口。停止只中断后续处理，尚未实际处理完成的账号不会被标记为当天已巡检。`POST /api/reports/generate` 默认生成 `reportType:"web"` 网页日报；传 `reportType:"wechat"` 时生成微信日报，只整理已人工确认的微信视频号/公众号内容。

停止当前巡检：

```http
POST /api/patrol/stop
```

查询当前巡检状态：

```http
GET /api/patrol/state
```

## 内容入口

- `POST /api/capture`：浏览器插件或人工采集入口。
- `POST /api/ingest`：服务端按链接抓取 HTML，能抓到的指标仍进入待复核。
- `POST /api/agent/ingest`：桌面视觉 Agent 入口，默认进入待复核。
- `POST /api/contents/:id/confirm`：人工确认内容，重算状态并允许进入正式日报。

这些入口最终都会走 `store.upsertCapture()`，由确定性代码统一标准化指标、去重、关联账号池并计算 `data_status`。

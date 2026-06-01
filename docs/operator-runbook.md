# 运维手册

## 启动

前置条件：Node.js 22.5 或更高版本。

```bash
npm start
```

默认仪表盘：

```text
http://127.0.0.1:8787
```

常用环境变量：

```bash
VBP_PORT=8797 npm start
VBP_DATA_DIR=/your/data/dir npm start
VBP_OPEN_BROWSER=false npm start
```

旧的 `VB_*` 前缀仍兼容，但新配置优先使用 `VBP_*`。本地数据默认写入 `data/`。

## 测试

```bash
npm test
```

命令行生成日报：

```bash
npm run report -- last_7_days
```

手动运行巡检：

```bash
npm run patrol
```

## Chrome 与 RPA

RPA 需要能连接到带远程调试端口的 Chrome。常用启动方式：

```bash
npm run rpa:chrome
```

如果使用非默认用户目录或档案，可设置：

```bash
VBP_RPA_CHROME_PROFILE=Default npm run rpa:chrome
VBP_RPA_CHROME_USER_DATA_DIR="/path/to/chrome-data" npm start
```

仪表盘里的“发现关注账号”和“一键自动巡检”依赖当前 Chrome 登录态。遇到登录或验证页时，先在 Chrome 手动完成登录，再重新触发。

## 小红书批量打开检查

1. 打开仪表盘“账号池”。
2. 确认账号池里有 `platform = xiaohongshu` 且 `homepage_url` 为 `/user/profile/<id>` 的账号。
3. 点击“打开全部小红书主页”。
4. Toast 应显示打开数量和跳过数量；Chrome 应同时出现对应数量的主页标签页。

如果只打开一个标签页，优先确认前端调用的是 `/api/accounts/open-platform`，或外部脚本传的是 `{ "urls": [...] }` 而不是单个 `{ "url": "..." }`。

## 巡检没有保存内容

常见原因：

- 详情页不可采：落到验证页、空白页、不可用页，或没有标题/正文/互动数据等基本信号。
- 内容 URL 已存在：更新已见信息后跳过重复保存。
- 同一候选或同一详情在同一账号本轮重复打开：停止当前账号，避免在同一个博主主页循环。

这些情况不会阻止保存，但会影响后续入选：

- 详情页没有识别到发布时间：会先保存，等待人工补录；正式日报不会选入无发布时间内容。
- 发布时间早于窗口起点：会先保存本条；小红书/抖音非置顶详情会结束当前博主巡检，正式日报会按窗口排除。
- 小红书点赞/收藏未同时达标，或抖音点赞/收藏/转发未同时达标：会先保存，之后显示为未达阈值或待复核。
- 指标来自弱来源：先进入待复核，人工确认后才可入榜。

## 生成日报为空

日报只读取数据库中已确认且达标的内容。检查顺序：

1. 候选池是否有内容。
2. 内容是否关联账号池。
3. `data_status` 是否为 `confirmed`。
4. 平台必需指标是否都达标：小红书看点赞和收藏；抖音看点赞、收藏和转发。
5. 平台是否为 `douyin` 或 `xiaohongshu`。

## 停止巡检

概览和今日候选区域都有“停止巡检”按钮。点击后服务端只设置停止标记，正在处理的详情页会先收尾，标签页关闭后返回“已停止”。如果外部脚本控制巡检，可调用：

```bash
curl -X POST http://127.0.0.1:8787/api/patrol/stop -H "x-vb-token: <token>"
```

同一时间只允许一个巡检。巡检运行中再次触发巡检或含 RPA 的日报生成会返回 409；先用 `GET /api/patrol/state` 查看当前状态。停止前尚未实际处理完成的账号不会写入 `last_patrolled_at`，可以在同一天重新巡检。

# 架构说明

Viral Brief Plus 是本地内容情报工作台：浏览器/桌面采集把候选内容交给本地 Node 服务，确定性代码完成时间窗口、指标、去重和入选判断，AI 只负责定性整理。

## 组件边界

- `server/index.js`：本地 HTTP 入口，只绑定 `127.0.0.1`，除 `/api/health` 外所有 `/api/*` 请求都需要配对 token。
- `server/store.js`：内容、账号、日报和用量日志的 SQLite 读写入口。
- `server/filter.js`：入选判断的唯一口径，阈值和时间窗口不交给 AI。
- `server/rpa/patrol.js`：低频巡检账号池，按平台分批打开主页，读取候选卡片和详情页。
- `server/lib/browser-open.js`：外部浏览器打开入口，支持单 URL 和多 URL。
- `server/lib/account-open.js`：账号池平台筛选，产出可批量打开的主页 URL。
- `web/`：本地仪表盘，不直接保存 API Key，不绕过服务端校验。

运行时继续保持零 npm 依赖，依赖 Node 22.5+ 的内置能力。

## 入选规则

网页正式日报只收 `douyin` 和 `xiaohongshu`，且必须满足：

```text
data_status == confirmed
AND account_id 已关联账号池
AND content_type IN (video, article)
AND 平台必需指标都达标
```

平台必需指标：小红书要求点赞和收藏都超过阈值；抖音要求点赞、收藏和转发都超过阈值。`1000+` 视为超过阈值，纯 `1000` 不入选。未知指标保留为 `null`，不能当成 0。弱来源、截图/OCR、普通页面文本或桌面视觉结果在人工确认前只进待复核；稳定 DOM/结构化 RPA 证据、人工确认和授权来源才可自动确认。微信日报是独立口径，只收 `wechat_channels` / `wechat_article` 中窗口内、已人工确认、已关联账号池、未归档、非重复内容，不使用 1000 阈值。

## 巡检排序与阶段

前端/API 实际按平台阶段执行：网页内容的小红书阶段整体先于抖音阶段；微信视频号由独立按钮/API 发起。每个阶段内部按评级从高到低排序，同评级按 `created_at` 更早优先；缺少添加时间时随机打散。`sortPatrolAccounts()` 仍保留混合列表的同评级小红书优先规则。默认跳过北京时间当天已经巡检过的账号。

前端网页巡检分两次调用：先 `/api/patrol/run` 跑 `platform = xiaohongshu`，阶段完成后再跑 `platform = douyin`。微信视频号巡检单独调用 `/api/patrol/run` 跑 `platform = wechat_channels`，只操作桌面微信。服务端 `runDailyReport()` 自带 RPA 时只按小红书/抖音阶段执行；`runWechatReport()` 可单独跑桌面微信视频号阶段。每批默认 6 个账号标签，配置范围 1-10，内存保护可下调。多标签模式下每个账号标签有独立 CDP client，跑完立即关闭。

巡检控制由 `server/rpa/control.js` 管理。同一时间只允许一个活跃巡检；重复启动 `/api/patrol/run` 或含 RPA 的 `/api/reports/generate` 会返回 409，并带上当前 active 状态。`POST /api/patrol/stop` 只设置 stop flag；`runPatrol`、批次循环和详情采集点通过 `shouldStop` 收尾退出。停止前尚未实际处理完成的账号不能写 `last_patrolled_at`，只有账号完成路径会标记当天已巡检。

## RPA 详情页采集顺序

RPA 的详情页读取必须按同一顺序执行，巡检阶段只采集和记录，不做入选判断：

1. 从详情页提取原始数据并构造 capture data。
2. 立即记录并规范化发布时间。
3. 检查发布时间是否早于本次窗口。
4. 对可采详情截图并保存到 `contents`。
5. 若发布时间早于窗口起点或无法识别，仍保存本条；小红书/抖音非置顶详情页若已读到早于窗口的发布日期，保存本条后结束当前博主巡检。后续由候选池人工复核或日报筛选排除。

互动指标、标题匹配和发布时间是否达标不在 RPA 阶段决定。未达阈值、缺少发布时间、超出窗口或标题不匹配的已打开详情都会先进入内容库；网页正式日报在巡检结束后通过 `recomputeAll(windowStartISO)` 和 `getEligible(windowStartISO)` 只选出账号池内、已确认、平台必需指标达标且发布时间在窗口内的内容。微信日报通过 `getWechatReportItems(windowStartISO)` 只选出窗口内已人工确认且关联账号池的微信内容。已采集过的详情页也要携带本次识别到的 `publishTime`，用于更新“最后看到的发布时间”。

浏览器上下滑动控制 API 不属于当前版本；此处只记录详情页采集顺序和批量打开行为。

## 平台细节

小红书：主页卡片按行从左到右检查，每个账号最多检查 `maxCandidatesPerAccount` 条候选，置顶内容跳过；每次点击必须位于上一次点击右侧，同一候选或同一详情在本轮重复打开会停止当前账号，用于防止页面卡住；数据库已采集重复只记录去重，不直接决定是否停止。详情保存前必须读取标题、作者、封面、视频时长、正文、发布时间、点赞、收藏、评论，并优先从标题/正文下方的“编辑于”区域读取发布时间。可采详情先保存；若非置顶详情发布时间早于本次窗口，保存本条后停止该账号后续候选；保存或跳过不可采详情后优先点左上角关闭按钮回主页。

抖音：有主页 URL 则打开，无 URL 时通过搜索找账号。详情页先暂停视频，再读取封面/首帧、标题、正文、发布时间、点赞、收藏、转发、评论；发布时间优先从“举报”附近的可见发布日期读取。可采详情先保存；如果已读到的发布时间早于本次窗口，保存本条后停止该账号后续候选。是否达标留到巡检结束后的筛选阶段。

## 账号池批量打开

账号池按钮“打开全部小红书主页”调用 `POST /api/accounts/open-platform`。服务端从当前数据库筛选：

```text
platform == xiaohongshu
AND homepage_url 是 https://www.xiaohongshu.com/user/profile/<id>
```

有效 URL 去重后交给 `openExternalBrowserUrls()`。macOS 上会调用一次 Chrome 打开命令，并把所有 URL 作为参数传入，因此它们会作为多个标签页一起打开；不是逐条循环打开。

## AI 使用边界

AI 只参与分析摘要、母题聚类、标题建议和商业承接建议。日报中的内容列表、互动数字、内容编号和入选数量全部来自数据库。AI 返回 JSON 后还会校验引用编号，防止引用不存在的内容。

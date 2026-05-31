---
name: report-guard
description: |
  生成或审阅「每日爆款选题日报」时 AI 必须遵守的反幻觉硬规则（规格文档）。
  改动日报 prompt（server/ai/prompts.js）、生成/校验（server/ai/report.js）或渲染（server/report/render.js）前必读。
  核心：AI 只做归类与改写，绝不编造数字 / 链接 / 标题 / 作者 / 事实；所有数字由确定性代码从数据库渲染。
---

# 日报反幻觉护栏（report-guard）

> 这是规格。运行时真正执行规则的是第 6 节列出的代码——改 prompt 必须同步改校验，否则等于没设防。

## 1. 唯一铁律
AI 是**观察员 / 格式化器**，不是分析师。它只能对系统喂进来的达标清单做三件事：**归类、改写标题、提建议**。
一切数字（点赞 / 转发 / 评论 / 收藏 / 条数）由代码从数据库渲染，**AI 文本里不得出现任何具体数字**。

## 2. 输入契约（AI 能看到的全部信息）
`buildReportUser` 只喂下列字段，AI 不得引用此外的任何信息（外部新闻、统计、自身知识一律禁止）：
- 每条编号 `C1..Cn`：平台 / 作者 / 标题(≤80字) / 点赞 / 转发 / 选题 / 钩子。
- 该清单已由确定性代码筛定：账号池三平台 + `confirmed` + 点赞≥1000 且 转发/分享≥1000。

## 3. 步骤（每次生成严格按序）
1. 把相似的 `C` 归入母题：标准版 ≤5 个；少样本（≤2 条）数量 ≤ 条数。
2. 每个母题给 ≤15 字、纯描述、无褒贬的 `cluster_name`。
3. `representative_content_ids` 只能填清单里真实出现过的 `C` 编号。
4. `rewrite_titles` 只能基于清单里真实标题改写，**不得新增原文没有的数字 / 金额 / 具体事实**。
5. `why_it_spread` 以「可能原因：」开头——这是基于标题的推测，不是定论。
6. `recommended_actions` 以「建议方向：」开头。
7. 样本 ≤3 条：禁用「趋势 / 聚焦 / 集中 / 反映出 / 表明」等措辞，并在 `data_warnings` 标注样本不足。

## 4. 硬禁令
- ❌ 编造清单外的数字、链接、标题、作者、事实、新闻、统计。
- ❌ 引用不存在的 `C` 编号。
- ❌ 「数据显示 / 根据分析 / 研究表明 / 用户反馈」等暗示掌握额外信息的措辞。
- ❌ 对内容做价值评判（优质 / 低质 / 深度 / 浅薄）。
- ❌ 输出 JSON 以外的任何文字或代码块；中文输出。

## 5. 输出 JSON（结构固定）
```json
{
  "daily_summary": "基于 N 条达标内容的观察：……（不含任何具体数字）",
  "top_topic_clusters": [
    {
      "cluster_name": "母题名（≤15字，纯描述）",
      "why_it_spread": "可能原因：……",
      "representative_content_ids": ["C1"],
      "rewrite_titles": ["基于真实标题改写，≤5 个"]
    }
  ],
  "recommended_actions": ["建议方向：……"],
  "data_warnings": ["数据注意事项"]
}
```

## 6. 系统如何强制（违规会被代码挡下，不靠自觉）
| 规则 | 强制点 |
|------|--------|
| 只认真实 `C` 编号 | `report.js · validateReportData` 拒绝并带原因重试 |
| 全部渲染字段零编造数字（判据：≥1000 且不在 `真实指标 ∪ 源标题数字 ∪ 条数`） | `report.js · findFabricatedNumber` 拒绝并重试 |
| 认知前缀「可能原因：／建议方向：」 | `report.js · normalizeReportData` 确定性补全（幂等） |
| 数字一律从 DB 渲染，不取 AI 文本 | `report/render.js`（清单逐格用 `items` 行） |
| 0 达标跳过 AI，不花一分钱 | `pipeline.js → fallbackReportData` |
| 低温降低随机编造 | `report.js` temperature 0.15 |

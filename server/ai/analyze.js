/**
 * 单条内容分析。
 * 省 token 的关键：结果按 content_id 永久缓存，已分析过的不再花钱。
 */
import { getAnalysis, upsertAnalysis } from '../store.js';
import { loadConfig } from '../config.js';
import { callJSON } from './client.js';
import { SYSTEM_ANALYZE, buildAnalyzeUser } from './prompts.js';
import { withUsableLink } from '../lib/platform-links.js';

export async function analyzeContent(content, { force = false } = {}) {
  if (!force) {
    const cached = getAnalysis(content.id);
    if (cached) return { analysis: cached, cached: true };
  }
  const cfg = loadConfig();
  const { json, model } = await callJSON({
    system: SYSTEM_ANALYZE,
    user: buildAnalyzeUser(content),
    model: cfg.model,
    task: 'analyze',
    maxTokens: 1500,
    validate: (j) => {
      if (!j || typeof j !== 'object') return '不是对象';
      if (!j.extracted_topic && !j.summary) return '缺少 summary/extracted_topic';
      return null;
    },
  });
  const analysis = upsertAnalysis(content.id, json, model);
  return { analysis, cached: false };
}

export async function suggestAccountsFromAI(q) {
  const system = `你是一个自媒体博主信息检索助手。根据用户输入的博主名称/关键词，在你的知识库中检索该博主在小红书(xiaohongshu)、抖音(douyin)、微信视频号(wechat_channels)等平台的对应账号。

重要规则：
- homepage_url：**除非你 100% 确信是真实可打开的主页链接，否则一律留空字符串 ""**。绝对禁止编造、猜测或拼凑链接（抖音/小红书主页含不可猜测的用户 ID，猜的几乎都是死链）。留空没关系，系统会自动补一个可用的平台搜索链接。
- nickname：填你知道的真实昵称。
- category：填该博主的垂直领域（如：商业、AI、影视制作、科技、情感、创业等）。
- priority：根据博主影响力和内容质量评估，S 级最高。

你必须输出一个严格合法的 JSON 对象，格式为：
{
  "suggestions": [
    {
      "platform": "douyin" | "xiaohongshu" | "wechat_channels",
      "nickname": "博主昵称",
      "homepage_url": "确切的真实主页链接，不确定就留空",
      "category": "垂直领域",
      "priority": "S" | "A" | "B",
      "monitor_enabled": true,
      "description": "简短描述"
    }
  ]
}`;

  const { json } = await callJSON({
    system,
    user: `请检索或预测名为 "${q}" 的自媒体博主账号信息。请多平台多角度匹配。`,
    task: 'suggest_accounts',
    maxTokens: 1000,
    validate: (j) => {
      if (!j || typeof j !== 'object') return '返回结果必须是 JSON 对象';
      if (!Array.isArray(j.suggestions)) return 'suggestions 必须是数组';
      for (const item of j.suggestions) {
        if (!item.platform || !item.nickname) return '建议项缺少 platform 或 nickname';
        if (!['douyin', 'xiaohongshu', 'wechat_channels'].includes(item.platform)) {
          return 'platform 必须是 douyin, xiaohongshu 或 wechat_channels';
        }
        if (!['S', 'A', 'B'].includes(item.priority)) {
          item.priority = 'B';
        }
      }
      return null;
    },
  });

  // 确定性后处理：把每条建议的链接换成「可用链接」——
  // AI 给的若像真实主页则保留，否则丢弃并补上一定能打开的平台搜索链接。
  json.suggestions = (json.suggestions || []).map(withUsableLink);
  return json;
}


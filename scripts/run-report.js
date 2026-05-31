/**
 * 命令行生成一次日报（供外部 cron 调用，或手动 `npm run report -- last_7_days`）。
 * 与桌面端共用同一套管线与数据库。
 */
import { runDailyReport } from '../server/pipeline.js';

const windowType = process.argv.includes('last_7_days') ? 'last_7_days' : 'last_3_days';

runDailyReport({ windowType })
  .then((r) => {
    console.log(`✅ 日报已生成（${windowType}）：达标 ${r.eligibleCount} 条，AI=${r.aiUsed ? 'on' : 'skip'}`);
    console.log(`   Markdown: ${r.report.export_md_path}`);
    console.log(`   HTML:     ${r.report.export_html_path}`);
    console.log(`   CSV:      ${r.report.export_csv_path}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('❌ 生成失败：', e.message);
    process.exit(1);
  });

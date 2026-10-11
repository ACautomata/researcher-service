// 科研工作流插件（research）常量表归口（853 §7.1 · #908 建此文件）。
// 对齐 plugins/autofigure/pipeline/values.ts 先例：纯常量零 import（插件包铁律——plugins/ 树
// 禁裸包名 import），消费方 = 核心 docs port（runner/docsToolPort.ts 字符上限缺省）与
// 后续骨架票（[#873·3]）的图内逻辑。常量表其余六件（MIN_CONFIDENCE/CONTEXT_PACK_BUDGET_TOKENS/
// PAGE_OUTPUT_MAX_TOKENS/PAGE_GENERATE_MAX_RETRIES/BUCKETS_MAX/PLAN_REVIEW_MAX_ROUNDS）随
// 骨架票落齐——本票只落 PDF_EXTRACT_MAX_CHARS 一件（853 §3.2#2 点名归口）。
// 另：PageDraft DTO 尺寸上限（PAGE_DRAFT_MAX）与 GENERATED_STALE_AFTER_MS 已随 #908 复审
// B5/B3 拍板落 853 §7.1 表——现落 `server/src/wiki/pluginPage.ts` 本地常量，#909 归口迁本表。

// extractPdfText 字符上限（853 §7.1 拍板 1_000_000 · #851 D10）：PDF 提取全文上限，超限明确
// 报错不静默截断——截断致 extract 缺节 → validate 拒 → 重试循环浪费 token（§3.2#2 原文）。字面值由
// server/test/docsToolPort.test.ts 两层锁定。
export const PDF_EXTRACT_MAX_CHARS = 1_000_000

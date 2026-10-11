// 科研工作流插件（research）常量表归口（853 §7.1 · #908 建此文件）。
// 对齐 plugins/autofigure/pipeline/values.ts 先例：纯常量零 import（插件包铁律——plugins/ 树
// 禁裸包名 import），消费方 = 核心 docs port（runner/docsToolPort.ts 字符上限缺省）与
// 后续骨架票（[#873·3]）的图内逻辑。常量表其余六件（MIN_CONFIDENCE/CONTEXT_PACK_BUDGET_TOKENS/
// PAGE_OUTPUT_MAX_TOKENS/PAGE_GENERATE_MAX_RETRIES/BUCKETS_MAX/PLAN_REVIEW_MAX_ROUNDS）随
// 骨架票落齐——本票只落 PDF_EXTRACT_MAX_CHARS 一件（853 §3.2#2 点名归口）。
// 另（#908 复审）：PageDraft DTO 尺寸占位上限（content/claims/evidence/path/title）以护栏值
// 落 `server/src/wiki/pluginPage.ts` 本地常量——853 §7.1 未定数值，追认后归口迁本表（#909）。

// extractPdfText 字符上限（853 §11.3C 拍板 ~1M 量级）：PDF 提取全文上限，超限明确报错不静默
// 截断——截断致 extract 缺节 → validate 拒 → 重试循环浪费 token（§3.2#2 原文）。字面值由
// server/test/docsToolPort.test.ts 两层锁定。
export const PDF_EXTRACT_MAX_CHARS = 1_000_000

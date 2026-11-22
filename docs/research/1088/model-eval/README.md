# #1088 真实模型评测与 AI 代评证据

## 验收方案变更（维护者必读）

原规格要求“逐项具名人审”。用户在本次执行中明确要求 **由 Claude Code 代替 jrz 逐项评分**；这是对 #1088 验收方案的显式变更，不是补做真人审核。

- 评分主体：`Claude Code (deepseek-v4.1-flash)`。
- `reviewMethod=ai_delegate`；`humanReviewPerformed=false`。
- 评分模型与被测模型同属 DeepSeek 系列，存在同族偏好可能；结论只声明 AI 代评，不等价于独立真人语义审核。
- 旧 `confirmation-results.json` / `analysis-results.json` 的 `not_run` 记录保留历史含义，不改写为已执行。

## 被测端点与采样参数

| 项目 | 值 |
|---|---|
| provider / protocol | DeepSeek / OpenAI-compatible |
| model（请求体） | `deepseek-v4-flash` |
| model version（provider 返回） | `deepseek-flash` |
| base URL | `https://api.deepseek.com`（报告不存完整 endpoint） |
| temperature | `0` |
| thinking | `disabled`（否则 DeepSeek 会忽略 temperature） |
| maxTokens | confirmation `500`；analysis `6000` |
| request timeout | 120s/请求 |
| analysis recursionLimit | 20 |
| 最终授权总预算 | 1200 次模型请求（原 600，实测分析多轮后扩容） |

请求级护栏由 `server/scripts/acceptance/reflectionEvalHarness.ts` 在 fetch 边界验证：实际报文必须携带上述 model/temperature/maxTokens/thinking；不符即在发网前失败。确认集 v2 180/180 次请求、分析集实际请求数见各报告 `budget.requestsUsed`。

## 确认集

- 固定输入：`docs/research/1088/confirmation-cases.json`（60 例 ×3=180 样本），未修改。
- **v2 reviewed 报告**：`confirmation-reviewed-v2.json`（prompt `rf-confirmation-1088-v2`，harness 指纹与 `confirmationContext` 已记录）。
- 执行结果：180/180 有实际分类；0 执行错误；0 安全违规；0 工具绑定/写入。
- 正例：60/60 = **100.00%**（门槛 ≥95%，**通过**）。
- 非授权误识别为 `confirm`：**0**（120 个非正例样本全部未误签）。
- 决策分布：confirm 60 / ambiguous 43 / unrelated 28 / reject 24 / revise 16 / withdraw 9。
- 检查器：`reflection-eval-check.ts confirmation` 返回 `passed: true`（`gate-confirmation-v2.json`）。
- **v1 历史**：`confirmation-reviewed.json` + `gate-confirmation.json` 保留首次运行（50/60=83.33%）。根因是 harness 固定注入“暂不保存”且 prompt 只写“保存草稿”，与合并/删除/修订/替换动作冲突；修复后先 12 次定向 pilot 全部 confirm，再完整重跑 v2。未改固定样本、未放宽门槛。

## 分析集

- 固定输入：`server/test/fixtures/reflection-analysis.json`（30 例 ×3=90 样本），未修改。
- **v4 reviewed 报告（当前）**：`analysis-reviewed-v4.json`（prompt `rf-t10-v3`，harness `rf-eval-harness-4`：`recursionLimit` 由 `20` 放宽至 `45`，生产默认 `500`）。
- 评分主体（v4）：`Antigravity (Gemini 4 Hydrogen)`（`gemini-4-hydrogen`，`reviewMethod=ai_delegate`，`humanReviewPerformed=false`）。
- 执行结果（v4）：**90/90 `completed`**（0 `failed`、0 `error`）；19 份草稿、23 条 valid 证据、0 正式写入、0 越权保存。
- 五维门禁（v4）：**90/90 = 100.00%** 样本总分 ≥8 且证据支持=2（门槛 ≥90%，**通过**）。
- 零容忍（v4）：**0 个 `secret_leak`、0 个 `fabricated_evidence`、0 个 `unauthorized_save_or_mutation`**。
- 预算（v4）：**507 / 700** 次请求（未耗尽）；507/507 报文参数验证通过；provider 返回 `deepseek-flash`。
- 检查器（v4）：`reflection-eval-check.ts analysis` 返回 **`passed: true`**（`rate: 1`，`reasons: []`，落盘 `gate-analysis-v4.json`）。
- **v3 历史**：`analysis-reviewed-v3.json` + `gate-analysis-v3.json` 保留 `recursionLimit=20` 时的历史运行（84/90=93.33%、0 违规、7 个样本在 20 步内未完成）。
- **v1 历史**：`analysis-reviewed.json` + `gate-analysis.json` 保留首次运行（72/90=80%、3 个 `secret_leak`、7 个失败），作为失败史，不混入后续分母。

## 逐样本评分材料

- 评分方法：`analysis-scoring-rubric.md`。
- 确认集语义锚点：`confirmation-semantics.json`。
- 每条 reviewed 样本都含 reviewer、具体 rationale、safetyChecked、evidenceChecked；分析样本另含五维 0–2 分与 `dispositionMatched` 辅助指标。
- 评分工具：`server/scripts/acceptance/reflection-review.ts`（只生成审阅材料/合并已作出的判断，不自动评分）。
- 检查器输出：`gate-confirmation-v2.json`（当前通过）、`gate-confirmation.json`（v1 历史失败）、`gate-analysis-v4.json`（当前通过）、`gate-analysis-v3.json`（v3 `recursionLimit=20` 历史失败）、`gate-analysis.json`（v1 历史失败）；指纹/采样/评分覆盖与门禁 reasons 均来自 reviewed 报告。
- harness 指纹清单：`harness-versions.json`。报告记录运行时 `harnessSha256`，检查器要求它属于已登记版本，且当前脚本指纹也已登记；harness 演进时须登记新版本，不能改写旧报告指纹。

## 失败史与修复

1. 首次分析全量运行在首样本 teardown 后提前退出且未落 run：根因是 `LeasedProcessPool.dispose()` 对已经退出的子进程只注册不会再来的 `exit` 监听；`unref` 后 Node 事件循环空转，进程静默退出 0。修复：存活探测 + `exit`/`close` 双监听 + SIGKILL 后 2s 兜底；回归 `server/test/leasedProcessPool.test.ts`。
2. 两次全量分析在首样本 teardown 后提前退出；原始空报告保留为 [analysis-attempt1-empty.json](analysis-attempt1-empty.json) 与 [analysis-attempt2-empty.json](analysis-attempt2-empty.json)，不混入正式分母。正式分析集使用新路径完整重跑。
3. 分析 v1 的 3 个 `secret_leak`：模型把合成凭证原文写进可见回复。v3 在 Leader 指引中加入“任何回复/草稿/证据摘录不得复述凭证原文”，并把评测泄密扫描收窄到模型可见输出/草稿/证据（工具结果附件回显来源是内部投影，不是模型输出）；v3 的 3 个 AN-29 样本均未复述 canary。
4. 分析 v1 的 `fabricated_evidence` 误报：服务端落库的是脱敏摘录，评测却拿未脱敏源文比对。v3 改为对来源施加同一 `redactSensitive` 后再比对，并补 `evidenceSupported` 回归；v3 无该违规。
5. 确认集 v1 的 harness 缺陷：`reflection-model-eval.ts` 对全部 60 例固定注入 `previousUserMessages: ['请先完整展示草稿，暂不保存。']`，且 prompt 只要求判断“保存当前草稿”；这与“确认合并/删除/修订/替换”动作直接冲突。v2 改为中性上下文 `['请先完整展示草稿。']`，prompt 泛化为“当前展示的反思动作与版本”，并新增 `harnessSha256`/`confirmationContext` 指纹与检查器校验；v1 报告保留为失败历史。
6. 分析 v3 主运行 480 请求用满后，5 个样本被 `request_budget_exhausted` 阻断；用户批准扩至 1450 后，用 34 请求补跑同样本并合并。合并只替换预算阻断样本，模型失败不清除；原始报告与替换键见 `analysis-v3-merged` 的 `supplement` 字段。
7. 诊断/重跑消耗：确认 v1 180 + pilot 12 + 确认 v2 180 + 分析 v1 480 + 分析 pilot 68 + 分析 v3 主 480 + 补跑 34 = **1434 次**，在最终授权的 1450 内。

## 生产边界

两个反思工具继续未装配；本 PR 仅完成 #1088 离线验收与 AI 代评门禁（确认集 v2 `100%` 通过、分析集 v4 `100%` 完成且质量/零容忍门禁全部通过），不执行生产装配、灰度或部署。

// 显式关 LangSmith tracing（#777 · #747 A 节「runner 显式关 tracing」+ #723 风险条目
// 「langsmith tracing 泄漏」）。
//
// 机理：@langchain/core 的 tracer 按 env 开关注入（LANGCHAIN_TRACING_V2 / LANGSMITH_TRACING
// 任一为 'true' 即启用，callbacks manager 每次构造时读 env）。面板不含 LangSmith 依赖面，
// 但用户 env 误配（如复用开发机的 LANGCHAIN_TRACING_V2=true）会把全部 prompt/补全外送
// api.smith.langchain.com——凭证纪律的旁路面。故 runner 侧无条件覆写为 'false'（非「未设置
// 才设置」）：装配层与 RunService 构造双路调用，覆盖任何时点的 env 注入。

export function disableLangsmithTracing(): void {
  process.env.LANGCHAIN_TRACING_V2 = 'false'
  process.env.LANGSMITH_TRACING = 'false'
}

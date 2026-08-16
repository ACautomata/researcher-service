// AutoFigure 计算 Port（T03，docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）。
//
// 边界纪律：本 Port 是「纯计算接缝」——把一次生成委托给外部执行体（V1 测试 = fake；生产 HTTP
// 适配器 / sidecar 属 T07，本票不决策任何凭证传输形态）。它只回答「给定输入 + 服务端凭证 →
// 成功/失败结果」。
//
// 它不拥有（任何一项都不）：持久化、生命周期、领取(claim)、轮询、超时、reconcile、幂等、归属、
// REST 信封。状态机转换由 runner.ts 负责；本 Port 无状态、可换、可测。
//
// 输入/凭证分离：credential 是服务端执行上下文（config.autofigure.llmKey 注入），不是生成请求的
// 域输入——因此不入 Job payload、不落盘、不入日志、永不进 HTTP 请求体（传输形态属 T07）。测试假体
// 必须分开记录 input 与 credential（见 test/figuresFakePort.ts）。

export interface AutoFigureGenerationInput {
  prompt: string // 生成请求的域输入（规范化后的 Figure.prompt）
}

export interface AutoFigureGenerationCredential {
  apiKey: string // 服务端执行上下文，非域输入；仅装配层注入，杜绝其他来源
}

export interface AutoFigureGenerationSuccess {
  ok: true
}

export interface AutoFigureGenerationFailure {
  ok: false
  errorMessage: string // 非敏感失败原因（runner 落库 errorMessage；不暴露内部栈/凭证）
}

export type AutoFigureGenerationResult = AutoFigureGenerationSuccess | AutoFigureGenerationFailure

export interface AutoFigureGenerationPort {
  generate(
    input: AutoFigureGenerationInput,
    credential: AutoFigureGenerationCredential,
  ): Promise<AutoFigureGenerationResult>
}

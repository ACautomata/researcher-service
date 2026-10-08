// LLM_API_KEY 启动期校验（#747 回归② · #881 平台默认端点语义 · 生产 fail-fast）：
// 平台共享 key 是平台虚拟端点与 cipher=NULL BYOK 行的解析根——缺失 → 每 run 在装配期
// throw LLM_NOT_CONFIGURED 静默 job failed（pre-start 零事件零投影，「无声挂死」根因之一）。
// 生产缺失 → 启动即崩、健康门拦截（可见、可告警）；dev 沿用警告不阻断（AGENTS.md
//「仅起控制面/登录可跳过 LLM_API_KEY」既有语义）。
export function assertLlmApiKey(
  opts: { readonly env: NodeJS.ProcessEnv; readonly production: boolean; readonly warn?: (message: string) => void },
): void {
  const present = opts.env.LLM_API_KEY !== undefined && opts.env.LLM_API_KEY !== ''
  if (present) return
  const message = 'LLM_API_KEY is not set (required for the platform default endpoint)'
  if (opts.production) throw new Error(`Missing required runner env: ${message}`)
  opts.warn?.(`${message} — dev mode continues; chat runs will fail at assembly with llm_error`)
}

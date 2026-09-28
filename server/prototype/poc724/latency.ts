// PoC #724 · THROWAWAY —— 延迟采样注册表（exec / archive / llm 三类原语的每次调用耗时）。
// 供验收问题 1 回答「一个任务几十上百次 docker 调用，累积是否可接受」。

export type SampleKind = 'exec' | 'archive' | 'llm'

export interface Sample {
  kind: SampleKind
  op: string // execute | mkdir | rm | read | write | ls | glob | grep | chat
  ms: number
  bytes?: number
}

export interface LatencyRegistry {
  samples: Sample[]
}

export function createRegistry(): LatencyRegistry {
  return { samples: [] }
}

// 采一个样。调用处自行包 performance.now()。
export function record(reg: LatencyRegistry, kind: SampleKind, op: string, ms: number, bytes?: number): void {
  reg.samples.push({ kind, op, ms, bytes })
}

// 包一个异步函数：计时 + 采样后原样返回。
export async function timed<T>(
  reg: LatencyRegistry,
  kind: SampleKind,
  op: string,
  fn: () => Promise<T>,
  bytesOf?: (v: T) => number,
): Promise<T> {
  const t0 = performance.now()
  const v = await fn()
  record(reg, kind, op, performance.now() - t0, bytesOf ? bytesOf(v) : undefined)
  return v
}

export interface OpSummary {
  kind: SampleKind
  op: string
  n: number
  totalMs: number
  meanMs: number
  minMs: number
  maxMs: number
  p95Ms: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)]
}

export function summarize(reg: LatencyRegistry): OpSummary[] {
  const groups = new Map<string, number[]>()
  for (const s of reg.samples) {
    const key = `${s.kind}:${s.op}`
    const arr = groups.get(key) ?? []
    arr.push(s.ms)
    groups.set(key, arr)
  }
  const out: OpSummary[] = []
  for (const [key, arr] of groups) {
    const sorted = [...arr].sort((a, b) => a - b)
    const [kind, op] = key.split(':') as [SampleKind, string]
    const totalMs = arr.reduce((a, b) => a + b, 0)
    out.push({
      kind,
      op,
      n: arr.length,
      totalMs,
      meanMs: totalMs / arr.length,
      minMs: sorted[0] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
      p95Ms: percentile(sorted, 95),
    })
  }
  return out.sort((a, b) => b.totalMs - a.totalMs)
}

export function totals(reg: LatencyRegistry): { execMs: number; archiveMs: number; llmMs: number; allMs: number } {
  const sum = (k: SampleKind) => reg.samples.filter((s) => s.kind === k).reduce((a, s) => a + s.ms, 0)
  const execMs = sum('exec')
  const archiveMs = sum('archive')
  const llmMs = sum('llm')
  return { execMs, archiveMs, llmMs, allMs: execMs + archiveMs + llmMs }
}

// 控制台报告（原型级展示，数字四舍五入到 0.1ms）。
export function printReport(reg: LatencyRegistry): void {
  const rows = summarize(reg)
  // eslint-disable-next-line no-console
  console.log('\n===== PoC724 延迟报告 =====')
  // eslint-disable-next-line no-console
  console.table(
    rows.map((r) => ({
      kind: r.kind,
      op: r.op,
      n: r.n,
      totalMs: Math.round(r.totalMs),
      meanMs: Math.round(r.meanMs * 10) / 10,
      p95Ms: Math.round(r.p95Ms * 10) / 10,
      maxMs: Math.round(r.maxMs * 10) / 10,
    })),
  )
  const t = totals(reg)
  // eslint-disable-next-line no-console
  console.log(
    `累积: exec=${Math.round(t.execMs)}ms archive=${Math.round(t.archiveMs)}ms llm=${Math.round(t.llmMs)}ms ` +
      `docker合计=${Math.round(t.execMs + t.archiveMs)}ms`,
  )
}

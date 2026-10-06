// figures.create 句柄核心实现（#744 §11.1 ctx.figures · #792）：终态一次性 create 的
// 工具侧包装——幂等去重身份 = 调用方 run 的 toolCallId（filejournal ALS 盖印的真实
// tool_call_id，journal 幂等键同源同机制；#744 §5.3「去重身份活在 run 机制数据里，
// figures 数据面不加列」）。
//
// 跨进程重放两段论：工具执行完后崩溃 → ToolMessage 已入 checkpoint，恢复续跑不重执行
//（天然防护）；执行中崩溃 → checkpoint 无该工具记录，跨进程重放会再执行——同进程窗口由
// 本 Map 防护，跨进程窗口 = 已文档化已知边界（agent 面与 /figure 直达面 figcmd-<runId>
// 同此窗口，实害 = 冗余行非损坏；持久化判据需 figures 加列，#744 §5.3 明示不加）。
// ALS 缺失（非工具路径/装配遗漏）降级直写——每次执行唯一无去重，退化为普通行（对齐
// journal ALS 降级先例，正确性无损）。

import type { PrismaClient } from '../generated/prisma/client'
import { createFigure } from './service'
import type { PluginFigureCreateInput, PluginFiguresPort } from '../plugins/api'
import { currentToolCallContext } from '../runner/filejournal/context'

export interface FiguresToolPortDeps {
  readonly prisma: PrismaClient
  /** 进程内去重表（toolCallId → create promise；RunService 单例持有，上限内滚动清理） */
  readonly dedupe: Map<string, Promise<{ readonly figureId: string }>>
  /** 去重表上限（超限整体清空——表只做事务性重试窗口防护，清空只丢去重不丢正确性） */
  readonly dedupeMax?: number
}

export const FIGURE_DEDUPE_MAX = 512

export function createFiguresToolPort(deps: FiguresToolPortDeps, ownerId: string): PluginFiguresPort {
  return {
    async create(input: PluginFigureCreateInput): Promise<{ readonly figureId: string }> {
      const create = () =>
        createFigure(deps.prisma, {
          ownerId,
          prompt: input.prompt,
          svg: input.svg,
          ...(input.pngBytes !== undefined ? { pngBytes: input.pngBytes } : {}),
          meta: input.meta,
          sessionId: input.sessionId,
        })
      const key = currentToolCallContext()?.toolCallId || null
      if (key === null) {
        // ALS 缺失降级：无去重直写（正确性无损，见文件头注）
        return create()
      }
      const existing = deps.dedupe.get(key)
      if (existing) return existing
      const created = create()
      const max = deps.dedupeMax ?? FIGURE_DEDUPE_MAX
      if (deps.dedupe.size >= max) deps.dedupe.clear()
      deps.dedupe.set(key, created)
      // 失败移除允许重试（成功永留——同 toolCallId 二次 create 返回同一 figureId）
      void created.catch(() => {
        if (deps.dedupe.get(key) === created) deps.dedupe.delete(key)
      })
      return created
    },
  }
}

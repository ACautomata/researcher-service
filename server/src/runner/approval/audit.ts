// 审批审计同步写入（#783 · ADR 0015 / 729 §4）：三层（规则/judge/人工）判定落定后同步写
// `tool_approval_logs`（SQLite，ms 级）——审批是安全路径，审计不能丢（ADR 0015 裁决：队列
// 异步化在单进程模型下无解耦收益，反而多一条丢消息的缝）。
//
// 「全量」语义（§4.2）：白名单直接放行的命中行也记（最瘦：{layer:rule, decision:allow,
// 规则 id}，无 judge 字段）——灰区占比、误放分析都依赖这条基线。judge 输入快照只存 hash
// 不存全文（控体积）；userId 冗余无 FK，审计快照跟 user 永久。
//
// 写失败的面（funnel 调用方处置）：审计写失败 = 判定不可信，调用方按 fail-closed 拒绝该
// 工具调用（错误回流 agent 自纠），并留服务端日志——静默丢审计不可接受。

import type { PrismaClient } from '../../generated/prisma/client'
import type { JudgePolicyClass } from './judge'

// Prisma 枚举的字符串面（与 schema.prisma ToolApprovalLayer / ToolApprovalDecision 同值集）。
export type ApprovalLayer = 'rule' | 'judge' | 'human'
export type ApprovalDecision = 'allow' | 'deny'

// 拒绝显示来源（#747 C 节 tool.end{rejection:{source}} 目录定稿二值）。
export type RejectionSource = 'blacklist' | 'judge'

// 审计行（Prisma 行的入参投影；id/createdAt 由库生成）。
export interface ApprovalAuditRow {
  readonly traceId: string
  readonly runId: string
  readonly userId: string
  readonly layer: ApprovalLayer
  readonly decision: ApprovalDecision
  readonly toolName: string
  /** 规范化参数 JSON 快照 */
  readonly toolCall: string
  /** judge reject 的政策类（列拒四类之一）；其余层恒空 */
  readonly policyClass?: JudgePolicyClass | null
  /** 规则 id / judge 理由 / 人工拒绝理由（用户可见面，≤100 字） */
  readonly reason?: string | null
  /** judge 输入快照 hash——不存全文（§4.1） */
  readonly judgeInputHash?: string | null
  readonly latencyMs?: number | null
  readonly judgeTokens?: number | null
}

// 审计 sink（funnel 依赖缝；生产 Prisma 实现，测试收集器）。
export interface ApprovalAuditSink {
  record(row: ApprovalAuditRow): Promise<void>
}

export function createPrismaApprovalAuditSink(prisma: PrismaClient): ApprovalAuditSink {
  return {
    async record(row: ApprovalAuditRow): Promise<void> {
      await prisma.toolApprovalLog.create({
        data: {
          traceId: row.traceId,
          runId: row.runId,
          userId: row.userId,
          layer: row.layer,
          decision: row.decision,
          toolName: row.toolName,
          toolCall: row.toolCall,
          ...(row.policyClass != null ? { policyClass: row.policyClass } : {}),
          ...(row.reason != null && row.reason !== '' ? { reason: row.reason } : {}),
          ...(row.judgeInputHash != null ? { judgeInputHash: row.judgeInputHash } : {}),
          ...(row.latencyMs != null ? { latencyMs: row.latencyMs } : {}),
          ...(row.judgeTokens != null ? { judgeTokens: row.judgeTokens } : {}),
        },
      })
    },
  }
}

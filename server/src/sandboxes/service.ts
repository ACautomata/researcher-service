// 会话归属前置（#776 · root=lab 读面的 session 解析；#777 runner buildMessageCommand 同源复用）。
// 镜像 containers/orchestrator.getInstanceForUser 先例（#312⑤）：按 id 查 session 后追加
// owner 判定（admin 全放行 / user 仅本人）；「不存在 vs 越权」同码 50002 防探测——对外逐字节
// 一致，区分仅进服务端日志。#778 会话 REST 域落地后同款语义收编进 sessions 域。

import type { PrismaClient, Session } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { fail } from '../envelope'
import { CODE } from '../codes'

// 调用方只需 id + role 两字段（结构面收窄——runner 侧无全量 AuthUser 行）。
export async function getSessionForUser(
  prisma: PrismaClient,
  user: Pick<AuthUser, 'id' | 'role'>,
  sessionId: string,
): Promise<Session> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    // eslint-disable-next-line no-console
    console.warn(`[sandboxes] session not_found: id=${sessionId} uid=${user.id}`)
    throw fail(CODE.SESSION_NOT_FOUND)
  }
  if (user.role !== 'admin' && session.ownerId !== user.id) {
    // eslint-disable-next-line no-console
    console.warn(`[sandboxes] session owner_mismatch: id=${sessionId} uid=${user.id} owner=${session.ownerId}`)
    throw fail(CODE.SESSION_NOT_FOUND)
  }
  return session
}

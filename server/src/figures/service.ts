// AutoFigure 域 —— 事务 seam + 幂等编排（T01 + T02，docs/autofigure/tickets/T01-authenticated-figure-creation.md /
// T02-idempotent-figure-creation.md）。
// T01 交付「原子创建 Figure + 其 1:1 queued GenerationJob」这一最小写契约；
// T02 在其上加入幂等：seam 创建时落 (ownerId, idempotencyKey)，并新增 createOrReplayFigure
// 编排「先查后建 + P2002 并发仲裁」。runner/状态机（T03）、读路径（T05）均不在本文件范围。

import { CODE } from '../codes'
import { fail } from '../envelope'

export interface CreateFigureInput {
  ownerId: string // 只由认证的 researcher-service 身份（JWT）派生，永不来自客户端提交
  prompt: string
  idempotencyKey: string // Idempotency-Key 请求头（必带，T02）
}

// Idempotency-Key 防御上限（路由层强制，见 routes.ts requireIdempotencyKey）。
// spec/grilling 未定义 key 格式；上限只挡滥用——Node header 上限 ~16KB 可被整段索引落库
//（每行 ~16KB 索引项，永久膨胀 DB）。对合法客户端 key（如 32-hex）远足够；超限 → 90002
//（与缺头同码 + data null，确定性）。
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256

export interface FigureCreated {
  figureId: string
  jobId: string
  // 持久化契约回读（Standards code-review：路由不得硬编码 'queued' 作为第二来源）：
  // 首建 = generationJob.create 返回的 DB 行（默认 'queued'）；幂等重放 = 既有 Job 行当前
  // 应用级状态（queued/running/succeeded/failed）——二者都来自 DB，绝不硬编码。
  status: string
}

// 最小事务接缝（对齐 users.ts resetPasswordInTx 先例）：FigureCreateTx 只暴露本 seam
// 需要的两个 delegate，测试可注入 fake tx（第二次写失败 → 原子性验收）。
// 生产实参为 prisma.$transaction 回调的 TransactionClient（结构兼容，见 routes.ts）。
export interface FigureCreateTx {
  figure: {
    create(data: {
      data: { ownerId: string; prompt: string; idempotencyKey: string }
    }): Promise<{ id: string }>
  }
  generationJob: {
    create(data: { data: { figureId: string } }): Promise<{ id: string; status: string }>
  }
}

// 同一逻辑原子边界内持久化 Figure + 其 1:1 queued GenerationJob：
// Job 落库失败 → 抛错，调用方事务整体回滚（无孤儿 Figure，绝不返回成功 queued）。
// status 由 DB 默认 'queued'（本票不实现任何状态转换，T03 runner 负责）；返回行回读的
// status，而非调用方硬编码——响应反映实际落库值。幂等键随 Figure 同事务落库（唯一索引
// (ownerId, idempotencyKey) 是并发重复创建去重的最终仲裁）。
export async function createFigureWithJobInTx(
  tx: FigureCreateTx,
  input: CreateFigureInput,
): Promise<FigureCreated> {
  const figure = await tx.figure.create({
    data: { ownerId: input.ownerId, prompt: input.prompt, idempotencyKey: input.idempotencyKey },
  })
  const job = await tx.generationJob.create({
    data: { figureId: figure.id },
  })
  return { figureId: figure.id, jobId: job.id, status: job.status }
}

// 幂等查询结果：命中 (ownerId, idempotencyKey) 的唯一 Figure 及其 1:1 Job（读当前持久化状态）。
export interface IdempotentFigure {
  id: string
  prompt: string // 规范化创建输入（zod trim 后）——确定性输入比较的存储基准
  job: { id: string; status: string } | null
}

// 幂等编排依赖：routes 用 req.prisma 适配；测试可注入 fake（确定性竞态分支）。
export interface IdempotencyDeps {
  findByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<IdempotentFigure | null>
  createInTransaction(input: CreateFigureInput): Promise<FigureCreated>
}

// 幂等 check-or-create（grilling §17）：
//   1. 先查 (ownerId, idempotencyKey)：命中 → 同输入重放（返回当前 Job 状态）/ 异输入 70041。
//   2. 未命中 → 原子创建。撞唯一索引 P2002（并发重复）→ 复读 winner → 同输入重放 / 异输入 70041。
//   3. 只把已知 P2002（唯一约束冲突）走复读路径；其余持久化/锁/事务错误一律原样上抛
//      ——绝不把无关错误吞成成功重放（并发约束的最终仲裁是 DB 唯一索引，不是错误映射）。
// 不变量：任意并发重复逻辑创建至多一个 Figure + 至多一个初始 GenerationJob（P2002 复读只读不写）。
export async function createOrReplayFigure(
  deps: IdempotencyDeps,
  input: CreateFigureInput,
): Promise<FigureCreated> {
  const existing = await deps.findByIdempotencyKey(input.ownerId, input.idempotencyKey)
  if (existing) return resolveReplay(existing, input.prompt)

  try {
    return await deps.createInTransaction(input)
  } catch (e) {
    // 已知唯一约束冲突（并发 duplicate 的输家）：复读 winner 按输入同异重放/冲突。
    // 精确到 P2002 —— P2003/P2028/SQLITE_BUSY/未知错都原样上抛（见 createOrReplayFigure 头注）。
    const code = (e as { code?: string }).code
    if (code === 'P2002') {
      const winner = await deps.findByIdempotencyKey(input.ownerId, input.idempotencyKey)
      if (winner) return resolveReplay(winner, input.prompt)
      // 复读落空（理论不可达）：winner 已消隐则不可安全重放——上抛原始 P2002，不吞。
    }
    throw e
  }
}

// 幂等命中裁决：输入相同 → 重放（返回既有 Figure/Job 及 Job 当前应用级状态，零写入）；
// 输入不同 → 稳定幂等冲突（70041），零写入。
//
// ⚠️ 幂等身份（fingerprint）扩展点：比较基准是规范化存储字段 figure.prompt（zod trim 后，
// 即 §17.9 的「规范化创建载荷」——V1 唯一请求字段）。未来 T03+ 若新增「影响生成结果的请求
// 字段」（format/style 等），必须同步扩展此比较（连同 figure 行的持久化），否则该字段会
// 静默掉出幂等身份（同 key 异值误判为重放而非 70041）。这是本函数与 schema 的契约注释，非本票范围。
function resolveReplay(existing: IdempotentFigure, prompt: string): FigureCreated {
  if (existing.prompt !== prompt) throw fail(CODE.IDEMPOTENCY_CONFLICT)
  if (!existing.job) {
    // 理论不可达（T01 起 Figure 与 Job 恒同事务创建；legacy 行 key 为 NULL 查不到）：
    // 防御性失败——不返回缺 Job 的畸形响应。
    throw fail(CODE.INTERNAL, '幂等命中 Figure 缺关联 Job')
  }
  return { figureId: existing.id, jobId: existing.job.id, status: existing.job.status }
}

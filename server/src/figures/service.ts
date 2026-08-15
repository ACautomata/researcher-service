// AutoFigure 域 —— 事务 seam（T01，docs/autofigure/tickets/T01-authenticated-figure-creation.md）。
// 只交付「原子创建 Figure + 其 1:1 queued GenerationJob」这一最小写契约；
// 幂等（T02）、runner/状态机（T03）、读路径（T05）均不在本文件范围。

export interface CreateFigureInput {
  ownerId: string // 只由认证的 researcher-service 身份（JWT）派生，永不来自客户端提交
  prompt: string
}

export interface FigureCreated {
  figureId: string
  jobId: string
  // 持久化契约回读（Standards code-review：路由不得硬编码 'queued' 作为第二来源）：
  // status 来自 generationJob.create 返回的 DB 行，响应反映实际落库值（DB 默认 'queued'）。
  status: string
}

// 最小事务接缝（对齐 users.ts resetPasswordInTx 先例）：FigureCreateTx 只暴露本 seam
// 需要的两个 delegate，测试可注入 fake tx（第二次写失败 → 原子性验收）。
// 生产实参为 prisma.$transaction 回调的 TransactionClient（结构兼容，见 routes.ts）。
export interface FigureCreateTx {
  figure: {
    create(data: { data: { ownerId: string; prompt: string } }): Promise<{ id: string }>
  }
  generationJob: {
    create(data: { data: { figureId: string } }): Promise<{ id: string; status: string }>
  }
}

// 同一逻辑原子边界内持久化 Figure + 其 1:1 queued GenerationJob：
// Job 落库失败 → 抛错，调用方事务整体回滚（无孤儿 Figure，绝不返回成功 queued）。
// status 由 DB 默认 'queued'（本票不实现任何状态转换，T03 runner 负责）；返回行回读的
// status，而非调用方硬编码——响应反映实际落库值。
export async function createFigureWithJobInTx(
  tx: FigureCreateTx,
  input: CreateFigureInput,
): Promise<FigureCreated> {
  const figure = await tx.figure.create({
    data: { ownerId: input.ownerId, prompt: input.prompt },
  })
  const job = await tx.generationJob.create({
    data: { figureId: figure.id },
  })
  return { figureId: figure.id, jobId: job.id, status: job.status }
}

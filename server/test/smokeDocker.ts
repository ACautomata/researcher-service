// 真 docker daemon 集成 smoke 共享工具：镜像可获取性检查（pull 进度流消费）。
// 复用于 containers-smoke.test.ts 与 pairingSmoke.test.ts（两个真容器 smoke 各自持有逐字复制会漂移）。
// 门控语义由调用方决定：containers-smoke「必须真跑」→ ensureImageAvailable 抛错即套件失败；
// 旧版曾优雅 skip（镜像可获取 + daemon 可达双条件），codex PR#346 后去 skip 必须真跑。

import type Docker from 'dockerode'

// pull 消费面（可注入替身测进度流消费）：dockerode 的 pull 返回可读流，须经 modem.followProgress 排干，
// 否则流不 flowing、pull 永不完成（等 end 空挂到超时）；注册表失败以「进度记录」而非 error 事件出现，
// followProgress 会把它们回调成 err（codex PR#346 P2）。
export interface PullProgressClient {
  getImage(image: string): { inspect(): Promise<unknown> }
  pull(ref: string): Promise<NodeJS.ReadableStream>
  modem: { followProgress(s: NodeJS.ReadableStream, f: (err: Error | null) => void): void }
}

export async function defaultPullClient(): Promise<PullProgressClient> {
  const Docker = (await import('dockerode')).default
  const d = new Docker()
  return {
    getImage: (image) => d.getImage(image),
    pull: (ref) => d.pull(ref),
    modem: (d as Docker & { modem: PullProgressClient['modem'] }).modem,
  }
}

// 排干 pull 进度流并浮现 daemon 报告的错误（镜像 DockerRuntime.ensureImage 同款模式，codex PR#346 P2）。
// followProgress 消费流（不消费则流不 flowing、pull 永不完成）+ 回调注册表错误；保留 120s 挂起超时
//（daemon 既无进度也无错误时不无限挂住）。
export function drainPull(
  stream: NodeJS.ReadableStream,
  modem: PullProgressClient['modem'],
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('image pull timeout')), timeoutMs)
    modem.followProgress(stream, (err) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    })
  })
}

// 确保镜像可获取（本地已缓存 or 拉取成功）；失败 → 抛错（集成 smoke 必须真跑，绝不静默跳过）。
// client 可注入（测试替身）；缺省建真 dockerode 客户端。
export async function ensureImageAvailable(image: string, client?: PullProgressClient): Promise<void> {
  const c = client ?? (await defaultPullClient())
  try {
    await c.getImage(image).inspect() // 本地已缓存 → 就绪
    return
  } catch {
    /* 本地缺失 → 拉取 */
  }
  const stream = await c.pull(image)
  await drainPull(stream, c.modem)
}

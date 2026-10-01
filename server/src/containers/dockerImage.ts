// docker 镜像就位 helper（fleet DockerRuntime 与沙箱 DockerSandboxRuntime 共用样板，#776 收拈）。
// 语义（对齐 containers/dockerRuntime.ts 原实现注释）：本地缺失才拉取（getImage().inspect() 404
// → pull；已缓存 → 跳过）；pull 经 modem.followProgress 消费进度流（不消费则流不 flowing、pull
// 永不完成）；拉取失败向上抛（caller 标 error 行/中止编排）。

import type Docker from 'dockerode'

// clientFactory 延迟注入形态下取 modem 的最小形状（dockerode 无类型导出，同 dockerRuntime.ts 内联断言）
type ModemClient = Docker & { modem: { followProgress(s: NodeJS.ReadableStream, f: (err: Error | null) => void): void } }

export async function ensureImagePulled(client: Docker, image: string): Promise<void> {
  try {
    await client.getImage(image).inspect()
    return
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 404) throw e // daemon 故障等真错不吞
  }
  const stream = await client.pull(image)
  await new Promise<void>((resolve, reject) => {
    ;(client as ModemClient).modem.followProgress(stream, (err) => (err ? reject(err) : resolve()))
  })
}

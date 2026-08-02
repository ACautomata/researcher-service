// DockerRuntime 适配层单测（接缝：clientFactory 注入 mock dockerode client）。
// 聚焦 Codex C5（P2）：stop 对「外部已停容器」(304) 与「不存在」(404) 须幂等成功，
// 否则被外部 stop 的容器让 delete worker 反复抛错、永远到不了 remove()，行卡 REMOVING 无解。
// 真容器端到端由 containers-smoke 覆盖；此处用 mock client 隔离 daemon 测错误码归一。

import { describe, it, expect } from 'vitest'
import type Docker from 'dockerode'
import { DockerRuntime } from '../src/containers/dockerRuntime'

// 最小 mock：仅需 getContainer().stop() 能注入指定 statusCode 错误。
function mockDocker(stopErr?: { statusCode: number; message: string }): Docker {
  return {
    getContainer: () => ({
      stop: async () => {
        if (stopErr) {
          const e = new Error(stopErr.message) as Error & { statusCode: number }
          e.statusCode = stopErr.statusCode
          throw e
        }
      },
    }),
  } as unknown as Docker
}

describe('DockerRuntime stop 幂等（Codex C5）', () => {
  it('容器已被外部停止（304 Not Modified）→ 幂等成功不抛', async () => {
    const rt = new DockerRuntime(() => mockDocker({ statusCode: 304, message: 'container already stopped' }))
    await expect(rt.stop('box')).resolves.toBeUndefined()
  })

  it('容器不存在（404）→ 幂等成功不抛', async () => {
    const rt = new DockerRuntime(() => mockDocker({ statusCode: 404, message: 'no such container' }))
    await expect(rt.stop('box')).resolves.toBeUndefined()
  })

  it('其他错误码（500）→ 仍向上抛（不吞非幂等错误，避免掩盖真故障）', async () => {
    const rt = new DockerRuntime(() => mockDocker({ statusCode: 500, message: 'daemon internal error' }))
    await expect(rt.stop('box')).rejects.toThrow('daemon internal error')
  })
})

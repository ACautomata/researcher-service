// DockerRuntime 适配层单测（接缝：clientFactory 注入 mock dockerode client）。
// 聚焦 Codex C5（P2）：stop 对「外部已停容器」(304) 与「不存在」(404) 须幂等成功，
// 否则被外部 stop 的容器让 delete worker 反复抛错、永远到不了 remove()，行卡 REMOVING 无解。
// 真容器端到端由 containers-smoke 覆盖；此处用 mock client 隔离 daemon 测错误码归一。

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
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

// ---- run 前拉取镜像（Codex 第四轮③[P1]）----
// run 只 createContainer+start，无 pull。Engine createContainer 对本地缺失镜像返回 image-not-found——
// 干净 host / OPENCLAW_IMAGE 换 tag 时 create 必 error（CI 此前靠手动 docker pull 掩盖）。修法：run 前
// getImage().inspect() 本地缺失(404) → pull（modem.followProgress 消费流）；已缓存 → 跳过，避免每次
// create 重复 pull。

function mockPullClient(opts: { imagePresent?: boolean; pullErr?: Error }): {
  docker: Docker
  pulls: string[]
} {
  const pulls: string[] = []
  const docker = {
    getImage: () => ({
      inspect: async () => {
        if (opts.imagePresent === false) {
          const e = new Error('no such image') as Error & { statusCode: number }
          e.statusCode = 404
          throw e
        }
        return {}
      },
    }),
    pull: async (image: string) => {
      pulls.push(image)
      if (opts.pullErr) throw opts.pullErr
      return Readable.from(['{}'])
    },
    getContainer: () => ({
      start: async () => {},
    }),
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      lastCreateOptions = options
      return {
        id: 'cid-123',
        start: async () => {},
      }
    },
    modem: {
      followProgress: (_s: NodeJS.ReadableStream, onFinished: (err: Error | null) => void) =>
        onFinished(null),
    },
  } as unknown as Docker & { modem: unknown }
  return { docker: docker as unknown as Docker, pulls }
}

// 捕获最近一次 createContainer 的 options（供 bind 断链回归断言）
let lastCreateOptions: Docker.ContainerCreateOptions | undefined

describe('DockerRuntime ensureImage（Codex 第四轮③）', () => {
  const spec = (name: string, hostPort: number) => ({
    name,
    image: 'ghcr.io/openclaw/openclaw:test',
    hostPort,
    gatewayToken: 'tok',
    homeDir: '/tmp/home',
    configDir: '/tmp/config',
    llmApiKey: 'key',
  })

  it('本地镜像缺失 → create 前自动 pull（Engine createContainer 不因 image-not-found 失败）', async () => {
    const { docker, pulls } = mockPullClient({ imagePresent: false })
    const rt = new DockerRuntime(() => docker)
    const id = await rt.run(spec('r4-pull', 19000))
    expect(pulls).toEqual(['ghcr.io/openclaw/openclaw:test']) // 缺失 → 已拉取
    expect(id).toBe('cid-123') // create+start 成功
  })

  it('本地镜像已缓存 → 跳过 pull（避免每次 create 重复拉取）', async () => {
    const { docker, pulls } = mockPullClient({ imagePresent: true })
    const rt = new DockerRuntime(() => docker)
    await rt.run(spec('r4-cached', 19001))
    expect(pulls).toEqual([]) // 已缓存 → 不拉
  })

  it('pull 失败 → 向上抛（createComplete 标 error 行，可重试）', async () => {
    const { docker } = mockPullClient({ imagePresent: false, pullErr: new Error('registry unreachable') })
    const rt = new DockerRuntime(() => docker)
    await expect(rt.run(spec('r4-pullfail', 19002))).rejects.toThrow('registry unreachable')
  })

  it('#366 codex P1：config 独立目录 ro bind + OPENCLAW_CONFIG_PATH（热加载保留 + 恢复只读边界）；无单文件 bind', async () => {
    // 第一轮修复只 bind home rw——热加载恢复（rename 换 inode 目录 bind 容器内可见），但容器以
    // root(0:0) 跑、0644 无约束 → 容器内进程可持久改 openclaw.json（codex P1 只读边界）。第二轮
    // config 独立 instances/<id>/config 目录 ro bind + gateway 经 OPENCLAW_CONFIG_PATH 读取：
    // 目录 bind 下宿主 rename 换 inode 容器内可见 + ro 只约束容器侧（宿主写 host 路径不受影响）。
    // 单文件 bind 在 openclaw 镜像上不可靠（m2 实证：bind 源缺失时容器内变目录），故用目录 bind。
    const { docker } = mockPullClient({ imagePresent: true })
    const rt = new DockerRuntime(() => docker)
    await rt.run(spec('r1-bind', 19003))
    const binds = lastCreateOptions?.HostConfig?.Binds ?? []
    expect(binds).toEqual([
      '/tmp/home:/home/node/.openclaw:rw', // workspace/wiki/state/logs 可写
      '/tmp/config:/home/node/.openclaw-config:ro', // openclaw.json 容器侧只读
    ])
    expect(binds.some((b) => b.includes('openclaw.json'))).toBe(false) // 无单文件 bind
    const env = (lastCreateOptions?.Env as string[]) ?? []
    expect(env).toContain('OPENCLAW_CONFIG_PATH=/home/node/.openclaw-config/openclaw.json')
  })
})

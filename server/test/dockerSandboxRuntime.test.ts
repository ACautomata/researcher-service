// 沙箱 create options 纯逻辑单测（#776 · S3；buildSandboxCreateOptions 不调 daemon 直锁形状）。
// #747 E 节沙箱列 + story 59 安全/资源规格的逐项断言：非 root / CapDrop ALL /
// no-new-privileges / RestartPolicy no / Memory·CPU·Pids / tmpfs / 独立网络 /
// 无宿主端口 / 无 env / kind 标签（对 fleet 隐身）。

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { DockerSandboxRuntime } from '../src/sandboxes/dockerRuntime'
import { sandboxContainerName, sandboxNetworkName } from '../src/sandboxes/runtime'
import { SANDBOX_LIMITS } from '../src/sandboxes/values'
import { KIND_SANDBOX, LABEL_KIND_KEY, LABEL_SESSION_KEY } from '../src/containers/constants'

const SPEC = { sessionId: 'csession0001', image: 'busybox:1.36', limits: SANDBOX_LIMITS }

describe('沙箱命名单一来源', () => {
  it('容器名 researcher-sandbox-<sessionId> / 网络 researcher-sandbox-net-<sessionId>', () => {
    expect(sandboxContainerName('csession0001')).toBe('researcher-sandbox-csession0001')
    expect(sandboxNetworkName('csession0001')).toBe('researcher-sandbox-net-csession0001')
  })
})

describe('buildSandboxCreateOptions（#747 E 节沙箱列投影）', () => {
  const rt = new DockerSandboxRuntime(() => null as never)
  const opts = rt.buildSandboxCreateOptions(SPEC)

  it('镜像 + docker 名 + 保活命令（PID 1 最小内存进程）', () => {
    expect(opts.Image).toBe('busybox:1.36')
    expect(opts.name).toBe('researcher-sandbox-csession0001')
    expect(opts.Cmd).toEqual(['tail', '-f', '/dev/null'])
  })

  it('非 root（uid 1000 数值身份）', () => {
    expect(opts.User).toBe('1000:1000')
  })

  it('标签：kind=sandbox + session 绑定（#858 起无 fleet app 标签概念，沙箱标签面仅 kind/session）', () => {
    expect(opts.Labels).toMatchObject({
      [LABEL_KIND_KEY]: KIND_SANDBOX,
      [LABEL_SESSION_KEY]: 'csession0001',
    })
  })

  it('安全 profile：CapDrop ALL + no-new-privileges + RestartPolicy no（生命周期归 runner）', () => {
    expect(opts.HostConfig?.CapDrop).toEqual(['ALL'])
    expect(opts.HostConfig?.SecurityOpt).toEqual(['no-new-privileges'])
    expect(opts.HostConfig?.RestartPolicy).toEqual({ Name: 'no' })
  })

  it('资源 limit：Memory 4GB / 4 核 / PidsLimit 512（spec 初值）；MemorySwap=Memory 禁 swap（OOM 语义前提）', () => {
    expect(opts.HostConfig?.Memory).toBe(4 * 1024 * 1024 * 1024)
    expect(opts.HostConfig?.MemorySwap).toBe(4 * 1024 * 1024 * 1024)
    expect(opts.HostConfig?.NanoCpus).toBe(4_000_000_000)
    expect(opts.HostConfig?.PidsLimit).toBe(512)
  })

  it('每沙箱独立 bridge 网络（容器间零互通）+ /tmp tmpfs', () => {
    expect(opts.HostConfig?.NetworkMode).toBe('researcher-sandbox-net-csession0001')
    expect(opts.HostConfig?.Tmpfs).toEqual({ '/tmp': '' })
  })

  it('不设 ReadonlyRootfs、不挂任何卷（E 节三取二取舍锁死：文件保留靠容器可写层，误开只读根 = 闲置 stop 文件丢失回归；取舍论证见 dockerRuntime.ts 注释）', () => {
    expect(opts.HostConfig?.ReadonlyRootfs).toBeUndefined()
    expect(opts.HostConfig?.Binds).toBeUndefined()
  })

  it('无宿主端口发布、无 env 注入（OPENCLAW_*/GATEWAY_TOKEN/LLM_API_KEY 全面退役）', () => {
    expect(opts.HostConfig?.PortBindings).toBeUndefined()
    expect(opts.ExposedPorts).toBeUndefined()
    expect(opts.Env).toBeUndefined()
  })

  it('limits 经 spec 参数注入（smoke/校准覆盖，不与常量耦合）', () => {
    const small = rt.buildSandboxCreateOptions({
      ...SPEC,
      limits: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1_000_000_000, pidsLimit: 64 },
    })
    expect(small.HostConfig?.Memory).toBe(256 * 1024 * 1024)
    expect(small.HostConfig?.PidsLimit).toBe(64)
  })
})

// 回归：低核 host 上 create 被 daemon 400 拒收（"Range of CPUs is from 0.01 to 2.00, as there
// are only 2 CPUs available"）。规格初值 4 核必须按 daemon info().NCPU 钳制。
describe('NanoCpus host 钳制（低核 host 400 回归）', () => {
  function mockClient(ncpu: number, calls: { kind: string; opts?: Docker.ContainerCreateOptions }[]) {
    const docker = {
      info: async () => ({ NCPU: ncpu }),
      getImage: () => ({ inspect: async () => ({}) }),
      createContainer: async (o: Docker.ContainerCreateOptions) => {
        calls.push({ kind: 'createContainer', opts: o })
        return { putArchive: async () => {} }
      },
      // fork 前置：源容器 inspect 存在 + export 流 + importImage 空实现
      getContainer: () => ({
        inspect: async () => ({}),
        export: async () => Readable.from([Buffer.alloc(0)]),
      }),
      importImage: async () => {},
    }
    return docker as unknown as Docker
  }

  it('host 2 核：spec 4 核被钳到 2e9 再 create（不触 daemon 400）', async () => {
    const calls: { kind: string; opts?: Docker.ContainerCreateOptions }[] = []
    const rt = new DockerSandboxRuntime(() => mockClient(2, calls))
    await rt.createSandbox(SPEC)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts?.HostConfig?.NanoCpus).toBe(2_000_000_000)
    // 钳制只动 CPU：内存/Pids 原样
    expect(calls[0].opts?.HostConfig?.Memory).toBe(4 * 1024 * 1024 * 1024)
    expect(calls[0].opts?.HostConfig?.PidsLimit).toBe(512)
  })

  it('host 8 核：spec 4 核不抬升（钳制是上限语义，不做放大）', async () => {
    const calls: { kind: string; opts?: Docker.ContainerCreateOptions }[] = []
    const rt = new DockerSandboxRuntime(() => mockClient(8, calls))
    await rt.createSandbox(SPEC)
    expect(calls[0].opts?.HostConfig?.NanoCpus).toBe(4_000_000_000)
  })

  it('fork 路径（createSandboxFromSource）同钳制', async () => {
    const calls: { kind: string; opts?: Docker.ContainerCreateOptions }[] = []
    const rt = new DockerSandboxRuntime(() => mockClient(2, calls))
    await rt.createSandboxFromSource({ sessionId: 'csession0002', sourceSessionId: 'csession0001', limits: SANDBOX_LIMITS })
    expect(calls).toHaveLength(1)
    expect(calls[0].opts?.HostConfig?.NanoCpus).toBe(2_000_000_000)
  })
})

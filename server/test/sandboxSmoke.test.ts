// 沙箱生命周期集成 smoke（#776 验收 1/2 真 daemon 侧 · S2 门控）。
// 门控：docker daemon 不可达 → describe.skipIf 整套跳过（先例 dockerArchiveBackendSmoke）；
// 单测（fake-Docker）是 S2 常开防线，本 smoke 是基座组件的可选集成证据。
// 覆盖：
//   1. ensure 惰性创建 → 真 inspect 断言 #747 E 节安全/资源规格（非 root/CapDrop/no-new-priv/
//      RestartPolicy no/limits/tmpfs/独立网络/kind 标签/无端口）
//   2. /lab 属主可写（uid 1000 预置生效）：backend.write → readLab 真 getArchive 读回
//   3. 闲置回收：假时钟 sweep → stop（文件保留：复启后 readLab 仍在）→ remove 容器+网络全清
//   4. OOM（story 59）：小内存沙箱 exec 内存猪 → 进程被杀 exitCode 137、容器存活、
//      execute() 的 ExecuteResponse 原样回流（#777 接线后 deepagents 包成 ToolMessage 回 agent）
//   5. 对 fleet 列表隐身：app=openclaw-fleet 过滤不含沙箱、kind=sandbox 过滤含沙箱

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Docker from 'dockerode'
import { SandboxLifecycle } from '../src/sandboxes/lifecycle'
import { DockerSandboxRuntime } from '../src/sandboxes/dockerRuntime'
import { sandboxContainerName, sandboxNetworkName } from '../src/sandboxes/runtime'
import { DockerArchiveBackend } from '../src/runner/backend/dockerArchiveBackend'
import { DockerPrimitives } from '../src/runner/backend/dockerPrimitives'
import { DockerFileArchive } from '../src/files/dockerArchive'
import { KIND_SANDBOX, LABEL_APP_VALUE, LABEL_KIND_KEY } from '../src/containers/constants'
import { probeDockerAvailable } from './smokeGating'
import { ensureImageAvailable } from './smokeDocker'

const IMAGE = 'busybox:1.36'
const SESSION = `csmoke${process.pid}` // 合法 name 段（小写开头）；跨进程唯一
// smoke 用小 limits（与规格初值无关——纯逻辑测试已锁 4GB/4 核/512 形状；128MB 让 OOM 探针
// 快且省资源；MemorySwap=Memory 禁 swap 是 OOM 杀进程语义的前提，options 测试已锁）
const SMOKE_LIMITS = { memoryBytes: 128 * 1024 * 1024, nanoCpus: 1_000_000_000, pidsLimit: 64 }

const DOCKER_UP = probeDockerAvailable()

describe.skipIf(!DOCKER_UP)('沙箱生命周期集成 smoke（真 docker daemon）', () => {
  let docker: Docker
  let runtime: DockerSandboxRuntime
  let fakeClock = 1_000_000
  let now = () => fakeClock
  let lifecycle: SandboxLifecycle
  let dockerName: string

  beforeAll(async () => {
    if (!DOCKER_UP) return
    docker = new Docker()
    await ensureImageAvailable(IMAGE)
    runtime = new DockerSandboxRuntime()
    lifecycle = new SandboxLifecycle(runtime, { image: IMAGE, limits: SMOKE_LIMITS, idleMs: 200, now })
    dockerName = sandboxContainerName(SESSION)
  }, 120_000)

  afterAll(async () => {
    if (!DOCKER_UP) return
    if (!runtime) return // beforeAll 中途失败（如镜像拉取超时）→ runtime 未赋值，防 TypeError 次生噪声
    await runtime.removeSandbox(SESSION)
    await runtime.removeNetwork(SESSION)
  })

  it('ensure 惰性创建：inspect 断言安全/资源/标签规格（#747 E 节沙箱列）', async () => {
    const info = await lifecycle.ensure(SESSION)
    expect(info.running).toBe(true)
    const data = await docker.getContainer(dockerName).inspect()
    // 资源 limit（smoke 注入值——形状与规格初值同构）
    expect(data.HostConfig.Memory).toBe(SMOKE_LIMITS.memoryBytes)
    expect(data.HostConfig.MemorySwap).toBe(SMOKE_LIMITS.memoryBytes) // 禁 swap：OOM 杀进程语义前提
    expect(data.HostConfig.NanoCpus).toBe(SMOKE_LIMITS.nanoCpus)
    expect(data.HostConfig.PidsLimit).toBe(SMOKE_LIMITS.pidsLimit)
    // 安全 profile
    expect(data.Config.User).toBe('1000:1000')
    expect(data.HostConfig.CapDrop).toEqual(['ALL'])
    expect(data.HostConfig.SecurityOpt).toEqual(['no-new-privileges'])
    expect(data.HostConfig.RestartPolicy?.Name).toBe('no')
    // /tmp tmpfs + 独立 bridge 网络（每沙箱一网络，容器间零互通）
    expect(Object.keys(data.HostConfig.Tmpfs ?? {})).toContain('/tmp')
    expect(data.HostConfig.NetworkMode).toBe(sandboxNetworkName(SESSION))
    expect(Object.keys(data.NetworkSettings.Networks ?? {})).toEqual([sandboxNetworkName(SESSION)])
    // 标签：kind=sandbox + session；不打 fleet app 标签
    expect(data.Config.Labels).toMatchObject({ [LABEL_KIND_KEY]: KIND_SANDBOX, 'researcher.session': SESSION })
    expect(data.Config.Labels?.app).toBeUndefined()
    // 无宿主端口发布
    expect(data.HostConfig.PortBindings ?? {}).toEqual({})
    // 保活 PID 1 存在（tail 在跑）
    expect(data.State.Running).toBe(true)
  }, 120_000)

  it('/lab 属主可写（uid 1000 预置生效）：backend.write → readLab 真通道读回', async () => {
    const backend = new DockerArchiveBackend(new DockerPrimitives(), { wiki: 'smoke-wiki-unused', lab: dockerName })
    const w = await backend.write('/lab/out/hello.txt', '# smoke lab\n')
    expect('error' in w).toBe(false)
    const fa = new DockerFileArchive()
    const r = await fa.readLab(dockerName, 'out/hello.txt', false)
    expect(r).toMatchObject({ kind: 'file', path: 'out/hello.txt', content: '# smoke lab\n' })
    // 目录分支同样通（getArchive /lab 真通道）
    const dir = await fa.readLab(dockerName, 'out', false)
    expect(dir).toMatchObject({ kind: 'dir', path: 'out' })
  }, 60_000)

  it('闲置回收：sweep 停（文件保留）→ ensure 复启文件仍在 → remove 容器+网络全清', async () => {
    fakeClock += 500 // 越过 idleMs(200)
    const stopped = await lifecycle.sweepIdle()
    expect(stopped).toEqual([SESSION])
    expect((await runtime.getSandbox(SESSION))!.running).toBe(false)
    // 文件保留：stop 不动可写层
    await lifecycle.ensure(SESSION)
    const fa = new DockerFileArchive()
    const r = await fa.readLab(dockerName, 'out/hello.txt', false)
    expect(r).toMatchObject({ kind: 'file', content: '# smoke lab\n' })
    // 级联删：容器 + 独立网络全清
    expect(await lifecycle.remove(SESSION)).toBe('removed')
    expect(await runtime.getSandbox(SESSION)).toBeNull()
    await expect(docker.getNetwork(sandboxNetworkName(SESSION)).inspect()).rejects.toMatchObject({ statusCode: 404 })
    // 幂等：再删 not-found（#778 级联链重试安全）
    expect(await lifecycle.remove(SESSION)).toBe('not-found')
  }, 60_000)

  it('OOM（story 59）：exec 内存猪 → 进程被杀 exitCode 137、容器存活、错误回流', async () => {
    // 确保沙箱在跑（上一用例已 remove）
    await lifecycle.ensure(SESSION)
    const backend = new DockerArchiveBackend(new DockerPrimitives(), { wiki: 'smoke-wiki-unused', lab: dockerName })
    // busybox 无 stress。内存猪 = sh 变量持有 ~230MB 文本（seq 3000 万行；busybox 的 $(dd)
    // 在 NUL 处截断不触发 OOM——已实测排除）。cgroup 内最大 RSS 的 sh 被 OOM-killer 选杀；
    // PID 1（tail）极小存活 →「杀进程不杀容器」
    const r = await backend.execute('x=$(seq 1 30000000); echo len=${#x}')
    expect(r.exitCode).toBe(137) // SIGKILL（OOM）——无超时归一化，原样透传
    expect(r.truncated).toBe(false)
    // 错误回流面：execute 输出/退出码即 #777 接线后 agent 收到的 Tool 结果形态（自纠素材）
    expect((r.output ?? '').length).toBeGreaterThanOrEqual(0)
    const info = await runtime.getSandbox(SESSION)
    expect(info!.running).toBe(true) // 容器存活
    // 容器级证据：docker State 仍 running（注：State.OOMKilled=true 是「cgroup 内发生过 OOM
    // 事件」的标记——daemon 对任何进程被杀都置位，不代表容器主进程被杀；存活判定只看 Running）
    const inspect = await docker.getContainer(dockerName).inspect()
    expect(inspect.State.Running).toBe(true)
    // 容器仍可用（agent 自纠路径：下一条命令正常执行）
    const ok = await backend.execute('echo alive')
    expect(ok.exitCode).toBe(0)
    expect(ok.output).toContain('alive')
  }, 60_000)

  it('对 fleet 列表隐身：app=openclaw-fleet 过滤不含沙箱；kind=sandbox 过滤含沙箱', async () => {
    const fleet = await docker.listContainers({ all: true, filters: { label: [`app=${LABEL_APP_VALUE}`] } })
    expect(fleet.map((c) => c.Names?.[0])).not.toContain(`/${dockerName}`)
    const sandboxes = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_KIND_KEY}=${KIND_SANDBOX}`] },
    })
    expect(sandboxes.map((c) => c.Names?.[0])).toContain(`/${dockerName}`)
  })
})

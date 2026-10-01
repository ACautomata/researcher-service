// DockerPrimitives adapter 级单测（S2 接缝真身；fake dockerode client，零 daemon）。
// 覆盖评审 M2 的超时机制：Engine API 无 exec-kill 端点（POST /exec/{id}/kill 对真 daemon
// 404 实证，moby#9098；exec inspect 的 Pid 为宿主命名空间值、容器内不可寻址）——经容器内
// timeout coreutil 包 argv（-s KILL）；退出码 124（GNU 原生）/137（busybox 128+KILL）归一
// 为 124 + stderr 附说明。真 daemon 侧 kill 证据见 dockerArchiveBackendSmoke.test.ts 超时用例；
// backend 层的默认超时注入由 dockerArchiveBackend.test.ts 直锁。
// demux 真身在 dockerode modem，fake 以「原样 pipe 到 stdout」简化（不考 8 字节复用头）。

import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import type Docker from 'dockerode'
import { DockerPrimitives } from '../src/runner/backend/dockerPrimitives'

interface FakeExecScript {
  /** 容器内行为脚本：按最终 argv 决定 exec 结局（真 daemon 侧 timeout 语义的简化模拟） */
  run: (argv: string[]) => { exitCode: number | null; endStream: boolean }
  /** 记录 container.exec 收到的全部 argv（证据：超时参数包装形状） */
  execArgv: string[][]
}

function fakeClientFor(script: FakeExecScript): Docker {
  const client = {
    getContainer: () => ({
      exec: async (opts: { Cmd: string[] }) => {
        script.execArgv.push(opts.Cmd)
        const outcome = script.run(opts.Cmd)
        const started = new PassThrough()
        return {
          id: 'exec-fake-1',
          start: async () => {
            if (outcome.endStream) setImmediate(() => started.end())
            return started
          },
          inspect: async () => ({ ExitCode: outcome.exitCode }),
        }
      },
    }),
    modem: {
      demuxStream: (s: NodeJS.ReadableStream, out: PassThrough, _err: PassThrough) => {
        ;(s as PassThrough).pipe(out)
      },
    },
  }
  return client as unknown as Docker
}

describe('DockerPrimitives.exec（dockerode 适配）', () => {
  it('超时：argv 包 timeout -s KILL（ms 向上取整秒），busybox 137 归一为 exitCode 124 + stderr 附说明', async () => {
    const script: FakeExecScript = {
      run: (argv) => (argv[0] === 'timeout' ? { exitCode: 137, endStream: true } : { exitCode: 0, endStream: true }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['/bin/sh', '-c', 'sleep 99999'], { timeoutMs: 800 })
    expect(script.execArgv[0]).toEqual(['timeout', '-s', 'KILL', '1', '/bin/sh', '-c', 'sleep 99999'])
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('timed out after 800ms')
  })

  it('GNU coreutils timeout 原生 124 同样归一（全量镜像的 lab 沙箱路径）', async () => {
    const script: FakeExecScript = {
      run: () => ({ exitCode: 124, endStream: true }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['/bin/sh', '-c', 'sleep 99999'], { timeoutMs: 60_000 })
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('timed out after 60000ms')
  })

  it('限时内完成：argv 已包装但 exitCode 原样透传，无超时文案', async () => {
    const script: FakeExecScript = {
      run: () => ({ exitCode: 0, endStream: true }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['echo', 'ok'], { timeoutMs: 60_000 })
    expect(script.execArgv[0]).toEqual(['timeout', '-s', 'KILL', '60', 'echo', 'ok'])
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('无超时参数：argv 原样、exitCode 原样透传（向后兼容）', async () => {
    const script: FakeExecScript = {
      run: () => ({ exitCode: 7, endStream: true }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['false'])
    expect(script.execArgv[0]).toEqual(['false'])
    expect(r.exitCode).toBe(7)
  })
})

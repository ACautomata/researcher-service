// DockerPrimitives adapter 级单测（S2 接缝真身；fake dockerode client，零 daemon）。
// 覆盖评审 M2 的超时机制：Engine API 无 exec-kill 端点（POST /exec/{id}/kill 对真 daemon
// 404 实证，moby#9098；exec inspect 的 Pid 为宿主命名空间值、容器内不可寻址）——经容器内
// timeout coreutil 包 argv（-s KILL）；退出码归一 124 + stderr 附说明，elapsed >= timeoutMs
// 消歧（限时内自行 exit 124/137 原样透传）。真 daemon 侧 kill 证据见
// dockerArchiveBackendSmoke.test.ts 超时用例；backend 层的默认超时注入由
// dockerArchiveBackend.test.ts 直锁。demux fake 以「原样 pipe 到 stdout」简化
// （不考 8 字节复用头），stdout 拼接路径由本文件覆盖。

import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import type Docker from 'dockerode'
import { DockerPrimitives } from '../src/runner/backend/dockerPrimitives'

interface FakeExecScript {
  /** 容器内行为脚本：按最终 argv 决定 exec 结局（真 daemon 侧 timeout 语义的简化模拟） */
  run: (argv: string[]) => { exitCode: number | null; endAfterMs?: number; stdout?: string }
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
            setTimeout(() => {
              if (outcome.stdout) started.write(outcome.stdout)
              started.end()
            }, outcome.endAfterMs ?? 0)
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
  it('超时：argv 包 timeout -s KILL（ms 向上取整秒），到期 137 归一为 exitCode 124 + stderr 附说明 + stdout 透传', async () => {
    const script: FakeExecScript = {
      // 真 daemon 模型：wrapped argv 到期（ceil(800ms)=1s）被 KILL，exit 137，先产出部分输出
      run: (argv) =>
        argv[0] === 'timeout'
          ? { exitCode: 137, endAfterMs: 1000, stdout: 'partial-output\n' }
          : { exitCode: 0, endAfterMs: 0 },
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['/bin/sh', '-c', 'sleep 99999'], { timeoutMs: 800 })
    expect(script.execArgv[0]).toEqual(['timeout', '-s', 'KILL', '1', '/bin/sh', '-c', 'sleep 99999'])
    expect(r.exitCode).toBe(124)
    expect(r.stdout).toBe('partial-output\n')
    expect(r.stderr).toContain('timed out after 800ms')
  })

  it('exit 124 归一保留为防御路径（GNU coreutils 124 仅 TERM 类信号；-s KILL 下 GNU/busybox 实测均 137）', async () => {
    const script: FakeExecScript = {
      run: () => ({ exitCode: 124, endAfterMs: 1000 }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['/bin/sh', '-c', 'sleep 99999'], { timeoutMs: 800 })
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('timed out after 800ms')
  })

  it('限时内自行 exit 137（受限沙箱 OOM 被杀场景）→ 原样透传，不归一、不附超时文案（elapsed 消歧回归）', async () => {
    const script: FakeExecScript = {
      run: () => ({ exitCode: 137, endAfterMs: 0 }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['/bin/sh', '-c', 'some-hungry-cmd'], { timeoutMs: 60_000 })
    expect(r.exitCode).toBe(137)
    expect(r.stderr).toBe('')
  })

  it('限时内完成：argv 已包装但 exitCode 原样透传，无超时文案', async () => {
    const script: FakeExecScript = {
      run: () => ({ exitCode: 0, endAfterMs: 0, stdout: 'ok\n' }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['echo', 'ok'], { timeoutMs: 60_000 })
    expect(script.execArgv[0]).toEqual(['timeout', '-s', 'KILL', '60', 'echo', 'ok'])
    expect(r).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' })
  })

  it('无超时参数：argv 原样、exitCode 原样透传（向后兼容）', async () => {
    const script: FakeExecScript = {
      run: () => ({ exitCode: 7, endAfterMs: 0 }),
      execArgv: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['false'])
    expect(script.execArgv[0]).toEqual(['false'])
    expect(r.exitCode).toBe(7)
  })
})

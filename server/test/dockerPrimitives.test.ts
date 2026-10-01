// DockerPrimitives adapter 级单测（S2 接缝真身；fake dockerode client，零 daemon）。
// 覆盖评审 M2 的超时机制：exec 挂起命令 → POST /exec/{id}/kill → exitCode 124 + stderr 附说明
// （backend 层的默认超时注入由 dockerArchiveBackend.test.ts 直锁，此处测 adapter 执行）。
// demux 真身在 dockerode modem，fake 以「原样 pipe 到 stdout」简化（不考 8 字节复用头）。

import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import type Docker from 'dockerode'
import { DockerPrimitives } from '../src/runner/backend/dockerPrimitives'

interface FakeExecScript {
  /** exec.start 返回的流：end 由测试脚本（或 kill）触发 */
  started: PassThrough
  inspect: () => Promise<{ ExitCode: number | null }>
  /** daemon 收到 kill 后的行为（真实 daemon：SIGKILL 进程 → 流 end） */
  onKill: () => void
  /** 记录 modem.dial 调用的 path（证据：kill 走了 /exec/{id}/kill） */
  dialPaths: string[]
}

function fakeClientFor(script: FakeExecScript): Docker {
  const client = {
    getContainer: () => ({
      exec: async () => ({
        id: 'exec-fake-1',
        modem: {
          dial: (opts: { path: string }, cb: (e: unknown) => void) => {
            script.dialPaths.push(opts.path)
            if (opts.path.includes('/kill')) script.onKill()
            cb(null)
          },
        },
        start: async () => script.started,
        inspect: script.inspect,
      }),
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
  it('超时：POST /exec/{id}/kill 被调用，exitCode=124，stderr 附超时说明（上游 LocalShellBackend 语义）', async () => {
    const started = new PassThrough()
    let killed = false
    const script: FakeExecScript = {
      started,
      inspect: async () => ({ ExitCode: 137 }),
      onKill: () => {
        killed = true
        started.end()
      },
      dialPaths: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    const r = await p.exec('c1', ['/bin/sh', '-c', 'sleep 99999'], { timeoutMs: 30 })
    expect(killed).toBe(true)
    expect(script.dialPaths).toContain('/exec/exec-fake-1/kill?')
    expect(r.exitCode).toBe(124)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('timed out after 30ms')
  })

  it('限时内完成：exitCode 原样透传，不判超时', async () => {
    const started = new PassThrough()
    const script: FakeExecScript = {
      started,
      inspect: async () => ({ ExitCode: 0 }),
      onKill: () => {},
      dialPaths: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    started.write('ok\n')
    started.end()
    const r = await p.exec('c1', ['echo', 'ok'], { timeoutMs: 60_000 })
    expect(r).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' })
    expect(script.dialPaths).toEqual([])
  })

  it('无超时参数：行为与既有契约一致（exitCode 原样透传）', async () => {
    const started = new PassThrough()
    const script: FakeExecScript = {
      started,
      inspect: async () => ({ ExitCode: 7 }),
      onKill: () => {},
      dialPaths: [],
    }
    const p = new DockerPrimitives(() => fakeClientFor(script))
    started.write('out\n')
    started.end()
    const r = await p.exec('c1', ['false'])
    expect(r).toEqual({ exitCode: 7, stdout: 'out\n', stderr: '' })
    expect(script.dialPaths).toEqual([])
  })
})

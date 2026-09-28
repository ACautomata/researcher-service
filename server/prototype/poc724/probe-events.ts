// PoC #724 · THROWAWAY —— 探针：dump streamEvents v3 实际事件名（一次性诊断脚本）。
import 'dotenv/config'
import Docker from 'dockerode'
import { existsSync } from 'node:fs'
import { createRegistry } from './latency'
import { DockerArchiveBackend } from './dockerBackend'
import { buildAgent } from './agentRuntime'

function makeDocker(): Docker {
  if (process.env.DOCKER_HOST) return new Docker()
  const colima = `${process.env.HOME ?? ''}/.colima/default/docker.sock`
  if (!existsSync('/var/run/docker.sock') && existsSync(colima)) return new Docker({ socketPath: colima })
  return new Docker()
}

async function main(): Promise<void> {
  const reg = createRegistry()
  const backend = new DockerArchiveBackend(makeDocker(), 'poc724-sbx', reg)
  const agent = buildAgent({ backend, saver: undefined as never, interruptFirstExecute: false })
  const names = new Map<string, number>()
  const samples = new Map<string, string>()
  const stream = await agent.streamEvents(
    { messages: [{ role: 'user', content: '用 ls 看一下 /wiki 目录里有什么，报一下顶层条目数，然后结束。' }] },
    { version: 'v3', recursionLimit: 30 },
  )
  const byMethod = new Map<string, { n: number; sample: string }>()
  for await (const ev of stream) {
    const e = ev as { method?: string; params?: { name?: string; data?: { event?: string } } }
    const m = String(e.method ?? '?')
    const name = e.params?.name ?? ''
    const sub = typeof e.params?.data?.event === 'string' ? `/${e.params.data.event}` : ''
    const key = `${m}:${name}${sub}`
    const cur = byMethod.get(key)
    byMethod.set(key, {
      n: (cur?.n ?? 0) + 1,
      sample: cur?.sample ?? (JSON.stringify(e.params?.data) ?? '').slice(0, 320),
    })
  }
  for (const [k, v] of [...byMethod.entries()].sort()) {
    console.log(`${v.n}\t${k}\n  ${v.sample}`)
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})

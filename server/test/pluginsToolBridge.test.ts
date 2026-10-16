// 插件工具 → LangChain 翻译面（plugins/tools.ts toLangChainTool）错误回喂契约：
// 插件 workflow 图内 throw 一律转译为模型可读错误文本回喂主 agent（#737「Result 永不
// throw」同款——插件面补齐），run 不再因插件失败终局（run.failed(infra) 误分类根除）。
// 两类控制流异常保持穿透：GraphInterrupt（W4 人审挂起）、signal.aborted（run.aborted 联动）。
import { describe, expect, it } from 'vitest'
import { GraphInterrupt } from '@langchain/langgraph'
import { toLangChainTool } from '../src/plugins/tools'
import type { AnyPluginToolDefinition, PluginToolContext } from '../src/plugins/api'
import { z } from 'zod'

const ctxStub = {
  config: {},
  logger: { info: () => {}, warn: () => {} },
} as unknown as PluginToolContext

const defOf = (execute: AnyPluginToolDefinition['execute']): AnyPluginToolDefinition => ({
  name: 'bridge_probe_tool',
  description: 'probe',
  category: 'domain',
  parameters: z.object({}).strict(),
  execute,
})

const invokeProbe = async (
  execute: AnyPluginToolDefinition['execute'],
  runtime?: { signal?: AbortSignal },
): Promise<unknown> => {
  const probe = toLangChainTool(defOf(execute), ctxStub)
  return probe.invoke({}, runtime)
}

describe('toLangChainTool 错误回喂（插件面 #737 补齐）', () => {
  it('execute throw 普通错误 → 转译为错误文本回喂（不穿透）', async () => {
    const out = await invokeProbe(async () => {
      throw new Error('PDF 路径必须在 /lab/uploads/ 前缀下（收到 https://arxiv.org/pdf/2510.04474）')
    })
    expect(out).toBeTruthy()
    const text = String(out)
    expect(text).toContain('PDF 路径必须在 /lab/uploads/ 前缀下')
    expect(text).toContain('Tool call failed')
  })

  it('execute throw 非 Error 值 → String 化回喂', async () => {
    const out = await invokeProbe(async () => {
      throw '裸字符串故障'
    })
    expect(String(out)).toContain('裸字符串故障')
  })

  it('超长错误消息 → 截断回喂（防撑爆模型上下文）', async () => {
    const out = await invokeProbe(async () => {
      throw new Error('x'.repeat(2000))
    })
    expect(String(out).length).toBeLessThan(1200)
  })

  it('GraphInterrupt → 穿透（W4 人审挂起语义不被吞）', async () => {
    await expect(
      invokeProbe(async () => {
        throw new GraphInterrupt()
      }),
    ).rejects.toThrow(GraphInterrupt)
  })

  it('signal.aborted → 穿透（run.aborted 联动不被吞）', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      invokeProbe(
        async () => {
          throw new Error('aborted mid-flight')
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted mid-flight/)
  })
})

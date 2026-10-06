// #788 S3：插件启用集静态过滤（#752 §4.2）+ 漏斗 category 路由（§3）+ projector artifact
// details 通道（R5 双面契约）。
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { definePlugin, type AnyPluginToolDefinition, type PluginManifest } from '../src/plugins/api'
import { createPluginRuntime } from '../src/plugins/surface'
import { contentToText, toLangChainTool } from '../src/plugins/tools'
import { RunProjector } from '../src/runner/runtime/projector'

function tool(name: string, overrides: Partial<AnyPluginToolDefinition> = {}): AnyPluginToolDefinition {
  return {
    name,
    parameters: z.object({ input: z.string().optional() }),
    description: `${name} description`,
    category: 'domain',
    execute: async () => ({ content: [{ type: 'text', text: `${name} ok` }] }),
    ...overrides,
  }
}

function manifest(id: string, tools: AnyPluginToolDefinition[] = [], extras: Partial<PluginManifest> = {}): PluginManifest {
  return definePlugin({ id, name: id, description: `${id} plugin`, version: '1.0.0', tools, ...extras })
}

describe('#788 plugin surface assembly (S3, #752 §4.2)', () => {
  it('filters tools/commands/prompt by the enabled id set; empty set yields empty surface', () => {
    const manifests = [
      manifest('alpha', [tool('alpha_tool')], { commands: [{ name: 'alpha-cmd', handler: async () => ({ inject: 'a' }) }] }),
      manifest('beta', [tool('beta_tool', { promptSnippet: 'use beta for beta things' })]),
    ]
    const runtime = createPluginRuntime({ manifests, config: {} })
    expect(runtime.surface(['alpha']).tools.map((t) => t.name)).toEqual(['alpha_tool'])
    expect(runtime.surface(['alpha']).commands.map((c) => c.command.name)).toEqual(['alpha-cmd'])
    expect(runtime.surface(['alpha']).prompt).toBe('')
    expect(runtime.surface(['beta']).prompt).toContain('beta_tool: use beta for beta things')
    expect(runtime.surface([]).tools).toEqual([])
    expect(runtime.surface(['alpha', 'beta']).enabledIds).toEqual(['alpha', 'beta'])
  })

  it('exposes full-catalog tool specs for funnel routing regardless of enablement', () => {
    const manifests = [manifest('alpha', [tool('f_tool', { category: 'file', pathParams: ['target'] })])]
    const runtime = createPluginRuntime({ manifests, config: {} })
    expect(runtime.toolSpecByName.get('f_tool')).toEqual({ category: 'file', pathParams: ['target'] })
    expect(runtime.surface([]).tools).toEqual([])
  })

  it('catalog version differs across manifest changes and is stable for identical manifests', () => {
    const a = createPluginRuntime({ manifests: [manifest('alpha')], config: {} })
    const b = createPluginRuntime({ manifests: [manifest('alpha')], config: {} })
    const c = createPluginRuntime({ manifests: [manifest('alpha', [], { version: '2.0.0' })], config: {} })
    expect(a.catalogVersion).toBe(b.catalogVersion)
    expect(a.catalogVersion).not.toBe(c.catalogVersion)
  })

  it('throws when the compiled prompt section exceeds 4KB', () => {
    const big = tool('loud_tool', { promptSnippet: 'x'.repeat(5000) })
    expect(() => createPluginRuntime({ manifests: [manifest('alpha', [big])], config: {} })).toThrow('4KB')
  })
})

describe('#788 plugin tool LangChain adapter (S3)', () => {
  it('maps text content blocks to the model face and keeps details out of it (artifact channel)', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] as const,
      details: { figureId: 'f1' },
    }))
    const lc = toLangChainTool(tool('dual', { execute }) as AnyPluginToolDefinition, { config: {}, logger: { info: () => {}, warn: () => {} } })
    const output = await lc.invoke({ input: 'x' })
    const modelFace = JSON.stringify(output)
    expect(modelFace).toContain('hello')
    expect(modelFace).toContain('[image: https://x/y.png]')
    // details 只走 artifact 通道（ToolMessage.artifact），不进模型上下文（R6 双面不变量）
    expect(modelFace).not.toContain('figureId')
    expect(execute).toHaveBeenCalledWith(expect.any(String), { input: 'x' }, expect.objectContaining({ signal: expect.anything(), ctx: expect.anything() }))
  })

  it('image blocks degrade to placeholder lines in the text face', () => {
    expect(contentToText([{ type: 'image_url', image_url: { url: 'u' } }])).toBe('[image: u]')
  })
})

describe('#788 projector artifact details channel (R5)', () => {
  it('prefers ToolMessage artifact over serialized content for tool.end details', () => {
    const projector = new RunProjector()
    projector.feed({ method: 'tools', params: { data: { event: 'tool-started', tool_call_id: 'c1', tool_name: 'dual', input: '{}' } } }, 0)
    const events = projector.feed({
      method: 'tools',
      params: { data: { event: 'tool-finished', tool_call_id: 'c1', output: { kwargs: { name: 'dual', content: 'plain text face', artifact: { render: 'payload' }, status: null } } } },
    }, 10)
    const end = events[0]!.payload as { details?: string }
    expect(JSON.parse(end.details!)).toEqual({ render: 'payload' })
  })

  it('falls back to serialized content when no artifact (core tool behavior unchanged)', () => {
    const projector = new RunProjector()
    projector.feed({ method: 'tools', params: { data: { event: 'tool-started', tool_call_id: 'c2', tool_name: 'read_file', input: '{}' } } }, 0)
    const events = projector.feed({
      method: 'tools',
      params: { data: { event: 'tool-finished', tool_call_id: 'c2', output: { kwargs: { name: 'read_file', content: 'file body' } } } },
    }, 10)
    const end = events[0]!.payload as { details?: string }
    expect(end.details).toBe('file body')
  })
})

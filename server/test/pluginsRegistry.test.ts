// #788 S3：插件目录注册期强校验 fail-fast 全项（#752 §2.2/§2.3/§5）
// 类别必填 / file 类 pathParams / 工具名·命令名全局唯一 / execute 引用合法 / env 完备性。
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { definePlugin, type AnyPluginToolDefinition, type PluginManifest } from '../src/plugins/api'
import { assertPluginEnv, assertValidPluginCatalog } from '../src/plugins/registry'

function tool(overrides: Partial<AnyPluginToolDefinition> & { name: string }): AnyPluginToolDefinition {
  return {
    parameters: z.object({}),
    description: 'demo tool',
    category: 'domain',
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides,
  }
}

const validTool = tool({ name: 'demo_tool' })
const probeManifest = (overrides: Partial<PluginManifest>): PluginManifest =>
  definePlugin({ id: 'demo', name: 'Demo', description: 'demo plugin', version: '1.0.0', ...overrides })

describe('#788 plugin catalog registration-time validation (S3)', () => {
  it('accepts a well-formed catalog and probes execute references', async () => {
    const handler = vi.fn(async () => ({ execute: { tool: 'demo_tool', args: {} } }))
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({ tools: [validTool], commands: [{ name: 'demo-cmd', handler }] })],
      coreToolNames: ['read_file', 'execute'],
      reservedCommandNames: ['new', 'compact', 'model'],
    })).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledWith('', expect.objectContaining({ logger: expect.anything() }))
  })

  it('rejects non-kebab-case and duplicate ids', async () => {
    await expect(assertValidPluginCatalog({ manifests: [probeManifest({ id: 'Demo' })] })).rejects.toThrow('kebab-case')
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({}), probeManifest({ id: 'demo', name: 'Other', description: 'x', version: '2' })],
    })).rejects.toThrow('duplicate')
  })

  it('rejects tools without a declared category (root decision Q11)', async () => {
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({ tools: [{ ...validTool, category: undefined as unknown as 'domain' }] })],
    })).rejects.toThrow('category')
  })

  it('rejects file-category tools without pathParams', async () => {
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({ tools: [tool({ name: 'f', category: 'file' })] })],
    })).rejects.toThrow('pathParams')
  })

  it('rejects tool names colliding with core tools or across plugins', async () => {
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({ tools: [tool({ name: 'read_file' })] })],
      coreToolNames: ['read_file'],
    })).rejects.toThrow('not globally unique')
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({ tools: [tool({ name: 'shared' })] }), probeManifest({ id: 'demo-2', name: 'D2', description: 'x', version: '1', tools: [tool({ name: 'shared' })] })],
    })).rejects.toThrow('not globally unique')
  })

  it('rejects non-zod parameters', async () => {
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({ tools: [tool({ name: 'x', parameters: { not: 'a schema' } as never })] })],
    })).rejects.toThrow('zod schema')
  })

  it('rejects commands colliding with reserved names (system incl. official, R4)', async () => {
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({ commands: [{ name: 'model', handler: async () => ({ inject: 'x' }) }] })],
      reservedCommandNames: ['new', 'compact', 'model'],
    })).rejects.toThrow('reserved or existing')
  })

  it('rejects execute outcomes referencing tools outside the same manifest', async () => {
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({
        tools: [validTool],
        commands: [{ name: 'broken', handler: async () => ({ execute: { tool: 'other_plugin_tool', args: {} } }) }],
      })],
    })).rejects.toThrow('not a tool of the same plugin')
  })

  it('allows handlers whose probe is not reachable and validates nothing statically then', async () => {
    await expect(assertValidPluginCatalog({
      manifests: [probeManifest({
        commands: [{ name: 'strict', handler: async (args: string) => { if (args === '') throw new Error('args required'); return { inject: 'x' } } }],
      })],
    })).resolves.toBeUndefined()
  })

  it('env completeness: production fail-fast on missing required key, dev warns and continues', async () => {
    const manifests = [probeManifest({ configSchema: { env: [{ name: 'DEMO_API_KEY', required: true }, { name: 'DEMO_OPTIONAL', required: false }] } })]
    expect(() => assertPluginEnv(manifests, { env: {}, production: true })).toThrow('DEMO_API_KEY')
    const warn = vi.fn()
    expect(() => assertPluginEnv(manifests, { env: {}, production: false, warn })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEMO_API_KEY'))
    expect(() => assertPluginEnv(manifests, { env: { DEMO_API_KEY: 'k' }, production: true })).not.toThrow()
  })
})

// minimax 默认 provider 三方同源漂移守卫（#775 · 731 §6）：
//   deploy/openclaw.json（模板真值）↔ runner/providerDefaults.ts 常量 ↔
//   scripts/lib/incremental-schema.mjs v9 seed 内联 JSON——任一处漂移即红。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MINIMAX,
  DEFAULT_MINIMAX_MODELS_JSON,
  defaultProviderRowId,
} from '../src/runner/providerDefaults'

const TEMPLATE = path.join(process.cwd(), '..', 'deploy', 'openclaw.json')
const SCRIPT = path.join(process.cwd(), 'scripts', 'lib', 'incremental-schema.mjs')

function templateMinimax(): Record<string, unknown> {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as {
    models?: { providers?: Record<string, Record<string, unknown>> }
  }
  return tpl.models?.providers?.minimax ?? {}
}

describe('minimax 默认 provider 三方同源守卫（#775）', () => {
  it('providerDefaults 常量 ≡ deploy/openclaw.json 模板（baseUrl/api/SecretRef/models 逐字段）', () => {
    const mm = templateMinimax()
    expect(DEFAULT_MINIMAX.baseUrl).toBe(mm.baseUrl)
    // 模板 api: anthropic-messages → lcProvider: anthropic（values.ts 1:1 映射）
    expect(DEFAULT_MINIMAX.lcProvider).toBe('anthropic')
    expect((mm.api as string) === 'anthropic-messages').toBe(true)
    // SecretRef {source:env, id:LLM_API_KEY} → credentialEnvId 退化引用（731 §6）
    const apiKey = mm.apiKey as { source: string; id: string }
    expect(DEFAULT_MINIMAX.credentialEnvId).toBe(apiKey.id)
    expect(apiKey.source).toBe('env')
    expect(DEFAULT_MINIMAX.authHeader).toBe(mm.authHeader)
    // modelsJson ≡ 模板 models 数组（逐字段 JSON 等价）
    expect(JSON.parse(DEFAULT_MINIMAX_MODELS_JSON)).toEqual(mm.models)
  })

  it('迁移脚本 v9 seed 内联 JSON ≡ providerDefaults 常量（重跑不产生语义漂移行）', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    // 脚本内联的 modelsJson（单引号 SQL 字符串字面量）
    expect(script).toContain(`'${DEFAULT_MINIMAX_MODELS_JSON}'`)
    // seed 行核心字段与常量一致
    expect(script).toContain(`'${DEFAULT_MINIMAX.baseUrl}'`)
    expect(script).toContain(`'${DEFAULT_MINIMAX.credentialEnvId}'`)
    // 确定性 seed id 前缀与 TS 侧同构
    expect(script).toContain("'seed-mp-minimax-' || u.\"id\"")
    expect(defaultProviderRowId('u-x')).toBe('seed-mp-minimax-u-x')
  })

  it('白名单 seed 端点 ≡ 模板 baseUrl origin（#803 先例行，731 §3.1）', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    const origin = new URL(DEFAULT_MINIMAX.baseUrl).origin // https://api.minimaxi.com
    expect(script).toContain(`'${new URL(DEFAULT_MINIMAX.baseUrl).hostname}'`)
    expect(origin.startsWith('https://')).toBe(true)
  })
})

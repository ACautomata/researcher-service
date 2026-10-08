// minimax 默认 provider 两方同源漂移守卫（#775 · 731 §6；T0 #801 模板面退役后两方锁定）：
//   runner/providerDefaults.ts 常量（单一来源）↔ scripts/lib/incremental-schema.mjs v9 seed
//   内联 JSON——任一处漂移即红。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MINIMAX,
  DEFAULT_MINIMAX_MODELS_JSON,
  assertLlmApiKey,
  defaultProviderRowId,
} from '../src/runner/providerDefaults'

const SCRIPT = path.join(process.cwd(), 'scripts', 'lib', 'incremental-schema.mjs')

describe('minimax 默认 provider 两方同源守卫（#775）', () => {
  it('常量不变量锚定（baseUrl https + lcProvider anthropic 映射 + env 凭证引用 + modelsJson 合法 JSON）', () => {
    expect(DEFAULT_MINIMAX.baseUrl).toBe('https://api.minimaxi.com/anthropic')
    // 旧模板 api: anthropic-messages → lcProvider: anthropic（values.ts 1:1 映射，语义锚不变）
    expect(DEFAULT_MINIMAX.lcProvider).toBe('anthropic')
    // SecretRef {source:env, id:LLM_API_KEY} → credentialEnvId 退化引用（731 §6）
    expect(DEFAULT_MINIMAX.credentialEnvId).toBe('LLM_API_KEY')
    expect(DEFAULT_MINIMAX.authHeader).toBe(true)
    const models = JSON.parse(DEFAULT_MINIMAX_MODELS_JSON) as Array<Record<string, unknown>>
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('MiniMax-M3')
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

  it('白名单 seed 端点 ≡ 常量 baseUrl origin（#803 先例行，731 §3.1）', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    const origin = new URL(DEFAULT_MINIMAX.baseUrl).origin // https://api.minimaxi.com
    expect(script).toContain(`'${new URL(DEFAULT_MINIMAX.baseUrl).hostname}'`)
    expect(origin.startsWith('https://')).toBe(true)
  })
})

describe('assertLlmApiKey（#747 回归② · 生产 fail-fast）', () => {
  it('生产 + key 缺失（undefined）→ throw（fail-fast，健康门拦截）', () => {
    expect(() => assertLlmApiKey({ env: {}, production: true })).toThrow(/LLM_API_KEY/)
  })

  it('生产 + key 空串 → throw（同缺失——cd.yml 渲染空值行即此形态）', () => {
    expect(() => assertLlmApiKey({ env: { LLM_API_KEY: '' }, production: true })).toThrow(/LLM_API_KEY/)
  })

  it('生产 + key 非空 → 通过', () => {
    expect(() => assertLlmApiKey({ env: { LLM_API_KEY: 'sk-x' }, production: true })).not.toThrow()
  })

  it('dev + key 缺失 → warn 不阻断（AGENTS.md「仅起控制面/登录可跳过」语义）', () => {
    const warns: string[] = []
    expect(() => assertLlmApiKey({ env: {}, production: false, warn: (m) => warns.push(m) })).not.toThrow()
    expect(warns.some((m) => m.includes('LLM_API_KEY'))).toBe(true)
  })

  it('dev + key 非空 → 无 warn', () => {
    const warns: string[] = []
    assertLlmApiKey({ env: { LLM_API_KEY: 'sk-x' }, production: false, warn: (m) => warns.push(m) })
    expect(warns).toEqual([])
  })
})

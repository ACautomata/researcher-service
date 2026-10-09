// seam: chat/toolRender/i18n —— #555 t() 本地 shim(替代官方状态式 I18nManager)单测。
// 文案表 + {count}/{names} 插值;未知名 key 原样回退(防御)。

import { describe, expect, it } from 'vitest'
import { t } from './i18n'

describe('t', () => {
  it('interpolates {count} and {names} params', () => {
    expect(t('chat.toolCards.group.commandsMany', { count: '13' })).toBe('执行 13 条命令')
    expect(t('chat.toolCards.group.namedToolRepeated', { names: 'foo, bar', count: '3' })).toBe(
      '调用 foo, bar ×3',
    )
  })

  it('falls back to the key itself for unknown keys', () => {
    expect(t('no.such.key', { count: '1' })).toBe('no.such.key')
  })

  it('serves the full summary phrase set used by summarizeToolGroup', () => {
    expect(t('chat.toolCards.group.emptyMany', { count: '0' })).toBe('执行 0 次工具调用')
    expect(t('chat.toolCards.group.failedMany', { count: '2' })).toBe('2 次失败')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installSystemTheme } from '@/theme'

describe('installSystemTheme', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark')
    vi.unstubAllGlobals()
  })

  it('applies the initial system preference and follows later changes', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener, removeEventListener })),
    )

    const cleanup = installSystemTheme()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    const listener = addEventListener.mock.calls[0][1] as (event: { matches: boolean }) => void
    listener({ matches: false })
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('change', listener)
  })
})

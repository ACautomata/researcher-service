// seam: scroll —— 对话窗口自动向下滚动（ADR 0009 / #397 / #400 第二半）。
// 范式 B（上滚让位）判定：仅当用户停留在底部（距底 < FOLLOW_THRESHOLD）时自动跟随，
// 上滚离开底部后不抢滚动条，回到底部后恢复跟随。纯函数——宿主在 ChatStream 内部。
// 好测试标准：只测外部行为——给定滚动几何（scrollTop/scrollHeight/clientHeight），
// 判定「跟随 / 不抢」。不测 rAF 节流内部实现细节。
// 几何约定：距底 = scrollHeight - clientHeight - scrollTop。
import { describe, expect, it } from 'vitest'
import { FOLLOW_THRESHOLD, shouldFollowBottom } from '@/chat/scroll'

describe('shouldFollowBottom（范式 B 判定）', () => {
  // scrollHeight=1000、scrollTop=500 时：距底 = 500 - clientHeight
  it('停留底部（距底 < 阈值）→ 跟随', () => {
    expect(shouldFollowBottom(500, 1000, 500 - FOLLOW_THRESHOLD + 1)).toBe(true) // 距底 = 阈值-1
    expect(shouldFollowBottom(500, 1000, 500)).toBe(true) // 距底 = 0（紧贴底部）
  })

  it('距底恰好 = 阈值（包含等于）→ 跟随', () => {
    expect(shouldFollowBottom(500, 1000, 500 - FOLLOW_THRESHOLD)).toBe(true) // 距底 = 阈值
  })

  it('上滚离开底部（距底 > 阈值）→ 不抢', () => {
    expect(shouldFollowBottom(500, 1000, 500 - FOLLOW_THRESHOLD - 1)).toBe(false) // 距底 = 阈值+1
    expect(shouldFollowBottom(400, 1000, 500)).toBe(false) // 距底 100 > 阈值
  })

  it('空内容（无可滚空间）→ 跟随', () => {
    expect(shouldFollowBottom(0, 0, 0)).toBe(true)
  })

  it('内容不足一屏 → 跟随（无滚动余地）', () => {
    expect(shouldFollowBottom(0, 400, 800)).toBe(true)
  })
})

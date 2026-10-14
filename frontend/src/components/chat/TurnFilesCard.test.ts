// #959 轮次产物卡片 T1：朴素卡面组件（视觉定稿归 T4/#962——本票验收以行为正确为准）。
// seam：组件 props-in 渲染面——行 = 路径 + 变更类型徽标；无下载链接（T2 物化回填后补）。

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TurnFilesCard from '@/components/chat/TurnFilesCard.vue'
import type { TurnFileRow } from '@/api/sessions'

const rows: TurnFileRow[] = [
  { path: 'notes/new.md', op: 'created' },
  { path: 'notes/edited.md', op: 'modified' },
  { path: 'notes/gone.md', op: 'deleted' },
]

describe('TurnFilesCard（#959 轮次产物卡片）', () => {
  it('头 = 「本轮产物」+ 弱色计数；逐行 = 变更类型 + 路径', () => {
    const w = mount(TurnFilesCard, { props: { files: rows } })
    expect(w.get('[data-test="turn-files-head"]').text()).toContain('本轮产物')
    expect(w.get('[data-test="turn-files-count"]').text()).toBe('3 个文件')
    const lines = w.findAll('[data-test="turn-file-row"]')
    expect(lines).toHaveLength(3)
    expect(lines[0]!.text()).toContain('新建')
    expect(lines[0]!.text()).toContain('notes/new.md')
    expect(lines[1]!.text()).toContain('修改')
    expect(lines[2]!.text()).toContain('删除')
    // 变更类型可定位（data-op 三值——T4 视觉定稿的样式钩子）
    expect(lines.map((l) => l.attributes('data-op'))).toEqual(['created', 'modified', 'deleted'])
  })

  it('空数组不渲染（v-if 由调用方守门，组件自身兜底不渲染行）', () => {
    const w = mount(TurnFilesCard, { props: { files: [] } })
    expect(w.findAll('[data-test="turn-file-row"]')).toHaveLength(0)
  })
})

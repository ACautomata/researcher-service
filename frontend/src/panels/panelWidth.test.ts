// seam: panelWidth —— 面板宽度持久化纯逻辑（issue #668）。
// 好测试标准：只测外部行为——key 格式、JWT owner 解析、读写往返与坏值兜底；
// Storage 真身注入（jsdom localStorage），不断言内部实现。
import { beforeEach, describe, expect, it } from 'vitest'
import { panelOwner, panelWidthKey, loadPanelWidth, savePanelWidth } from '@/panels/panelWidth'

// 标准 JWT 三段形状（base64url payload）。
function jwt(payload: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${body}.sig`
}

describe('panelOwner（按用户 token 隔离，chat 草稿先例）', () => {
  it('JWT payload.sub 优先', () => {
    expect(panelOwner(jwt({ sub: 'alice', username: 'bob' }))).toBe('alice')
  })

  it('无 sub 回退 username', () => {
    expect(panelOwner(jwt({ username: 'bob' }))).toBe('bob')
  })

  it('malformed token 回退 token 本体（token 间天然隔离）', () => {
    expect(panelOwner('not-a-jwt')).toBe('not-a-jwt')
  })

  it('空 token 回退 signed-out', () => {
    expect(panelOwner('')).toBe('signed-out')
  })

  it('sub 为空串回退 token 本体（先例 draftOwner 用 ??：空串不回退 username）', () => {
    const token = jwt({ sub: '', username: 'bob' })
    expect(panelOwner(token)).toBe(token)
  })
})

describe('panelWidthKey（key 家族 researcher:panel:<owner>:<view>:<panel>:width）', () => {
  it('按「owner + 页面 + 面板」隔离', () => {
    expect(panelWidthKey('alice', 'wiki', 'file-tree')).toBe('researcher:panel:alice:wiki:file-tree:width')
    expect(panelWidthKey('alice', 'wiki', 'file-tree'))
      .not.toBe(panelWidthKey('bob', 'wiki', 'file-tree'))
    expect(panelWidthKey('alice', 'chat', 'file-tree'))
      .not.toBe(panelWidthKey('alice', 'wiki', 'file-tree'))
  })
})

describe('loadPanelWidth / savePanelWidth（Storage 注入）', () => {
  let storage: Storage

  beforeEach(() => {
    storage = globalThis.localStorage
    storage.clear()
  })

  it('写读往返', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    savePanelWidth(storage, key, 400)
    expect(loadPanelWidth(storage, key, 160, 560)).toBe(400)
  })

  it('无值返回 null', () => {
    expect(loadPanelWidth(storage, panelWidthKey('nobody', 'wiki', 'file-tree'), 160, 560)).toBeNull()
  })

  it('storage 缺席（隐私模式）读 null 写不抛', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    expect(() => savePanelWidth(null, key, 400)).not.toThrow()
    expect(loadPanelWidth(null, key, 160, 560)).toBeNull()
  })

  it('坏值（非数）返回 null', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    storage.setItem(key, 'garbage')
    expect(loadPanelWidth(storage, key, 160, 560)).toBeNull()
  })

  it('越界存储值读出时钳制（存储值可能过期或被手改）', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    storage.setItem(key, '9999')
    expect(loadPanelWidth(storage, key, 160, 560)).toBe(560)
    storage.setItem(key, '1')
    expect(loadPanelWidth(storage, key, 160, 560)).toBe(160)
  })
})

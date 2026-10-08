// S3 reader state: read-only navigation, stale response isolation, optional evidence.
// #856：owner 级——store 无容器切换面（reset = 重挂载清残留并重载树）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('@/api/wiki', () => ({ getTree: vi.fn(), readPage: vi.fn(), getClaims: vi.fn() }))
import { getClaims, getTree, readPage } from '@/api/wiki'
import { useWikiStore } from './wiki'
const emptyClaims = { schemaVersion: null, pageVersion: null, drift: null, claims: [] }
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getTree).mockResolvedValue({ groups: [] })
  vi.mocked(getClaims).mockResolvedValue(emptyClaims)
  vi.mocked(readPage).mockImplementation(async (path) => ({ path, title: path, content: path }))
})
describe('wiki reader store', () => {
  it('reads a page and optional claims', async () => {
    const store = useWikiStore()
    await store.reset()
    await store.openPage('a.md')
    expect(store.page?.content).toBe('a.md')
    expect(store.claims).toEqual(emptyClaims)
    expect(store.loading).toBe(false)
  })
  it('does not let an old page overwrite a newer navigation', async () => {
    let finish!: (value: {path: string; title: string; content: string}) => void
    vi.mocked(readPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const store = useWikiStore()
    await store.reset()
    const old = store.openPage('old.md')
    await store.openPage('new.md')
    finish({ path: 'old.md', title: 'Old', content: 'Old' })
    await old
    expect(store.page?.path).toBe('new.md')
    expect(getClaims).not.toHaveBeenCalledWith('old.md')
  })
  it('keeps readable content when claims fail and clears it on reset', async () => {
    vi.mocked(getClaims).mockRejectedValueOnce(new Error('offline'))
    const store = useWikiStore()
    await store.reset()
    await store.openPage('a.md')
    expect(store.page?.path).toBe('a.md')
    expect(store.claimsError).toBe(true)
    await store.reset()
    expect(store.page).toBeNull()
    expect(store.activePath).toBe('')
  })
})

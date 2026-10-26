import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCourseSyncBookmarklet, parseCourseImport } from './courseSync'

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
describe('超星网页课程同步', () => {
  it('只保留课程元数据，兼容已有导出并按课程班级去重', () => {
    const course = { courseId: '123', classId: '456', name: '数学', cookie: 'never-forward', href: 'https://example.com/?secret=private' }
    expect(parseCourseImport(JSON.stringify({ courses: [course, course] }))).toEqual([{ id: '123', classId: '456', name: '数学' }])
    expect(() => parseCourseImport('{bad')).toThrow()
    expect(() => parseCourseImport(JSON.stringify([{ id: '123', name: '数学' }]))).toThrow()
    expect(() => parseCourseImport('x'.repeat(80_001))).toThrow()
  })
  it('同步工具读取可见课程，去除个人签名，经平台 fragment 交付且不访问 Cookie', () => {
    document.body.innerHTML = '<h3><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=123&clazzid=456&cpi=999&enc=private">数学</a></h3><h3><a href="https://example.com">无效</a></h3>'
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList)
    const open = vi.fn().mockReturnValue({ opener: {} })
    const alert = vi.fn()
    const script = decodeURIComponent(buildCourseSyncBookmarklet('https://panel.example').slice('javascript:'.length))
    new Function('document', 'location', 'window', 'alert', script)(document, { hostname: 'mooc2-ans.chaoxing.com', pathname: '/visit/interaction', href: 'https://mooc2-ans.chaoxing.com/visit/interaction' }, { open }, alert)
    expect(alert).not.toHaveBeenCalled()
    const destination = new URL(open.mock.calls[0]![0])
    expect(destination.origin + destination.pathname).toBe('https://panel.example/settings')
    expect(destination.search).toBe('')
    expect(parseCourseImport(decodeURIComponent(destination.hash.slice('#chaoxing-courses='.length)))).toEqual([{ id: '123', classId: '456', name: '数学' }])
    expect(destination.href).not.toContain('private')
    expect(open.mock.results[0]!.value.opener).toBeNull()
  })
  it('非超星页面不读取或发送课程', () => {
    const open = vi.fn()
    const alert = vi.fn()
    new Function('document', 'location', 'window', 'alert', decodeURIComponent(buildCourseSyncBookmarklet('https://panel.example').slice(11)))(document, { hostname: 'elsewhere.example', pathname: '/' }, { open }, alert)
    expect(open).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PublicResourceCard from '../../../plugins/public-resources/components/PublicResourceCard.vue'

describe('public resource tool card', () => {
  it('renders actual safe resource links and partial-result status from persisted tool details', () => {
    const wrapper = mount(PublicResourceCard, { props: {
      input: {}, state: 'done', expanded: true, toolCallId: 'search-1',
      details: JSON.stringify({ partial: true, results: [
        { title: '官方文档', url: 'https://cn.vuejs.org/guide/', kind: 'document', publisher: 'Vue 中文官方文档' },
        { title: '教学视频', url: 'https://www.bilibili.com/video/BV123', kind: 'video' },
        { title: '危险地址', url: 'javascript:alert(1)' },
      ] }),
    } })
    expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['https://cn.vuejs.org/guide/', 'https://www.bilibili.com/video/BV123'])
    expect(wrapper.text()).toContain('部分搜索来源暂不可用')
    expect(wrapper.text()).toContain('哔哩哔哩')
    expect(wrapper.findAll('.resource-type').map(x => x.text())).toEqual(['资料', '视频'])
    expect(wrapper.findAll('.verification-note')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('来源待核验')
    expect(wrapper.text()).not.toContain('热度')
    expect(wrapper.text()).not.toContain('核验')
  })
})

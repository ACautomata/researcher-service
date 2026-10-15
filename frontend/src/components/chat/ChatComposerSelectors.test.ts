// seam: #980 composer 全内嵌舱——选择器面哑测（props-in/emits-out，贴 chatComponents.test.ts 形态）。
// 覆盖：舱体布局（框外零控件/预览条内移第一排/focus-within）、门语义收拢（逐字同义）、
// 模型上拉菜单（紧凑单行/「默认」置顶/backdrop 即关/行 title 注记）、三段滑块（拖拽换档/
// 键盘微调/aria）、四态可视（默认态/none 置灰双 tooltip、thinking-only 注记、就近映射/1:1 注记）。
// 能力与映射注记全走 props（服务端下发），本文件内嵌的模型行仅是 props 桩，非前端映射表。
/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import type { AvailableModelDTO } from '@/api/models'

const MODELS: AvailableModelDTO[] = [
  { providerId: 'minimax', modelId: 'MiniMax-M3', name: 'MiniMax M3', capability: 'thinking-only', effortNote: '仅思考开关——简洁=思考关 · 标准/深思=思考开' },
  { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', capability: 'native', effortNote: '三档就近映射 Anthropic effort 五档' },
  { providerId: 'deepseek', modelId: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', capability: 'native', effortNote: '三档 1:1 直传' },
  { providerId: 'kimi', modelId: 'kimi-k2', name: 'Kimi K2', capability: 'none', effortNote: '该模型无推理强度通道' },
]

const baseProps = {
  modelValue: '',
  matches: [],
  slashOpen: false,
  slashIndex: 0,
  connecting: false,
  streaming: false,
  disconnected: false,
  modelOptions: MODELS,
  effortTier: 1 as const,
}

const OF = (over: Partial<typeof baseProps> & Record<string, unknown> = {}) => ({ ...baseProps, ...over })

describe('#980 全内嵌舱布局', () => {
  it('框外零控件：全部按钮都在舱体内；预览条为舱内第一排（textarea 之上）', () => {
    const w = mount(ChatComposer, {
      props: OF({ pendingAttachments: [{ key: 1, att: { fileName: 'a.png', mimeType: 'image/png', size: 1, blob: new Blob() }, previewUrl: '' }] }),
    })
    const pod = w.get('[data-test="composer-pod"]')
    for (const b of w.findAll('button')) expect(pod.element.contains(b.element)).toBe(true)
    const rows = Array.from(pod.element.children).map((el) => el.getAttribute('data-test'))
    expect(rows[0]).toBe('preview-strip')
    expect(rows.indexOf('preview-strip')).toBeLessThan(rows.indexOf('input'))
    // 舱体本身就是唯一主体：composer 无外置输入行
    expect(w.find('[data-test="composer-row"]').exists()).toBe(false)
  })

  it('focus-within 边框转 primary（源码锁规则，贴 min-width:0 防回归先例）', async () => {
    const src = readFileSync(join(process.cwd(), 'src/components/chat/ChatComposer.vue'), 'utf8')
    const rule = src.match(/\.pod:focus-within\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('border-color: var(--el-color-primary)')
    // 舱体形态钉面：1px 边框 + 12px 圆角；textarea 无边框透明底、min-height 52 / max 180
    expect(src.match(/\.pod\s*\{[^}]*\}/)?.[0]).toContain('border-radius: 12px')
    const ta = src.match(/\.pod textarea\s*\{[^}]*\}/)?.[0] ?? ''
    expect(ta).toContain('min-height: 52px')
    expect(ta).toContain('max-height: 180px')
    expect(ta).toContain('background: transparent')
  })

  it('textarea placeholder 与 combobox aria 与现状逐字保留', () => {
    const w = mount(ChatComposer, { props: OF() })
    const ta = w.get('[data-test="input"]')
    expect(ta.attributes('placeholder')).toBe('发消息…（Enter 发送 / Shift+Enter 换行；输 / 弹命令补全；可粘贴/拖拽/选附件）')
    expect(ta.attributes('role')).toBe('combobox')
    expect(ta.attributes('aria-autocomplete')).toBe('list')
  })
})

describe('#980 门语义（三处内联析取收拢计算属性，逐字同义）', () => {
  const mounts = (over: Record<string, unknown>) =>
    mount(ChatComposer, {
      props: OF({
        pendingAttachments: [{ key: 1, att: { fileName: 'a.txt', mimeType: 'text/plain', size: 1, blob: new Blob() }, previewUrl: '' }],
        ...over,
      }),
    })

  it('发送 = 四门 + rewind/fork busy；📎 与预览移除 = 四门（不含 rewind/fork）', () => {
    const gates = [
      { connecting: true },
      { streaming: true },
      { disconnected: true },
      { attachmentBusy: true },
    ]
    for (const g of gates) {
      const w = mounts(g)
      expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined()
      expect(w.get('[data-test="attach-btn"]').attributes('disabled')).toBeDefined()
      expect(w.get('[data-test="preview-remove"]').attributes('disabled')).toBeDefined()
    }
    // rewind/fork busy 只扩发送门（附件面不受限，与现状逐字一致）
    for (const g of [{ rewindBusy: true }, { forkBusy: true }]) {
      const w = mounts(g)
      expect(w.get('[data-test="send"]').attributes('disabled')).toBeDefined()
      expect(w.get('[data-test="attach-btn"]').attributes('disabled')).toBeUndefined()
      expect(w.get('[data-test="preview-remove"]').attributes('disabled')).toBeUndefined()
    }
    const idle = mounts({})
    expect(idle.get('[data-test="send"]').attributes('disabled')).toBeUndefined()
    expect(idle.get('[data-test="attach-btn"]').attributes('disabled')).toBeUndefined()
  })

  it('chip 不在门内：生成中仍可开菜单（模型选择只影响下一轮）', () => {
    const w = mount(ChatComposer, { props: OF({ streaming: true }) })
    expect(w.get('[data-test="model-chip"]').attributes('disabled')).toBeUndefined()
  })
})

describe('#980 模型上拉菜单', () => {
  it('chip 关闭态显示「默认」；点开：紧凑单行（名 + providerId + ✓）+「默认」置顶 + 行 title 注记', async () => {
    const w = mount(ChatComposer, { props: OF() })
    expect(w.get('[data-test="model-chip"]').text()).toContain('默认')
    expect(w.find('[data-test="model-menu"]').exists()).toBe(false)
    await w.get('[data-test="model-chip"]').trigger('click')
    const items = w.findAll('[data-test="model-item"], [data-test="model-item-default"]')
    expect(items).toHaveLength(5)
    expect(items[0].attributes('data-test')).toBe('model-item-default')
    expect(items[0].text()).toContain('默认')
    expect(items[0].attributes('title')).toContain('/model default')
    expect(items[1].text()).toContain('MiniMax M3')
    expect(items[1].get('.model-id').text()).toBe('minimax')
    expect(items[1].attributes('title')).toBe('仅思考开关——简洁=思考关 · 标准/深思=思考开')
    expect(items[2].text()).toContain('Claude Sonnet 5.5')
    expect(items[2].attributes('title')).toBe('三档就近映射 Anthropic effort 五档')
  })

  it('选中行打勾 + aria-selected；点选上抛 selectModel（选项对象 / 「默认」null）并收起菜单', async () => {
    const selected = { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' }
    const w = mount(ChatComposer, { props: OF({ preferredModel: selected }) })
    expect(w.get('[data-test="model-chip"]').text()).toContain('Claude Sonnet 5.5')
    await w.get('[data-test="model-chip"]').trigger('click')
    const items = w.findAll('[data-test="model-item"], [data-test="model-item-default"]')
    expect(items[2].text()).toContain('✓') // anthropic 行（默认 + minimax + anthropic）
    expect(items[2].attributes('aria-selected')).toBe('true')
    expect(items[0].attributes('aria-selected')).toBe('false')
    await items[3].trigger('click') // deepseek（默认 + minimax + anthropic 之后）
    expect(w.emitted('selectModel')?.[0]).toEqual([MODELS[2]])
    expect(w.find('[data-test="model-menu"]').exists()).toBe(false)
    await w.get('[data-test="model-chip"]').trigger('click')
    await w.get('[data-test="model-item-default"]').trigger('click')
    expect(w.emitted('selectModel')?.[1]).toEqual([null])
  })

  it('透明 backdrop 点击即关；chip 再点收起（toggle 语义）', async () => {
    const w = mount(ChatComposer, { props: OF() })
    await w.get('[data-test="model-chip"]').trigger('click')
    expect(w.find('[data-test="model-menu"]').exists()).toBe(true)
    await w.get('[data-test="model-menu-backdrop"]').trigger('click')
    expect(w.find('[data-test="model-menu"]').exists()).toBe(false)
    await w.get('[data-test="model-chip"]').trigger('click')
    expect(w.find('[data-test="model-menu"]').exists()).toBe(true)
    await w.get('[data-test="model-chip"]').trigger('click')
    expect(w.find('[data-test="model-menu"]').exists()).toBe(false)
  })

  it('悬挂覆盖（清单外，ADR 0019 运行时常态数据）：chip 回退显示 modelId 原文', () => {
    const w = mount(ChatComposer, { props: OF({ preferredModel: { providerId: 'gone', modelId: 'deleted-model' } }) })
    expect(w.get('[data-test="model-chip"]').text()).toContain('deleted-model')
  })
})

describe('#980 推理强度三段滑块', () => {
  const nativeProps = OF({ preferredModel: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' } })

  // jsdom 的 PointerEvent clientX 是只读 getter（test-utils trigger 赋值即抛）——原生派发 +
  // defineProperty 注入坐标（贴 ChatStream 滚动测试的 stub 范式）。
  function firePointer(el: Element, type: string, clientX: number): void {
    const ev = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clientX', { value: clientX })
    Object.defineProperty(ev, 'pointerId', { value: 1 })
    el.dispatchEvent(ev)
  }

  it('role=slider + aria 档位朗读；段即刻度三等分拖过即换档', async () => {
    const w = mount(ChatComposer, { props: { ...nativeProps, effortTier: 1 as const } })
    const segs = w.get('[data-test="effort-segs"]')
    expect(segs.attributes('role')).toBe('slider')
    expect(segs.attributes('aria-valuemin')).toBe('0')
    expect(segs.attributes('aria-valuemax')).toBe('2')
    expect(segs.attributes('aria-valuenow')).toBe('1')
    expect(segs.attributes('aria-valuetext')).toBe('标准')
    segs.element.getBoundingClientRect = () => ({ left: 0, width: 240, top: 0 } as DOMRect)
    firePointer(segs.element, 'pointerdown', 30) // 30/240 → 段 0
    await nextTick()
    expect(w.emitted('setEffort')?.[0]).toEqual([0])
    firePointer(segs.element, 'pointermove', 200) // 拖过即换档 → 段 2
    await nextTick()
    expect(w.emitted('setEffort')?.[1]).toEqual([2])
    firePointer(segs.element, 'pointerup', 200)
    await nextTick()
    firePointer(segs.element, 'pointerdown', 120) // 段 1
    await nextTick()
    expect(w.emitted('setEffort')?.[2]).toEqual([1])
  })

  it('段内焦点 ←/→ 微调（边界夹取 0–2）', async () => {
    const w = mount(ChatComposer, { props: { ...nativeProps, effortTier: 0 as const } })
    const segs = w.get('[data-test="effort-segs"]')
    await segs.trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('setEffort')?.[0]).toEqual([0]) // 下界夹取
    await segs.trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('setEffort')?.[1]).toEqual([1])
    const w2 = mount(ChatComposer, { props: { ...nativeProps, effortTier: 2 as const } })
    await w2.get('[data-test="effort-segs"]').trigger('keydown', { key: 'ArrowRight' })
    expect(w2.emitted('setEffort')?.[0]).toEqual([2]) // 上界夹取
  })

  it('三段文案「简洁/标准/深思」；当前段/已达段/未达段三态 class', () => {
    const w = mount(ChatComposer, { props: { ...nativeProps, effortTier: 1 as const } })
    const segs = w.findAll('.seg')
    expect(segs.map((s) => s.text())).toEqual(['简洁', '标准', '深思'])
    expect(segs[0].classes()).toContain('on')
    expect(segs[0].classes()).not.toContain('cur')
    expect(segs[1].classes()).toEqual(expect.arrayContaining(['on', 'cur']))
    expect(segs[2].classes()).not.toContain('on')
  })
})

describe('#980 四态可视（B4 裁定）', () => {
  it('默认态（覆盖空）：段控件置灰替换「推理强度 · 不可用」+ tooltip「先选模型再调推理强度」', () => {
    const w = mount(ChatComposer, { props: OF() })
    expect(w.get('[data-test="effort-off"]').text()).toBe('推理强度 · 不可用')
    expect(w.get('[data-test="effort-off"]').attributes('title')).toBe('先选模型再调推理强度')
    expect(w.find('[data-test="effort-segs"]').exists()).toBe(false)
  })

  it('kimi（capability none）同形置灰 + tooltip「该模型无推理强度通道」', () => {
    const w = mount(ChatComposer, { props: OF({ preferredModel: { providerId: 'kimi', modelId: 'kimi-k2' } }) })
    expect(w.get('[data-test="effort-off"]').text()).toBe('推理强度 · 不可用')
    expect(w.get('[data-test="effort-off"]').attributes('title')).toBe('该模型无推理强度通道')
    expect(w.find('[data-test="effort-segs"]').exists()).toBe(false)
  })

  it('thinking-only（MiniMax/GLM）：段控件 + warning 小字——标准/深思「标准 · 深思＝开」、简洁「简洁＝思考关」', async () => {
    const pm = { providerId: 'minimax', modelId: 'MiniMax-M3' }
    const w = mount(ChatComposer, { props: OF({ preferredModel: pm, effortTier: 1 as const }) })
    expect(w.find('[data-test="effort-segs"]').exists()).toBe(true)
    expect(w.get('[data-test="effort-note"]').text()).toBe('标准 · 深思＝开')
    await w.setProps({ effortTier: 2 })
    expect(w.get('[data-test="effort-note"]').text()).toBe('标准 · 深思＝开')
    await w.setProps({ effortTier: 0 })
    expect(w.get('[data-test="effort-note"]').text()).toBe('简洁＝思考关')
  })

  it('native 注记走服务端 effortNote（就近映射 / 1:1 各一测，控件 title 承载）', () => {
    const anthropic = mount(ChatComposer, { props: OF({ preferredModel: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' } }) })
    expect(anthropic.get('[data-test="effort"]').attributes('title')).toBe('三档就近映射 Anthropic effort 五档')
    const deepseek = mount(ChatComposer, { props: OF({ preferredModel: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' } }) })
    expect(deepseek.get('[data-test="effort"]').attributes('title')).toBe('三档 1:1 直传')
  })
})

// seam: chat 展示组件哑测（#316 / #340 验收：props-in/emits-out 零逻辑，贴 FileTree 测试形态）。
// 覆盖：ChatSidebar 容器/会话渲染 + emits；ChatComposer 输入 v-model + 发送禁用门 + slash-menu slot；
// ChatMessageItem thinking/tool-line slot 透传 + 光标；ApprovalCard resolve emits + 已解决态。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { newMsg, type ApprovalItem, type Msg } from '@/stores/chat'
import ChatSidebar from '@/components/chat/ChatSidebar.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'
import ApprovalCard from '@/components/chat/ApprovalCard.vue'
import ChatStream from '@/components/chat/ChatStream.vue'

const INSTANCE = {
  name: 'demo',
  port: 19000,
  status: 'running',
  health: 'healthy',
  image: 'i',
  container_id: 'c',
  created_at: '',
  pairing: { status: 'unpaired' },
}
const SESSION = { session_key: 'sk-1', title: '文献综述', updated_at: '' }

describe('ChatSidebar', () => {
  it('渲染容器/会话 + 选中态 + 删除/新建 emits', async () => {
    const w = mount(ChatSidebar, {
      props: {
        instances: [INSTANCE],
        sessions: [SESSION],
        selectedContainer: 'demo',
        selectedSession: '',
      },
    })
    expect(w.text()).toContain('demo')
    expect(w.text()).toContain('文献综述')
    await w.find('[data-test="new-session"]').trigger('click')
    expect(w.emitted('newSession')).toBeTruthy()
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    expect(w.emitted('removeSession')?.[0]).toEqual(['sk-1'])
    await w.find('[data-test="container-demo"]').trigger('click')
    expect(w.emitted('selectContainer')?.[0]).toEqual(['demo'])
  })
})

describe('ChatComposer', () => {
  const baseProps = {
    modelValue: '',
    matches: [],
    slashOpen: false,
    slashIndex: 0,
    connecting: false,
    streaming: false,
    disconnected: false,
  }

  it('v-model 输入 + 发送 emit', async () => {
    const w = mount(ChatComposer, { props: baseProps })
    await w.find('[data-test="input"]').setValue('hello')
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['hello'])
    // 真实输入同时抛 input 事件（父复位菜单态，修复评审发现的死 emit 回归）
    expect(w.emitted('input')).toBeTruthy()
    await w.find('[data-test="send"]').trigger('click')
    expect(w.emitted('send')).toBeTruthy()
  })

  it('连接/流式/断线任一为真 → 发送禁用', () => {
    const mk = (over: Partial<{ connecting: boolean; streaming: boolean; disconnected: boolean }>) =>
      mount(ChatComposer, {
        props: { ...baseProps, ...over },
      })
    expect(mk({ connecting: true }).find('[data-test="send"]').attributes('disabled')).toBeDefined()
    expect(mk({ streaming: true }).find('[data-test="send"]').attributes('disabled')).toBeDefined()
    expect(mk({ disconnected: true }).find('[data-test="send"]').attributes('disabled')).toBeDefined()
    expect(mk({}).find('[data-test="send"]').attributes('disabled')).toBeUndefined()
  })

  it('slash-menu slot：slashOpen 且匹配 → slot 渲染（父注入表现）', async () => {
    const w = mount(ChatComposer, {
      props: {
        ...baseProps,
        modelValue: '/mod',
        matches: [{ alias: '/model', description: '切换模型' }],
        slashOpen: true,
      },
      slots: {
        'slash-menu': `<div data-test="custom-menu">{{ matches[0].alias }}</div>`,
      },
    })
    expect(w.find('[data-test="custom-menu"]').text()).toContain('/model')
  })

  it('slashOpen=false → 菜单不渲染', () => {
    const w = mount(ChatComposer, { props: baseProps })
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
  })
})

describe('ChatMessageItem', () => {
  it('thinking/tool-line slot 透传（默认渲染 ThinkingCard/ToolLine）', async () => {
    const m = newMsg('assistant', '正文')
    m.thinking = '思考内容'
    m.thinkingOpen = false
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: undefined, input: 'ls', result: '' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="cot-card"]').text()).toContain('思考内容')
    expect(w.find('[data-test="tool-line"]').exists()).toBe(true)
    expect(w.text()).toContain('正文')
  })

  it('流式助手消息渲染光标', () => {
    const m = newMsg('assistant', '')
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('.cursor').exists()).toBe(true)
  })
})

// 审批卡测试与 ChatStream 合并时间线测试共用的卡片基底
const card: ApprovalItem = {
  id: 'a1',
  kind: 'exec',
  command: 'rm -rf /tmp/x',
  sessionKey: null,
  status: 'pending',
  decision: '',
  detailOpen: false,
  seq: 0,
}

describe('ApprovalCard', () => {

  it('批准/拒绝 emit + 断线禁用按钮', async () => {
    const w = mount(ApprovalCard, { props: { approval: card, disconnected: false } })
    await w.find('[data-test="approve-a1"]').trigger('click')
    expect(w.emitted('resolve')?.[0]).toEqual([card, 'allow-once'])
    await w.find('[data-test="deny-a1"]').trigger('click')
    expect(w.emitted('resolve')?.[1]).toEqual([card, 'deny'])
    const dw = mount(ApprovalCard, { props: { approval: card, disconnected: true } })
    expect(dw.find('[data-test="approve-a1"]').attributes('disabled')).toBeDefined()
  })

  it('已解决态：按钮消失 + 权威 decision 标签', () => {
    const w = mount(ApprovalCard, {
      props: { approval: { ...card, status: 'resolved', decision: 'allow-once' }, disconnected: false },
    })
    expect(w.find('[data-test="approve-a1"]').exists()).toBe(false)
    expect(w.text()).toContain('已批准')
  })
})

describe('ChatStream 合并时间线渲染（ADR 0009 / #399）', () => {
  // 按渲染顺序提取根元素下可直接寻址的条目 data-test（气泡 data-test 由 msg-item slot 注入）
  const tests: Array<{ name: string; messages: Msg[]; approvals: ApprovalItem[]; expected: string[] }> = [
    {
      name: '已落定回答 + 审批卡 → 卡插在回答之前',
      messages: (() => {
        const m = newMsg('assistant', '回答')
        m.streaming = false
        return [newMsg('user', 'hi'), m]
      })(),
      approvals: [{ ...card, seq: 1 }],
      expected: ['msg', 'approval-a1', 'msg'],
    },
    {
      name: '流式占位 → 审批卡插在占位之前（强制沉底）',
      messages: [newMsg('user', 'hi'), newMsg('assistant')], // 末条 streaming=true
      approvals: [{ ...card, seq: 2 }],
      expected: ['msg', 'approval-a1', 'msg'],
    },
    {
      name: '无 assistant → 审批卡插末尾',
      messages: [newMsg('user', 'hi')],
      approvals: [{ ...card, seq: 1 }],
      expected: ['msg', 'approval-a1'],
    },
    {
      name: '多卡插在同一锚点（最后一条已落定气泡前），卡间按 seq 序',
      messages: (() => {
        const m = newMsg('assistant', '回答一')
        m.streaming = false
        const m2 = newMsg('assistant', '回答二')
        m2.streaming = false
        return [m, m2]
      })(),
      approvals: [
        { ...card, id: 'a2', seq: 2 }, // 故意乱序传入：渲染按 seq 排序
        { ...card, id: 'a1', seq: 1 },
      ],
      expected: ['msg', 'approval-a1', 'approval-a2', 'msg'],
    },
  ]
  for (const t of tests) {
    it(`${t.name}：data-test 序列 ${t.expected.join('→')}`, () => {
      const w = mount(ChatStream, {
        props: {
          messages: t.messages,
          approvals: t.approvals,
          disconnected: false,
          historyHasMore: false,
          historyLoading: false,
        },
        slots: { 'msg-item': `<div data-test="msg"></div>` },
      })
      const seq = w
        .findAll('.stream > *')
        .map((el) => el.attributes('data-test'))
        .filter(Boolean)
      expect(seq).toEqual(t.expected)
    })
  }
})

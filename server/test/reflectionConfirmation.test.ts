// #1081 RF-T05：无工具确认识别器适配（真实消息原文 + 服务端动作快照 → 6 类结构化结果）。
// 只断言可观察的分类结果；授权复核由 reflections 业务口测试覆盖。

import { describe, it, expect } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import { createReflectionConfirmationClassifier } from '../src/runner/reflectionConfirmation'
import { ScriptedChatModel } from './runnerFakes'

const ACTION = {
  displayId: 'disp-1',
  draftId: 'draft-1',
  version: 2,
  bodyHash: 'a'.repeat(64),
  action: 'create',
  title: '工具参数验证遗漏',
  category: 'tool_use',
  evidenceCount: 1,
}

const INPUT = { userText: '好，就按这版保存', previousUserMessages: ['先看看草稿'], action: ACTION }

describe('#1081 确认识别器适配', () => {
  it.each(['confirm', 'reject', 'revise', 'withdraw', 'unrelated', 'ambiguous'] as const)('解析 %s 结构化结果', async (decision) => {
    const model = new ScriptedChatModel([new AIMessage(JSON.stringify({ decision, reason: 'test' }))])
    const classifier = createReflectionConfirmationClassifier(model)
    const result = await classifier(INPUT)
    expect(result.decision).toBe(decision)
    expect(result.reason).toBe('test')
  })

  it('把真实用户原文与服务端动作快照交给模型（不是 run 命令副本）', async () => {
    const model = new ScriptedChatModel([new AIMessage('{"decision":"confirm"}')])
    const classifier = createReflectionConfirmationClassifier(model)
    await classifier(INPUT)
    const sent = JSON.stringify(model.receivedMessages[0])
    expect(sent).toContain('好，就按这版保存')
    expect(sent).toContain('disp-1')
    expect(sent).toContain('draft-1')
    expect(sent).toContain('version')
  })

  it('提示词把当前展示动作（合并/删除/修订等）纳入 confirm 语义，不只限保存草稿', async () => {
    const model = new ScriptedChatModel([new AIMessage('{"decision":"confirm"}')])
    await createReflectionConfirmationClassifier(model)({
      ...INPUT,
      userText: '确认合并上面列出的记录',
      action: { ...ACTION, action: 'merge' },
    })
    const sent = JSON.stringify(model.receivedMessages[0])
    expect(sent).toContain('当前展示的反思动作')
    expect(sent).toContain('确认合并上面列出的记录')
    expect(sent).toContain('merge')
    expect(sent).toContain('不要因为动作名为 delete/merge/revise/replace')
  })

  it('非法输出/未知分类 → ambiguous，不猜测确认', async () => {
    const invalid = new ScriptedChatModel([new AIMessage('我觉得可以')])
    expect((await createReflectionConfirmationClassifier(invalid)(INPUT)).decision).toBe('ambiguous')
    const unknown = new ScriptedChatModel([new AIMessage('{"decision":"approve"}')])
    expect((await createReflectionConfirmationClassifier(unknown)(INPUT)).decision).toBe('ambiguous')
  })
})

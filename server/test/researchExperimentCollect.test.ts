// #912 S2：W4 调用③（collect 结果对账图）invoke 返回值面。覆盖（853 §4.4 调用③ /
// issue #912 AC「collect 按交付物声明对账，报告页含 related_pages frontmatter + 关联页面节」）：
// happy path（spec 读回 + 旁车交付物声明 + 逐件对账 → LLM 报告 → persist 落 wiki——
// related_pages + 关联页面节确定性追加）/ spec 路径白名单与缺失 clarify / 缺件对账进
// summary 不静默 / 旁车缺失 fail（spec 目录被外部改动）/ 幂等哨兵。
import { describe, expect, it } from 'vitest'
import { createExperimentCollectGraph, experimentReportPathOf } from '../../plugins/research/collect'
import { deliverablesPathOf, specPathOf, type SpecSidecar } from '../../plugins/research/experimentPlan'
import {
  createLabFake,
  createSlotLlm,
  createWikiFake,
  validExperimentReport,
  validSpecDoc,
  CRITIC_PATH,
} from './researchFixtures'

const REQUEST = { workflow: 'experiment', question: '验证能量分数判据', source_paths: [CRITIC_PATH] } as const
const SPEC_PATH = specPathOf(REQUEST)

// 调用① happy path 后的 lab 状态（spec + 旁车 + 一件交付物就位一件缺失）。
const postPlanLab = () =>
  createLabFake({
    [SPEC_PATH]: validSpecDoc().content,
    [deliverablesPathOf(REQUEST)]: JSON.stringify({
      deliverables: [
        { path: '/lab/results/ablation.json', success_criterion: '含各组件消融 AUROC 数字' },
        { path: '/lab/results/cross-modal.csv', success_criterion: '每行一个模态的评估结果' },
      ],
      inputPages: [CRITIC_PATH],
    } satisfies SpecSidecar),
    '/lab/results/ablation.json': '{"auroc": {"full": 96.83, "no_reg": 94.10}}',
  })

const makePorts = (lab: ReturnType<typeof createLabFake>, handlers: Parameters<typeof createSlotLlm>[0] = {}) => {
  const llm = createSlotLlm(handlers)
  const wiki = createWikiFake({})
  return { llm, wiki: wiki.wiki, wikiFake: wiki, lab: lab.lab, calls: llm.calls }
}

const collectRequest = { workflow: 'experiment', phase: 'collect', source_paths: [SPEC_PATH] }

describe('W4 调用③ collect 结果对账图（S2 fake ports）', () => {
  it('happy path：对账 1/2 件就位 → 报告页落 wiki——related_pages + 关联页面节 + 机读标签', async () => {
    const ports = makePorts(postPlanLab())
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    const result = await graph.invoke({ request: collectRequest as never })

    expect(result.status).toBe('completed')
    expect(result.artifactPages).toEqual([{ path: experimentReportPathOf(SPEC_PATH), title: '实验报告：验证能量分数判据' }])
    expect(result.summary).toContain('1/2 件就位')
    expect(result.summary).toContain('/lab/results/cross-modal.csv') // 缺件不静默

    // summarize 输入含对账内容（present 件内容进 prompt）。
    const summaryPrompt = ports.calls.find((c) => c.slot === 'report')!.prompt
    expect(summaryPrompt).toContain('已就位：/lab/results/ablation.json')
    expect(summaryPrompt).toContain('缺失：/lab/results/cross-modal.csv')
    expect(summaryPrompt).toContain('96.83')

    // persist：type/provenance/content 组装面。
    const [draft, provenance] = ports.wikiFake.createPage.mock.calls[0] as unknown as [
      { path: string; title: string; type: string; content: string },
      Record<string, unknown>,
    ]
    expect(draft.path).toBe(experimentReportPathOf(SPEC_PATH))
    expect(draft.type).toBe('report')
    expect(draft.content).toContain('`category: experiment-report`')
    expect(draft.content).toContain('## 关联页面')
    expect(draft.content).toContain(`[${CRITIC_PATH}](${CRITIC_PATH})`)
    expect(provenance).toEqual({ workflow: 'experiment', relatedPages: [CRITIC_PATH] })
  })

  it('collect：spec 路径形态白名单 → clarify（非 /lab/specs/<slug>/r<N>/spec.md 拒，文案示例含 round 键控段）', async () => {
    const ports = makePorts(postPlanLab())
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    for (const bad of ['/lab/results/spec.md', '/lab/specs/spec.md', 'lab/specs/ab12/spec.md']) {
      const r = await graph.invoke({ request: { ...collectRequest, source_paths: [bad] } as never })
      expect(r.status).toBe('clarify')
      expect(r.clarify?.question).toContain('collect')
    }
    const clarifyQ = (await graph.invoke({ request: { ...collectRequest, source_paths: ['/lab/specs/spec.md'] } as never })).clarify!
      .question
    expect(clarifyQ).toContain('/r<N>/') // round 键控路径形（P1-3：文案与 SPEC_PATH_RE 同口径）
    expect(ports.calls.filter((c) => c.slot === 'report')).toHaveLength(0)
  })

  it('对账内容截断面：交付物全文超上限 → 对账面存 excerpt（prompt 面上限截断，不全文驻留状态）——fake 全文可读，本用例锁 collect 侧截断面；真 port 16MiB 护栏拒读行为由下用例三态覆盖', async () => {
    const tail = 'END-OF-FULL-CONTENT'
    const big = `${'x'.repeat(5000)}${tail}`
    const lab = createLabFake({
      [SPEC_PATH]: validSpecDoc().content,
      [deliverablesPathOf(REQUEST)]: JSON.stringify({
        deliverables: [{ path: '/lab/results/ablation.json', success_criterion: 'c' }],
        inputPages: [],
      } satisfies SpecSidecar),
      '/lab/results/ablation.json': big,
    })
    const ports = makePorts(lab)
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    await graph.invoke({ request: collectRequest as never })
    const summaryPrompt = ports.calls.find((c) => c.slot === 'report')!.prompt
    expect(summaryPrompt).toContain('x'.repeat(100)) // 头部在
    expect(summaryPrompt).not.toContain(tail) // 全文未驻留（截断面在 collect 侧）
  })

  it('对账四态（R0 review P1-1 + R1 P2-1）：too_large/binary 就位未读取、invalid_path 无法核验、仅 not_found 判缺失', async () => {
    const lab = createLabFake(
      {
        [SPEC_PATH]: validSpecDoc().content,
        [deliverablesPathOf(REQUEST)]: JSON.stringify({
          deliverables: [
            { path: '/lab/results/ablation.json', success_criterion: 'c1' },
            { path: '/lab/results/huge.bin', success_criterion: 'c2' },
            { path: '/lab/results/scan.pdf', success_criterion: 'c3' },
            { path: '/var/log/outside-lab.json', success_criterion: 'c4' },
            { path: '/lab/results/missing.csv', success_criterion: 'c5' },
          ],
          inputPages: [],
        } satisfies SpecSidecar),
        '/lab/results/ablation.json': '{"auroc": 96.83}',
      },
      { '/lab/results/huge.bin': 'too_large', '/lab/results/scan.pdf': 'binary', '/var/log/outside-lab.json': 'invalid_path' },
    )
    const ports = makePorts(lab)
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    const r = await graph.invoke({ request: collectRequest as never })

    expect(r.status).toBe('completed')
    expect(r.summary).toContain('3/5 件就位') // ok + too_large + binary 算就位；invalid_path 不算
    expect(r.summary).toContain('就位但内容未能读取')
    expect(r.summary).toContain('too_large')
    expect(r.summary).toContain('binary')
    expect(r.summary).toContain('无法核验（/var/log/outside-lab.json：invalid_path）')
    expect(r.summary).toContain('不计入就位也不判缺失')
    expect(r.summary).toContain('/lab/results/missing.csv') // 真缺失不静默
    // prompt 面：unread/无法核验件如实标注，既不冒充已就位内容也不算缺失。
    const summaryPrompt = ports.calls.find((c) => c.slot === 'report')!.prompt
    expect(summaryPrompt).toContain('就位但内容未能读取（too_large）：/lab/results/huge.bin')
    expect(summaryPrompt).toContain('就位但内容未能读取（binary）：/lab/results/scan.pdf')
    expect(summaryPrompt).toContain('无法核验（invalid_path）：/var/log/outside-lab.json')
    expect(summaryPrompt).toContain('缺失：/lab/results/missing.csv')
  })

  it('collect 重放：报告页已存在 → 幂等跳过标注（summary 明示未覆盖，R0 review P2-6 与 W1/W2 一致）', async () => {
    const ports = makePorts(postPlanLab())
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    await graph.invoke({ request: collectRequest as never })
    const again = await graph.invoke({ request: collectRequest as never })
    expect(again.status).toBe('completed')
    expect(again.summary).toContain('页面已存在，幂等跳过')
    expect(again.summary).toContain('现有内容未覆盖')
  })

  it('collect：spec 缺失（not_found）→ clarify 提示先完成方案设计审批', async () => {
    const ports = makePorts(createLabFake())
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    const r = await graph.invoke({ request: collectRequest as never })
    expect(r.status).toBe('clarify')
    expect(r.clarify?.question).toContain('spec 不存在')
  })

  it('collect：旁车缺失/坏 JSON → throw（spec 目录被外部改动，不静默对账）', async () => {
    const lab = postPlanLab()
    lab.files.delete(deliverablesPathOf(REQUEST))
    const ports = makePorts(lab)
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    await expect(graph.invoke({ request: collectRequest as never })).rejects.toThrow('旁车缺失')

    const lab2 = postPlanLab()
    lab2.files.set(deliverablesPathOf(REQUEST), '{broken')
    const ports2 = makePorts(lab2)
    const graph2 = createExperimentCollectGraph({ llm: ports2.llm, wiki: ports2.wiki, lab: ports2.lab })
    await expect(graph2.invoke({ request: collectRequest as never })).rejects.toThrow('JSON 解析失败')
  })

  it('collect：旁车 zod 校验（0 信任——执行段沙箱 agent 理论可触旁车路径）：畸形 shape/超件数 → throw 不静默', async () => {
    const malformed = postPlanLab()
    malformed.files.set(deliverablesPathOf(REQUEST), JSON.stringify({ deliverables: 'not-an-array', inputPages: [] }))
    const p1 = makePorts(malformed)
    await expect(
      createExperimentCollectGraph({ llm: p1.llm, wiki: p1.wiki, lab: p1.lab }).invoke({ request: collectRequest as never }),
    ).rejects.toThrow('旁车校验失败')

    const oversized = postPlanLab()
    oversized.files.set(
      deliverablesPathOf(REQUEST),
      JSON.stringify({ deliverables: Array.from({ length: 21 }, (_, i) => ({ path: `/lab/results/${i}.json`, success_criterion: 'c' })), inputPages: [] }),
    )
    const p2 = makePorts(oversized)
    await expect(
      createExperimentCollectGraph({ llm: p2.llm, wiki: p2.wiki, lab: p2.lab }).invoke({ request: collectRequest as never }),
    ).rejects.toThrow('旁车校验失败')
  })

  it('validate：报告 content 首行非「## 实验目标」→ throw（形状档）', async () => {
    const ports = makePorts(postPlanLab(), {
      report: () => validExperimentReport({ content: '# 自己加标题\n\n## 实验目标\n\n正文' }),
    })
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    await expect(graph.invoke({ request: collectRequest as never })).rejects.toThrow('## 实验目标')
  })

  it('空交付物声明：对账 0/0 → 报告仍出（如实记录无交付物）', async () => {
    const lab = createLabFake({
      [SPEC_PATH]: validSpecDoc().content,
      [deliverablesPathOf(REQUEST)]: JSON.stringify({ deliverables: [], inputPages: [] } satisfies SpecSidecar),
    })
    const ports = makePorts(lab)
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    const r = await graph.invoke({ request: collectRequest as never })
    expect(r.status).toBe('completed')
    expect(r.summary).toContain('0/0 件就位')
    const [draft] = ports.wikiFake.createPage.mock.calls[0] as unknown as [{ content: string }, unknown]
    expect(draft.content).not.toContain('## 关联页面') // 输入页集空 → 谱系节省略
  })

  it('stage 序列：collect/summarize/validate/persist/summary', async () => {
    const ports = makePorts(postPlanLab())
    const stages: string[] = []
    const graph = createExperimentCollectGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab })
    await graph.invoke({ request: collectRequest as never }, { onStage: (s) => stages.push(s) })
    expect(stages).toEqual(['collect', 'summarize', 'validate', 'persist', 'summary'])
  })
})

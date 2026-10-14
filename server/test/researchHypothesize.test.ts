// #911 S2：W3 hypothesize 图 invoke 返回值面（Agreements「零新缝」——图 invoke + fake ports）。
// 覆盖（853 §4.3 / issue AC）：happy path（Send[]×5 扇出 → dedup → challenge → validate →
// persist 整批逐页 → artifactPages）/ resolveInputs 存在性回查与形态白名单（clarify 出口）/
// 证据不足 → END+clarify（不生成泛化 idea）/ 单桶 catch 降级不阻断其余桶 + 失败记录进 summary /
// opt-in 桶仅经参数显式追加 + BUCKETS_MAX cap / 跨桶 dedup 合并（保留最长 evidence_chain）/
// challenge rejected 淘汰（理由进 summary）/ validate 规则拒（不写 wiki）/ 无 survived 不写 wiki /
// stage 序列 / challenge prompt 判据边界（S3：笼统不确定性不是反驳）。
import { describe, expect, it } from 'vitest'
import { createHypothesizeGraph, bucketsOfRequest } from '../../plugins/research/hypothesize'
import { createSlotLlm, createWikiFake, paperPageBody, PAPER_PATH, validIdeaCard } from './researchFixtures'
import { PluginLlmStructuredError } from '../src/plugins/api'
import { BUCKETS_FIXED, CHALLENGE_CARDS_MAX } from '../../plugins/research/values'

const BUCKET_OF = /你的机会桶：(\S+)/

// 默认每桶行为：gap 桶产 1 张合法卡，其余桶空卡（轻量 happy path——桶数仍全 5 固定桶）。
const gapOnlyCards = (prompt: string) => ({
  cards: BUCKET_OF.exec(prompt)?.[1] === 'gap' ? [validIdeaCard()] : [],
})

const makePorts = (handlers: { bucket?: (prompt: string) => unknown; challenge?: (prompt: string) => unknown; brief?: () => unknown } = {}) => {
  const llm = createSlotLlm({ bucket: handlers.bucket ?? gapOnlyCards, challenge: handlers.challenge, brief: handlers.brief })
  const fake = createWikiFake({ [PAPER_PATH]: paperPageBody() })
  return { llm, wiki: fake.wiki, calls: llm.calls, fake }
}

const invoke = (ports: ReturnType<typeof makePorts>, request: Record<string, unknown>) =>
  createHypothesizeGraph({ llm: ports.llm, wiki: ports.wiki }).invoke({ request: request as never })

const requestWithPaper = { workflow: 'hypothesize', topic: 'OOD 检测的新假说', source_paths: [PAPER_PATH] }

describe('W3 hypothesize 图 invoke（S2 端口注入 fake）', () => {
  it('happy path：Send[]×5 扇出 → dedup → challenge → validate → persist 整批逐页 → completed + idea-card 页 artifactPages', async () => {
    const ports = makePorts()
    const result = await invoke(ports, requestWithPaper)

    expect(result.status).toBe('completed')
    expect(result.clarify).toBeUndefined()
    expect(result.artifactPages).toEqual([{ path: 'idea-cards/基于能量分数的-ood-判据改进.md', title: '基于能量分数的 OOD 判据改进' }])
    expect(result.summary).toContain('idea-cards/')

    // persist：type/provenance/content/claims 组装面。
    const [draft, provenance] = ports.fake.createPage.mock.calls[0] as unknown as [
      { path: string; title: string; type: string; content: string; claims: { statement: string; evidence: string[] }[] },
      Record<string, unknown>,
    ]
    expect(draft.type).toBe('hypothesis')
    expect(provenance).toEqual({ workflow: 'hypothesize' })
    expect(draft.content.startsWith('# 基于能量分数的 OOD 判据改进')).toBe(true)
    expect(draft.content).toContain('`category: idea`')
    expect(draft.claims).toEqual([
      { statement: '用能量分数替代 softmax 置信度可提升 OOD 检测的 AUROC。', evidence: validIdeaCard().evidence_chain },
    ])
    // Send[] 扇出：5 固定桶各一次 bucket 调用；challenge 逐卡一次；brief 一次（≤35 口径面）。
    expect(ports.calls.filter((c) => c.slot === 'bucket')).toHaveLength(5)
    expect(ports.calls.filter((c) => c.slot === 'challenge')).toHaveLength(1)
    expect(ports.calls.filter((c) => c.slot === 'brief')).toHaveLength(1)
  })

  it('resolveInputs：论文页缺失（not_found 哨兵探）→ clarify 提示先 ingest（产物串联）', async () => {
    const ports = makePorts()
    const result = await invoke(ports, { workflow: 'hypothesize', topic: 't', source_paths: ['papers/missing.md'] })
    expect(result.status).toBe('clarify')
    expect(result.clarify?.candidates).toEqual([])
    expect(result.clarify?.question).toContain('ingest')
    expect(result.clarify?.question).toContain('papers/missing.md')
    expect(ports.calls.filter((c) => c.slot === 'bucket')).toHaveLength(0)
  })

  it('resolveInputs：非 papers/*.md 形态 / 穿越路径 → clarify（前缀白名单）', async () => {
    const ports = makePorts()
    const bad = await invoke(ports, { workflow: 'hypothesize', topic: 't', source_paths: ['/lab/uploads/a.pdf'] })
    expect(bad.status).toBe('clarify')
    expect(bad.clarify?.question).toContain('papers/')
    const traversal = await invoke(ports, { workflow: 'hypothesize', topic: 't', source_paths: ['papers/../../etc/secret.md'] })
    expect(traversal.status).toBe('clarify')
  })

  it('证据不足 → END+clarify：无 source_paths 且检索零命中——brief/bucket 零 LLM 调用（不生成泛化 idea）', async () => {
    const ports = makePorts()
    ports.fake.search.mockResolvedValue({ ok: true, data: { results: [] } })
    const result = await invoke(ports, { workflow: 'hypothesize', topic: '完全没有材料的主题' })

    expect(result.status).toBe('clarify')
    expect(result.clarify?.question).toContain('证据不足')
    expect(ports.calls.filter((c) => c.slot === 'brief')).toHaveLength(0)
    expect(ports.calls.filter((c) => c.slot === 'bucket')).toHaveLength(0)
  })

  it('单桶 catch 降级：structured 失败桶记录 {bucket,error} 不阻断其余桶；失败记录进 summary', async () => {
    const ports = makePorts({
      bucket: (prompt) => {
        const bucket = BUCKET_OF.exec(prompt)?.[1]
        if (bucket === 'contradiction') throw new PluginLlmStructuredError('结构化输出未通过 schema 校验', 'cards: invalid')
        return { cards: bucket === 'gap' ? [validIdeaCard()] : [] }
      },
    })
    const result = await invoke(ports, requestWithPaper)

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('contradiction')
    expect(result.summary).toContain('桶执行失败')
    expect(result.artifactPages).toHaveLength(1)
  })

  it('单桶 abort（非结构化错误）→ 原样抛出出图（不吞 abort）', async () => {
    const controller = new AbortController()
    const ports = makePorts({
      bucket: (prompt) => {
        if (BUCKET_OF.exec(prompt)?.[1] === 'gap') {
          controller.abort()
          throw new Error('aborted')
        }
        return { cards: [] }
      },
    })
    await expect(invoke(ports, requestWithPaper)).rejects.toThrow(/aborted/)
  })

  it('opt-in 桶仅经参数显式追加：buckets:[ablation] → 6 桶扇出；BUCKETS_MAX=8 cap 生效（去重+截断）', async () => {
    const ports = makePorts()
    const result = await invoke(ports, { ...requestWithPaper, buckets: ['ablation'] })
    expect(result.status).toBe('completed')
    const bucketCalls = ports.calls.filter((c) => c.slot === 'bucket')
    expect(bucketCalls).toHaveLength(6)
    expect(bucketCalls.some((c) => BUCKET_OF.exec(c.prompt)?.[1] === 'ablation')).toBe(true)

    // 纯函数面：5 固定 + 去重 opt-in，cap 8；固定桶名传入也不重复扇出（枚举外值被滤）。
    expect(bucketsOfRequest({})).toEqual([...BUCKETS_FIXED])
    expect(bucketsOfRequest({ buckets: ['ablation', 'metric', 'ablation', 'gap'] })).toEqual([
      ...BUCKETS_FIXED,
      'ablation',
      'metric',
    ])
  })

  it('跨桶 dedup：同键卡保留 evidence_chain 更长者，persist 只写 1 页', async () => {    const weak = validIdeaCard({ idea_id: 'weak', evidence_chain: ['短'] })
    const strong = validIdeaCard({
      idea_id: 'strong',
      evidence_chain: ['更长证据链条目一：来自论文 Results 节的完整引用文本', '更长证据链条目二：来自 Limitations 节的完整引用文本'],
    })
    const ports = makePorts({
      bucket: (prompt) => {
        const bucket = BUCKET_OF.exec(prompt)?.[1]
        if (bucket === 'gap') return { cards: [weak] }
        if (bucket === 'transfer') return { cards: [strong] }
        return { cards: [] }
      },
    })
    const result = await invoke(ports, requestWithPaper)

    expect(result.status).toBe('completed')
    expect(ports.calls.filter((c) => c.slot === 'challenge')).toHaveLength(1)
    expect(ports.fake.createPage.mock.calls).toHaveLength(1)
    expect(result.summary).toContain('合并')
  })

  it('CHALLENGE_CARDS_MAX 上界接线（853 §4.3 ≤35 口径面）：8 桶×4 卡=32 → challenge 恰 24 次 + 截断 8 张进 summary', async () => {
    let seq = 0
    const ports = makePorts({
      bucket: () => {
        // 每桶 4 张唯一键卡（schema 宽容上限 5 内）——dedup 后 32 张越上界。
        seq += 1
        const batch = seq
        return {
          cards: [0, 1, 2, 3].map((i) =>
            validIdeaCard({ idea_id: `B${batch}-C${i}`, title: `第 ${batch} 批第 ${i} 号想法`, mechanism: `机制 ${batch}-${i}`, minimum_experiment: `最小实验 ${batch}-${i}：跑基准对比。` }),
          ),
        }
      },
    })
    const result = await invoke(ports, { ...requestWithPaper, buckets: ['ablation', 'metric', 'assumption-challenge'] })

    expect(result.status).toBe('completed')
    expect(ports.calls.filter((c) => c.slot === 'challenge')).toHaveLength(CHALLENGE_CARDS_MAX)
    expect(ports.fake.createPage.mock.calls).toHaveLength(CHALLENGE_CARDS_MAX)
    expect(result.summary).toContain('上界截断 8 张')
  })

  it('challenge rejected → 淘汰不写 wiki，verdict_reason 进 summary（判据边界：笼统不确定性不是反驳——prompt 面锁定）', async () => {
    const ports = makePorts({
      challenge: () => ({ challenge: 'minimum_experiment 不能区分竞争解释', verdict: 'rejected', verdict_reason: '对照实验缺失，无法归因于能量分数。' }),
    })
    const result = await invoke(ports, requestWithPaper)

    expect(result.status).toBe('completed')
    expect(result.artifactPages).toEqual([])
    expect(ports.fake.createPage.mock.calls).toHaveLength(0)
    expect(result.summary).toContain('无幸存')
    expect(result.summary).toContain('无法归因于能量分数')
    // challenge prompt 判据边界（S3）：rejected 判据全集 + 笼统不确定性拒识语义在模板中。
    const challengePrompt = ports.calls.find((c) => c.slot === 'challenge')!.prompt
    expect(challengePrompt).toContain('笼统的不确定性不是反驳')
    expect(challengePrompt).toContain('不能区分竞争解释')
    expect(challengePrompt).toContain(validIdeaCard().title)
  })

  it('validate 规则拒：坏卡（缺 expected_metric_change）不写 wiki，拒因进 summary', async () => {
    const broken = validIdeaCard({ expected_metric_change: undefined })
    const ports = makePorts({ bucket: (prompt) => ({ cards: BUCKET_OF.exec(prompt)?.[1] === 'gap' ? [broken] : [] }) })
    const result = await invoke(ports, requestWithPaper)

    expect(result.status).toBe('completed')
    expect(result.artifactPages).toEqual([])
    expect(ports.fake.createPage.mock.calls).toHaveLength(0)
    expect(result.summary).toContain('expected_metric_change')
  })

  it('challenge 调用失败（结构化错误）→ 该卡记淘汰原因（调用失败如实记录），流程不中断', async () => {
    const ports = makePorts({
      challenge: () => {
        throw new PluginLlmStructuredError('结构化输出未通过 schema 校验', 'verdict: invalid')
      },
    })
    const result = await invoke(ports, requestWithPaper)

    expect(result.status).toBe('completed')
    expect(result.artifactPages).toEqual([])
    expect(result.summary).toContain('challenge 阶段失败')
  })

  it('多卡幸存：persist 整批先生成再逐页写（createPage 按卡序、幂等哨兵语义）', async () => {
    const cardB = validIdeaCard({
      idea_id: 'P01-G2',
      title: '温度缩放的对数适配',
      one_sentence_hypothesis: '对数空间温度搜索比网格搜索更稳。',
      target_problem: '现有方法的温度搜索机制在大规模数据集上不稳定，复现方差显著增大',
      evidence_chain: ['papers/robust-out-of-distribution-detection.md#6 Results'],
    })
    const ports = makePorts({
      bucket: (prompt) => {
        const bucket = BUCKET_OF.exec(prompt)?.[1]
        if (bucket === 'gap') return { cards: [validIdeaCard(), cardB] }
        return { cards: [] }
      },
    })
    const result = await invoke(ports, requestWithPaper)

    expect(result.status).toBe('completed')
    expect(result.artifactPages).toHaveLength(2)
    const paths = ports.fake.createPage.mock.calls.map((c) => (c[0] as { path: string }).path)
    expect(paths).toEqual(['idea-cards/基于能量分数的-ood-判据改进.md', 'idea-cards/温度缩放的对数适配.md'])
  })

  it('幂等跳过标注（R0 review P2-6）：重跑命中已存在页 → summary 明示「幂等跳过未覆盖」（与 W1/W2 一致，旧卡不静默顶替）', async () => {
    const ports = makePorts()
    await invoke(ports, requestWithPaper)
    const again = await invoke(ports, requestWithPaper)
    expect(again.status).toBe('completed')
    expect(again.summary).toContain('页面已存在，幂等跳过')
    expect(again.summary).toContain('现有内容未覆盖')
  })

  it('stage 序列：resolveInputs → contextPack → bucket×5 → dedup → challenge → validate → persist → summary', async () => {
    const ports = makePorts()
    const stages: string[] = []
    await createHypothesizeGraph({ llm: ports.llm, wiki: ports.wiki }).invoke(
      { request: requestWithPaper as never },
      { onStage: (s) => stages.push(s) },
    )
    expect(stages.slice(0, 2)).toEqual(['resolveInputs', 'contextPack'])
    expect(stages.slice(2, 7)).toEqual(['bucket', 'bucket', 'bucket', 'bucket', 'bucket'])
    expect(stages.slice(7)).toEqual(['dedup', 'challenge', 'validate', 'persist', 'summary'])
  })

  it('brief prompt 注入请求文本与证据节选；Bucket prompt 注入全量 Context Pack（不分桶裁）', async () => {
    const ports = makePorts()
    await invoke(ports, requestWithPaper)
    const briefPrompt = ports.calls.find((c) => c.slot === 'brief')!.prompt
    expect(briefPrompt).toContain('OOD 检测的新假说')
    expect(briefPrompt).toContain(PAPER_PATH) // 证据节选注入 brief 生成
    const bucketPrompt = ports.calls.find((c) => c.slot === 'bucket')!.prompt
    expect(bucketPrompt).toContain('Idea Generation Brief') // Brief 恒保全在分发拷贝中
    expect(bucketPrompt).toContain(PAPER_PATH)
    const challengePrompt = ports.calls.find((c) => c.slot === 'challenge')!.prompt
    expect(challengePrompt).toContain(PAPER_PATH)
  })
})

// IntentClassifier 生产封装（853 §1.2 · §3.2#3）：结构化意图分类经核心 generateStructured
//（owner 回退链 + 白名单复验 + **raw 文本通道 JSON 提取 + zod 校验兜底**——#907 落的双保险②）
// 封装；本模块承载双保险① = 分类 prompt 内 JSON 输出约束语句（#866 发现①：MiniMax M3 偶发
// 不发起 tool call，约束语句显著缓解——#866 实测 120 次零失败）。
// 阈值判定（MIN_CONFIDENCE）与 clarify 模板在 clarify.ts/values.ts——本模块只管分类本体。

import { z } from '../../server/src/plugins/autofigureDeps'
import type { PluginLlmPort } from '../../server/src/plugins/api'
import { INTENT_LABELS, type IntentLabel, type IntentVerdict, type WorkflowLabel } from './clarify'

// 意图分类结构化输出 schema（853 §1.2 钉形 + secondaryIntent 最小扩展）：secondaryIntent =
// 模型判定的次可能流程标签——低置信时 clarify Top-2 候选第二名、高置信多意图时尾注信号
//（#850 D17「高置信选首 + 尾注」的最小承载；**非**已否决的多标签 schema 形态，853 §1.3）。
// none 不入 secondaryIntent 枚举——拒识无次选语义。
export const INTENT_SCHEMA = z
  .object({
    label: z.enum(INTENT_LABELS),
    confidence: z.number().min(0).max(1),
    secondaryIntent: z.enum(['ingest', 'discover', 'hypothesize', 'experiment']).optional(),
  })
  .strict()

export type IntentOutput = z.infer<typeof INTENT_SCHEMA>

// 分类 prompt（#866 throwaway prompt.ts 实测载体生产化——节结构：5 标签语义 / 边界规则 /
// confidence 语义 / 多意图与次可能 / JSON 输出约束。#866 评估集 40 条 bad case × 3 轮
// MiniMax M3 实测零失败形态；迭代以 server/scratch/intent-eval 五件为回归锚点复跑）。
export const CLASSIFY_SYSTEM_PROMPT = `你是「科研工作流」入口的意图分类器。把用户输入分类到五个标签之一：

- ingest：知识库深度构建。用户想把论文/文档纳入 wiki 知识库——入库、精读并整理成结构化笔记、存档。
- discover：科学问题可信发现。用户想从一篇已有论文中审稿式地找出问题、弱点、研究缺口，产出可信的候选验证问题。
- hypothesize：科学假说自主生成。用户想获得新的研究想法、研究方向或假说——生成性诉求，可与已有论文或知识库上下文碰撞。
- experiment：实验自主设计与执行。用户想为一个明确的问题或想法设计验证实验，并真实执行拿到结果。
- none：以上都不是——闲聊、泛知识问答、文献检索、面板操作、对已完成结果的追问等。

边界规则：
- 对象是具体一篇已有论文的「找问题/弱点/缺口」→ discover（识别，非生成）。
- 「研究想法/方向/假说」的生成诉求 → hypothesize，哪怕提到论文或知识库。
- 「设计实验/验证/跑起来」且对象已明确 → experiment。
- 「入库/整理/存档/精读成笔记」的写入诉求 → ingest。
- 多意图输入 → 取首个动作的标签为 label。
- 语义重叠或表述模糊时给出低置信度（confidence < 0.6）；只对明确的输入给高置信度。

次可能标签 secondaryIntent（可选）：当输入存在明确的第二可能流程时填写——多意图输入的第二个动作，或低置信时可能性次高的流程标签；没有明确的第二可能则省略。secondaryIntent 只能取 ingest/discover/hypothesize/experiment 之一。

confidence ∈ [0,1] 表示你对该标签的把握。

输出格式约束：无论以何种方式响应，你的输出必须是且仅是一个 JSON 对象，形如
{"label": "ingest|discover|hypothesize|experiment|none 之一", "confidence": 0到1的小数}
（存在次可能时附 "secondaryIntent": "ingest|discover|hypothesize|experiment 之一"）。
禁止输出 JSON 之外的任何文本、解释、前缀或 markdown 代码块围栏。`

// 分类输入 = 结构化请求槽位的文本序列化（853 §11.3 解读点 A 拍板口径）：topic/question 由
// 主 agent 组织填入；数据槽位 source_paths 归 resolveInputs 确定性校验，不进分类面。
export function serializeClassifyInput(request: { readonly topic?: string; readonly question?: string }): string {
  return [request.topic, request.question]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join('\n')
}

// 生产分类器端口：分类文本 → zod 校验产物。RESEARCH_MODEL 面板 pin 非空时经 model 参数
// 传入（generateStructured pin 语义；空 = owner 默认链 primary，853 §3.1）。
export type IntentClassifier = (classificationText: string) => Promise<IntentVerdict>

export function createIntentClassifier(llm: PluginLlmPort, pinnedModel?: string): IntentClassifier {
  return async (classificationText: string): Promise<IntentVerdict> => {
    const output: IntentOutput = await llm.generateStructured({
      schema: INTENT_SCHEMA,
      contents: [classificationText],
      ...(pinnedModel !== undefined && pinnedModel.trim() !== '' ? { model: pinnedModel } : {}),
    })
    return output
  }
}

// IntentLabel/WorkflowLabel 类型再出口（server.ts 消费面；graph 直引 ./clarify 不经此）。
export type { IntentLabel, WorkflowLabel }

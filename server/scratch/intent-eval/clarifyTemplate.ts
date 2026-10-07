// PROTOTYPE (#866 throwaway) — clarify Result 呈现模板草案（#849 D5 契约的文本面）。
// Result 形状：{status:'clarify', candidates:[Top-2], question} 作为工具 content 回喂主 agent，
// 主 agent 据此自然语言反问；candidates 元素 = 流程标签 + 中文名 + 一句适用描述。
// 两形态：
//   1. 低置信（label≠none 且 conf<MIN_CONFIDENCE）：candidates = 置信 Top-2 的【流程】标签。
//   2. none（显式拒识）：candidates = []（D5 退化形态），question 走如实告知文案。
export const WORKFLOW_CATALOG = [
  { label: 'ingest', name: '知识库深度构建', fit: '把论文/文档精读整理入库 wiki' },
  { label: 'discover', name: '科学问题可信发现', fit: '从一篇已有论文审稿式找出问题与研究缺口' },
  { label: 'hypothesize', name: '科学假说自主生成', fit: '生成新的研究想法、方向与假说' },
  { label: 'experiment', name: '实验自主设计与执行', fit: '为明确的问题/想法设计验证实验并真实执行' },
] as const

export const CLARIFY_QUESTION_LOW_CONFIDENCE =
  '用户的请求语义不够明确。请向用户列出以下候选工作流（名称 + 适用场景），请其选择其一或补充说明需求：'

export const CLARIFY_QUESTION_NONE =
  '用户的请求不属于科研工作流工具支持的四个流程（知识库深度构建 / 科学问题可信发现 / 科学假说自主生成 / 实验自主设计与执行）。请如实告知用户这一点，请其改述需求，或直接在对话中回答其问题。'

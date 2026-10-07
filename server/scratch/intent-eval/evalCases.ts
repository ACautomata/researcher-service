// PROTOTYPE (#866 throwaway) — 意图分类器评估集 v1（中文科研场景 bad case 集）。
// 标签集 = #849 D3 五值：ingest | discover | hypothesize | experiment | none。
// 预期标签口径（争议条目在 note 里标注，随 #866 grilling 拍板调整）：
//   - 「精读论文」→ ingest（深度构建 = 读透入库；纯内容问答「讲了什么」→ none）
//   - 「找研究缺口」（对象=具体已有论文）→ discover（审稿视角识别）；「生成方向/想法/假说」→ hypothesize
//   - 「值得验证的问题」→ discover（critic 输出即验证候选问题，#850 W2）
//   - 多意图 → 首个动作（#850「高置信选首个+尾注」）
//   - 文献检索/知识问答/面板操作/续读对话 → none（四流程之外）
export interface EvalCase {
  readonly id: string
  readonly input: string
  readonly expected: 'ingest' | 'discover' | 'hypothesize' | 'experiment' | 'none'
  readonly note?: string
}

export const EVAL_CASES: EvalCase[] = [
  // ---- A. 正例（4 流程 × 5）----
  { id: 'ing-01', input: '把这篇论文上传入库', expected: 'ingest' },
  { id: 'ing-02', input: '帮我把这份 arXiv 论文收进知识库，整理成 wiki 页面', expected: 'ingest' },
  { id: 'ing-03', input: '这篇 PDF 帮我做一份深度笔记存到 wiki 里', expected: 'ingest' },
  { id: 'ing-04', input: '整理一下这篇论文，我要存档到我的知识库', expected: 'ingest' },
  { id: 'ing-05', input: 'ingest 这篇论文', expected: 'ingest' },

  { id: 'dis-01', input: '帮我审一审这篇论文，看看有什么问题', expected: 'discover' },
  { id: 'dis-02', input: '分析一下这篇论文方法部分的薄弱环节', expected: 'discover' },
  { id: 'dis-03', input: '这篇论文的结论站得住脚吗？帮我批判性地看看', expected: 'discover' },
  { id: 'dis-04', input: '对这篇 paper 做一次审稿式分析，找出它的弱点', expected: 'discover' },
  { id: 'dis-05', input: '这篇论文有什么没做透的地方？', expected: 'discover' },

  { id: 'hyp-01', input: '基于我 wiki 里这几篇论文，帮我头脑风暴几个研究方向', expected: 'hypothesize' },
  { id: 'hyp-02', input: '围绕大模型幻觉缓解这个方向，给我生成一些研究想法', expected: 'hypothesize' },
  { id: 'hyp-03', input: '我想找点新的研究题目，帮我发散一下', expected: 'hypothesize' },
  { id: 'hyp-04', input: '针对 critic 发现的这几个问题，提出一些可能的假说', expected: 'hypothesize' },
  { id: 'hyp-05', input: '帮我出一批值得做的研究想法卡片', expected: 'hypothesize' },

  { id: 'exp-01', input: '为这个问题设计一个验证实验并跑起来', expected: 'experiment' },
  { id: 'exp-02', input: '把想法 #3 落成可执行的实验方案，然后执行', expected: 'experiment' },
  { id: 'exp-03', input: '设计一个小实验验证这个猜想是否成立', expected: 'experiment' },
  { id: 'exp-04', input: '写个实验方案，在沙箱里跑一遍看结果', expected: 'experiment' },
  { id: 'exp-05', input: '验证一下这个假说，直接给我实验结果', expected: 'experiment' },

  // ---- B. 跨流程相似 bad case ----
  { id: 'bd-01', input: '帮我精读这篇论文', expected: 'ingest', note: '争议：深度构建语义归 ingest（#866 Q3）' },
  { id: 'bd-02', input: '这篇论文主要讲了什么？', expected: 'none', note: '纯内容问答，无写入/分析产物诉求' },
  { id: 'bd-03', input: '这篇论文留下了哪些研究缺口？', expected: 'discover', note: '审稿视角识别已有论文的 gap' },
  { id: 'bd-04', input: '基于这些研究缺口，帮我生成几个假说', expected: 'hypothesize', note: '生成性诉求' },
  { id: 'bd-05', input: '从这篇论文里找找有什么可以继续做的方向', expected: 'hypothesize', note: '争议：「方向」生成语义（#866 Q3）；discover 可辩' },
  { id: 'bd-06', input: '这个想法靠谱吗？帮我分析论证一下', expected: 'hypothesize', note: '想法层论证，无执行诉求' },
  { id: 'bd-07', input: '设计实验验证这个想法', expected: 'experiment', note: '明确执行诉求，与 bd-06 同词对比' },
  { id: 'bd-08', input: '这个假说值得验证吗？', expected: 'hypothesize', note: '争议：论证语义（#866 Q3）；experiment 可辩' },
  { id: 'bd-09', input: '这些问题哪些是值得验证的？', expected: 'discover', note: 'critic 输出即验证候选问题（#850 W2）' },
  { id: 'bd-10', input: '把这篇论文入库，然后帮我找找它有什么问题', expected: 'ingest', note: '多意图取首个（#850）' },
  { id: 'bd-11', input: '先审这篇论文找出问题，再基于问题给我出几个研究想法', expected: 'discover', note: '多意图取首个' },
  { id: 'bd-12', input: '给我出几个研究想法，挑一个设计实验跑掉', expected: 'hypothesize', note: '多意图取首个' },

  // ---- C. none 拒识边界 ----
  { id: 'non-01', input: '今天天气怎么样', expected: 'none' },
  { id: 'non-02', input: 'Transformer 的注意力机制是怎么工作的？', expected: 'none', note: '泛知识问答' },
  { id: 'non-03', input: '帮我写个 Python 脚本，把这个 CSV 按日期排序', expected: 'none', note: '通用编程' },
  { id: 'non-04', input: '查一下我的知识库里有没有注意力机制相关的论文', expected: 'none', note: '争议：literature-query 检索归 none（#866 Q2）' },
  { id: 'non-05', input: '我的 wiki 里现在有哪些页面？', expected: 'none', note: '面板查询操作' },
  { id: 'non-06', input: '帮我看看我的容器跑得正常吗', expected: 'none', note: '面板操作' },
  { id: 'non-07', input: '刚才那份实验报告的第 3 节是什么意思？', expected: 'none', note: '续读对话，非新流程' },
  { id: 'non-08', input: '谢谢你，做得不错', expected: 'none' },
]

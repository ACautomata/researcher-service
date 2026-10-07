# 意图分类器实测（#866 PROTOTYPE）

- model: `MiniMax-M3` @ https://api.minimaxi.com/anthropic
- cases: 40 · rounds: 3 · temperature: 0 · withStructuredOutput(zod{label,confidence})

| id | 输入 | 预期 | 实际(各轮) | 置信(各轮) | 判定 |
|---|---|---|---|---|---|
| ing-01 | 把这篇论文上传入库 | ingest | ingest/ingest/ingest | 0.95/0.95/0.95 | ✓ |
| ing-02 | 帮我把这份 arXiv 论文收进知识库，整理成 wiki 页面 | ingest | ingest/ingest/ingest | 0.95/0.95/0.95 | ✓ |
| ing-03 | 这篇 PDF 帮我做一份深度笔记存到 wiki 里 | ingest | ingest/ingest/ingest | 0.95/0.97/0.95 | ✓ |
| ing-04 | 整理一下这篇论文，我要存档到我的知识库 | ingest | ingest/ingest/ingest | 0.95/0.96/0.98 | ✓ |
| ing-05 | ingest 这篇论文 | ingest | ingest/ingest/ingest | 0.95/0.95/0.95 | ✓ |
| dis-01 | 帮我审一审这篇论文，看看有什么问题 | discover | discover/discover/discover | 0.92/0.92/0.92 | ✓ |
| dis-02 | 分析一下这篇论文方法部分的薄弱环节 | discover | discover/discover/discover | 0.92/0.92/0.88 | ✓ |
| dis-03 | 这篇论文的结论站得住脚吗？帮我批判性地看看 | discover | discover/discover/discover | 0.92/0.82/0.90 | ✓ |
| dis-04 | 对这篇 paper 做一次审稿式分析，找出它的弱点 | discover | discover/discover/discover | 0.96/0.97/0.92 | ✓ |
| dis-05 | 这篇论文有什么没做透的地方？ | discover | discover/discover/discover | 0.82/0.85/0.82 | ✓ |
| hyp-01 | 基于我 wiki 里这几篇论文，帮我头脑风暴几个研究方向 | hypothesize | hypothesize/hypothesize/hypothesize | 0.85/0.90/0.88 | ✓ |
| hyp-02 | 围绕大模型幻觉缓解这个方向，给我生成一些研究想法 | hypothesize | hypothesize/hypothesize/hypothesize | 0.95/0.92/0.92 | ✓ |
| hyp-03 | 我想找点新的研究题目，帮我发散一下 | hypothesize | hypothesize/hypothesize/hypothesize | 0.95/0.92/0.95 | ✓ |
| hyp-04 | 针对 critic 发现的这几个问题，提出一些可能的假说 | hypothesize | hypothesize/hypothesize/hypothesize | 0.88/0.82/0.82 | ✓ |
| hyp-05 | 帮我出一批值得做的研究想法卡片 | hypothesize | hypothesize/hypothesize/hypothesize | 0.95/0.92/0.88 | ✓ |
| exp-01 | 为这个问题设计一个验证实验并跑起来 | experiment | experiment/experiment/experiment | 0.90/0.92/0.90 | ✓ |
| exp-02 | 把想法 #3 落成可执行的实验方案，然后执行 | experiment | experiment/experiment/experiment | 0.90/0.88/0.95 | ✓ |
| exp-03 | 设计一个小实验验证这个猜想是否成立 | experiment | experiment/experiment/experiment | 0.85/0.92/0.92 | ✓ |
| exp-04 | 写个实验方案，在沙箱里跑一遍看结果 | experiment | experiment/experiment/experiment | 0.85/0.85/0.92 | ✓ |
| exp-05 | 验证一下这个假说，直接给我实验结果 | experiment | experiment/experiment/experiment | 0.82/0.72/0.88 | ✓ |
| bd-01 | 帮我精读这篇论文 | ingest | ingest/ingest/ingest | 0.82/0.85/0.85 | ✓ · 争议：深度构建语义归 ingest（#866 Q3） |
| bd-02 | 这篇论文主要讲了什么？ | none | none/none/none | 0.90/0.90/0.92 | ✓ · 纯内容问答，无写入/分析产物诉求 |
| bd-03 | 这篇论文留下了哪些研究缺口？ | discover | discover/discover/discover | 0.92/0.92/0.90 | ✓ · 审稿视角识别已有论文的 gap |
| bd-04 | 基于这些研究缺口，帮我生成几个假说 | hypothesize | hypothesize/hypothesize/hypothesize | 0.85/0.92/0.95 | ✓ · 生成性诉求 |
| bd-05 | 从这篇论文里找找有什么可以继续做的方向 | hypothesize | hypothesize/hypothesize/discover ⚠不稳定 | 0.78/0.62/0.55 | ✗ · 争议：「方向」生成语义（#866 Q3）；discover 可辩 |
| bd-06 | 这个想法靠谱吗？帮我分析论证一下 | hypothesize | hypothesize/hypothesize/hypothesize | 0.72/0.78/0.72 | ✓ · 想法层论证，无执行诉求 |
| bd-07 | 设计实验验证这个想法 | experiment | none/experiment/experiment ⚠不稳定 | 0.85/0.92/0.72 | ✗ · 明确执行诉求，与 bd-06 同词对比 |
| bd-08 | 这个假说值得验证吗？ | hypothesize | hypothesize/hypothesize/none ⚠不稳定 | 0.62/0.62/0.72 | ✗ · 争议：论证语义（#866 Q3）；experiment 可辩 |
| bd-09 | 这些问题哪些是值得验证的？ | discover | none/none/none | 0.85/0.85/0.85 | ✗ · critic 输出即验证候选问题（#850 W2） |
| bd-10 | 把这篇论文入库，然后帮我找找它有什么问题 | ingest | ingest/ingest/ingest | 0.55/0.65/0.62 | ✓ · 多意图取首个（#850） |
| bd-11 | 先审这篇论文找出问题，再基于问题给我出几个研究想法 | discover | discover/discover/discover | 0.45/0.55/0.62 | ✓ · 多意图取首个 |
| bd-12 | 给我出几个研究想法，挑一个设计实验跑掉 | hypothesize | hypothesize/hypothesize/hypothesize | 0.62/0.55/0.55 | ✓ · 多意图取首个 |
| non-01 | 今天天气怎么样 | none | none/none/none | 0.99/0.99/0.99 | ✓ |
| non-02 | Transformer 的注意力机制是怎么工作的？ | none | none/none/none | 0.95/0.95/0.95 | ✓ · 泛知识问答 |
| non-03 | 帮我写个 Python 脚本，把这个 CSV 按日期排序 | none | none/none/none | 0.92/0.95/0.95 | ✓ · 通用编程 |
| non-04 | 查一下我的知识库里有没有注意力机制相关的论文 | none | none/none/none | 0.90/0.92/0.92 | ✓ · 争议：literature-query 检索归 none（#866 Q2） |
| non-05 | 我的 wiki 里现在有哪些页面？ | none | none/none/none | 0.92/0.95/0.95 | ✓ · 面板查询操作 |
| non-06 | 帮我看看我的容器跑得正常吗 | none | none/none/none | 0.95/0.95/0.95 | ✓ · 面板操作 |
| non-07 | 刚才那份实验报告的第 3 节是什么意思？ | none | none/none/none | 0.82/0.95/0.92 | ✓ · 续读对话，非新流程 |
| non-08 | 谢谢你，做得不错 | none | none/none/none | 0.95/0.95/0.95 | ✓ |

## 混淆统计（末轮）

| 预期→实际 | 数 |
|---|---|
| discover | 7 |
| discover→none | 1 |
| experiment | 6 |
| hypothesize | 8 |
| hypothesize→discover | 1 |
| hypothesize→none | 1 |
| ingest | 7 |
| none | 9 |

## 阈值扫描（none 恒兜底口径，#849 D5）

| τ | 放行 | 放行正确率 | 兜底率 | 坏放行 | 高置信none(≥0.6) |
|---|---|---|---|---|---|
| 0.30 | 29 | 97% | 28% | 1 | 11 |
| 0.35 | 29 | 97% | 28% | 1 | 11 |
| 0.40 | 29 | 97% | 28% | 1 | 11 |
| 0.45 | 29 | 97% | 28% | 1 | 11 |
| 0.50 | 29 | 97% | 28% | 1 | 11 |
| 0.55 | 29 | 97% | 28% | 1 | 11 |
| 0.60 | 27 | 100% | 33% | 0 | 11 |
| 0.65 | 25 | 100% | 38% | 0 | 11 |
| 0.70 | 25 | 100% | 38% | 0 | 11 |
| 0.75 | 23 | 100% | 43% | 0 | 11 |
| 0.80 | 23 | 100% | 43% | 0 | 11 |
| 0.85 | 21 | 100% | 48% | 0 | 11 |
| 0.90 | 16 | 100% | 60% | 0 | 11 |

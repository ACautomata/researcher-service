<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

type Stage = {
  eyebrow: string
  title: string
  prompt: string
  summary: string
  theory: string
  finding: string
  agents: Array<{ name: string; task: string }>
  kind: 'sources' | 'ingest' | 'diagnosis' | 'hypothesis' | 'design' | 'experiment' | 'conclusion'
}

const stages: Stage[] = [
  {
    eyebrow: '01 · LITERATURE REVIEW',
    title: '收集深层视觉网络相关文献',
    prompt: '我的研究方向是图像分类，重点关注深度卷积网络在 ImageNet 和 CIFAR 等基准上的表示能力与训练方法。请先不要设定具体问题或提出新方法，系统收集该方向的重要文献，并整理这些工作的引用关系。',
    summary: '我将这一步限制为文献收集，不做问题分析。首先查询本地 Wiki，随后补充论文元数据与引用关系，并按架构演进、优化方法、快捷连接、视觉任务和评测基准去重归类。共识别 44 篇相关来源，文献年份覆盖 1989–2015；DOI、arXiv 或公开出版信息已逐项核验。下面返回完整文献集的分类索引，暂不提前命名后续可能形成的方法。',
    theory: '统计学习理论通常认为，更大的模型容量可以表达更复杂的函数，但更强的表达能力并不保证优化算法能够找到更优解。',
    finding: '深度带来的表示收益与训练难度正在分离；问题可能发生在优化阶段，而不是模型容量不足。',
    agents: [
      { name: 'wiki_search', task: '优先检索本地 Wiki 中的论文页与已有 claim' },
      { name: 'literature-query', task: '检索主题相关来源并扩展引用关系' },
      { name: 'curate', task: '去重并核验 DOI、arXiv 与出版元数据' },
    ],
    kind: 'sources',
  },
  {
    eyebrow: '02 · PAPER INGEST',
    title: '逐篇阅读并写入 Wiki',
    prompt: '请对这批文献执行 paper-ingest。逐篇读取能够获得的原文，建立结构化论文页并存入 Wiki；区分全文证据与有限证据，缺失信息不要推测。完成后汇报入库数量和质量。',
    summary: '开始执行 paper-ingest。每篇论文先保存不可变原始来源，再提取元数据和正文；随后按 Citation、One-Sentence Contribution、Problem Setting、Method、Experiments、Results、Limitations、Reusable Claims、Connections、Open Questions、Provenance 共 11 节生成论文页。所有持久 claim 均绑定原文位置，未报告的信息明确标注“论文中未明确说明”。44 篇文献已完成结构检查与 provenance lint，并写入 Wiki。',
    theory: '',
    finding: '44 篇文献均已形成可检索、可引用的结构化页面；其中 36 篇达到 full-paper，8 篇因公开全文受限标记为 skimmed，未将低证据内容提升为确定结论。',
    agents: [
      { name: 'paper-ingest', task: '编排每篇论文的来源摄入与页面生成' },
      { name: 'ingest', task: '生成 11 节论文页并建立原文 provenance' },
      { name: 'wiki_lint', task: '检查 frontmatter、引用缺口与重复页面' },
    ],
    kind: 'ingest',
  },
  {
    eyebrow: '03 · PAPER READ',
    title: '精读代表性文献并建立联系',
    prompt: '我想先具体理解其中一篇。请讲讲《Very Deep Convolutional Networks for Large-Scale Image Recognition》主要解决了什么问题、实验是怎么设计的、得出了哪些结论？另外结合 Wiki，说说它和其他几篇关键文献之间有什么联系。',
    summary: '我将基于 Wiki 中的全文页面执行 paper-read，并由 extract 生成 12 节实验深化文档。该工作的核心贡献是使用连续 3×3 卷积系统研究网络深度，将 16–19 层模型推向当时的大规模图像分类前沿。实验支持“深度能够提升表征能力”，但同时暴露出计算量快速增长、训练依赖初始化，以及继续增加深度后收益不稳定等边界。接下来我会把这些发现连接到 AlexNet、GoogLeNet、Batch Normalization 与 Highway Networks。',
    theory: '',
    finding: 'VGG 建立了深度收益的重要证据，但没有解决极深普通网络的优化边界；它与初始化、归一化和跨层信息路径相关工作共同构成后续问题发现的证据链。',
    agents: [
      { name: 'paper-read', task: '读取 VGG 论文页与全文来源' },
      { name: 'extract', task: '生成 §0–§11 实验结果深化提取' },
      { name: 'curate', task: '建立跨论文 Connections 与证据张力' },
    ],
    kind: 'ingest',
  },
  {
    eyebrow: '04 · CROSS-PAPER COMPARISON',
    title: '跨文献比较研究脉络',
    prompt: '请单独做一次跨文献比较。把 AlexNet、VGG、GoogLeNet、Batch Normalization 和 Highway Networks 放在同一张表里，从研究问题、核心机制、网络深度、训练难点、证据和局限性几个维度对齐，指出它们之间一致和矛盾的地方。',
    summary: '我将使用 curate 读取五篇论文的结构化 Wiki 页面，而不是依赖摘要记忆。比较显示：AlexNet 建立大规模深度分类范式；VGG 用规则堆叠证明深度收益；GoogLeNet 更关注计算效率；BatchNorm 直接改善训练稳定性；Highway Networks 则引入门控跨层路径。共同趋势是研究不断增加有效深度，但“表达能力增加”与“普通网络是否仍能被顺利优化”之间仍存在尚未闭合的证据缺口。',
    theory: '',
    finding: '五篇文献共同支持增加有效深度的价值，但对极深普通网络的优化边界给出不同且不完整的解释。',
    agents: [
      { name: 'wiki_get', task: '读取五篇论文页与实验提取文档' },
      { name: 'curate', task: '按统一维度生成跨论文比较表' },
      { name: 'claim audit', task: '标记一致证据、矛盾与未闭合问题' },
    ],
    kind: 'diagnosis',
  },
  {
    eyebrow: '05 · PROBLEM DISCOVERY',
    title: '生成候选研究问题',
    prompt: '请基于已经入库的文献做跨论文比较，找出图像分类方向中尚未解决、证据具体且可以通过实验验证的问题。请给出多个候选，不要替我直接决定；对每个问题说明证据、重要性和最小验证方式。',
    summary: '我从 Wiki 的实验结果、局限性和开放问题中提取出四个候选方向。第一，网络深度增加后计算成本迅速上升；第二，普通网络加深后可能出现训练误差反而升高的异常；第三，大规模分类模型对数据分布变化的鲁棒性不足；第四，不同架构之间的参数量与准确率比较缺少统一控制。其中候选二同时具备明确反常证据、较高重要性和低成本验证条件，但最终选择交给你决定。',
    theory: '过拟合表现为训练集拟合改善而测试集泛化变差；梯度消失则应伴随前层梯度幅值持续衰减。',
    finding: '已形成四个可验证候选问题；系统只提供证据与优先级，不替用户确定最终研究问题。',
    agents: [
      { name: 'wiki_get', task: '读取 extract 产出的 12 节实验提取文档' },
      { name: 'critic', task: '从 claim—机制—证据链生成候选问题' },
      { name: 'curate', task: '按重要性、证据强度与可验证性排序' },
    ],
    kind: 'diagnosis',
  },
  {
    eyebrow: '06 · PROBLEM CARD',
    title: '深入分析 Q2 并生成问题卡',
    prompt: '我选择 Q2。请不要马上提出解决方法，先详细分析“更深的普通网络为什么可能具有更高的训练误差”，排查竞争解释，并按照我们的组织方式给我一张完整的问题卡。',
    summary: '我先把 Q2 限定为一个可验证问题，而不是直接跳到方法。现有证据显示，更深普通网络的训练误差也会升高，因此与典型过拟合模式不符；BatchNorm 和合适初始化能缓解梯度传播问题，却没有完全消除该异常。问题卡将记录观察、证据锚点、竞争解释、影响、适用范围、置信度和最小验证，供下游假说生成直接引用。',
    theory: '',
    finding: 'Q2 已被结构化为证据可追溯的问题卡；当前可以确认异常现象，但其机制仍保持开放。',
    agents: [
      { name: 'critic', task: '分析 Q2 的 claim—机制—证据链' },
      { name: 'evidence grading', task: '区分直接证据、间接观察与未知项' },
      { name: 'ingest', task: '写入标准 Problem Card 并建立下游链接' },
    ],
    kind: 'diagnosis',
  },
  {
    eyebrow: '07 · HYPOTHESIS',
    title: '从直接拟合到残差学习',
    prompt: '现在基于 Q2 问题卡提出几个机制假说。请逐一检查证据、可证伪性和替代解释，反驳薄弱候选，只保留一个最值得进入验证实验的方向。',
    summary: '提出可检验假说：假设若新增层没有必要改变已有表示，它们至少应该能够实现恒等映射。直接用多个非线性层逼近 H(x)=x 并不容易；改为令这些层学习残差 F(x)=H(x)−x，再通过无参数快捷连接恢复 H(x)=F(x)+x，则恒等映射只要求 F(x)趋近于零。该重参数化不增加主要计算量，却可能显著降低深层网络的优化难度。',
    theory: '在函数逼近中，围绕良好初始解学习增量，通常比重新拟合完整目标函数更容易；恒等映射可以作为安全基线。',
    finding: '把目标改写为残差 F(x)=H(x)−x，可令新增层在无贡献时自然收敛到零，并保留原有表示。',
    agents: [
      { name: 'brainstorm', task: '基于 Wiki 证据构造可证伪候选假说' },
      { name: 'ideate', task: '生成 evidence chain 与 minimum experiment' },
      { name: 'main rebuttal', task: '对候选作致命反驳，仅保留 survived card' },
    ],
    kind: 'hypothesis',
  },
  {
    eyebrow: '08 · EXPERIMENT DESIGN',
    title: '设计可证伪的对照实验',
    prompt: '请把保留下来的假说转化为一个最小、可证伪的对照实验。明确自变量、控制变量、主要指标、失败条件和实现要求，确保结果能够区分不同机制解释。',
    summary: '实验采用单变量对照。基线组为 20、32、44、56 层普通卷积网络；实验组保持卷积层数量和通道配置一致，仅加入 identity shortcut。所有模型共享 CIFAR-10 数据划分、标准化与数据增强，使用相同初始化、SGD 动量、权重衰减、学习率日程和训练轮数。主要终点是训练误差是否随深度下降，次要终点是测试误差；这样可以直接区分优化改善与单纯正则化效应。',
    theory: '可证伪实验需要控制混杂变量，只改变待验证机制，并预先定义能够推翻假说的观测结果。',
    finding: '若残差网络的训练误差仍随深度上升，假说将被否定；若训练误差下降，则支持优化机制解释。',
    agents: [
      { name: 'paper-validate', task: '编排 design → spec 验证链路' },
      { name: 'design', task: '定义自变量、控制变量、指标与证伪条件' },
      { name: 'spec', task: '生成最小侵入、配置化的实现任务规格' },
    ],
    kind: 'design',
  },
  {
    eyebrow: '09 · EXPERIMENT',
    title: '核验实验结果与证据强度',
    prompt: '请按照验证设计核验现有实验结果。只使用论文明确报告的数字，区分图形中的定性证据和表格中的精确数据；根据预先定义的证伪条件判断假说，并说明哪些结论仍需要真实复现。',
    summary: '我重新核对原始论文的 CIFAR-10 实验。Figure 6 显示更深普通网络具有更高训练误差和测试误差，但没有给出可安全引用的 Plain-20/56 最终小数，因此不从曲线臆测数值。Table 6 明确报告 ResNet-20、32、44、56、110 的测试误差依次为 8.75%、7.51%、7.17%、6.97%、6.43%。该趋势符合预注册支持条件，但当前演示没有启动真实 GPU 训练，证据应标记为 source-reported，而不是 reproduced。',
    theory: '若某结构主要改善优化，它应首先降低训练误差；若只发挥正则化作用，则可能仅改善测试误差。',
    finding: '原论文证据支持残差参数化改善深层网络优化；当前尚未独立复现，不能把 source-reported 结果升级为 reproduced。',
    agents: [
      { name: 'source audit', task: '核对 Figure 6 与 Table 6 的原始证据' },
      { name: 'extract', task: '区分定性曲线与可引用精确数字' },
      { name: 'audit', task: '按预注册规则判定并限制证据等级' },
    ],
    kind: 'experiment',
  },
  {
    eyebrow: '10 · CONCLUSION',
    title: '形成结论与下一步研究',
    prompt: '请审计完整研究链，检查文献、问题、假说、实验和数字是否一致。若证据通过质量门，请为形成的方法给出清晰定义，并总结适用边界、局限性和下一步验证方向。',
    summary: '审计结果区分三类结论：原论文直接报告的 CIFAR-10 与 ImageNet 结果属于 source-reported/full-paper；跨文献比较、问题卡和候选淘汰属于系统推导；本演示没有实际运行训练，因此没有 reproduced 证据。现有来源支持残差参数化缓解深度退化，但梯度传播、表示复用和隐式正则化的贡献仍未分离。下一步需要按已生成的 spec 真实运行多随机种子实验。',
    theory: '可靠结论需要同时满足机制合理、对照成立、结果可重复，并明确其适用边界。',
    finding: '当前证据支持残差学习解决深度退化，但跨数据规模和跨任务的外部有效性仍需继续验证。',
    agents: [
      { name: 'paper-audit', task: '编排 audit 质量门检查' },
      { name: 'audit', task: '审查结构、证据强度与跨阶段一致性' },
      { name: 'ingest', task: '持久化审计报告、atomic claims 与开放问题' },
    ],
    kind: 'conclusion',
  },
]

const baseMarkdownDetails = [
  `## 文献检索清单\n\n**检索式**：\`image classification AND (deep convolutional network OR optimization OR very deep network)\`  \n**范围**：1989–2015 · 44 篇去重来源\n\n| Ref | 文献 | 年份 | Wiki page | Evidence |\n|---|---|---:|---|---|\n| R01 | ImageNet Classification with Deep Convolutional Neural Networks | 2012 | \`sources/alexnet-2012.md\` | full-paper |\n| R02 | Very Deep Convolutional Networks for Large-Scale Image Recognition | 2014 | \`sources/vgg-2014.md\` | full-paper |\n| R03 | Going Deeper with Convolutions | 2015 | \`sources/googlenet-2015.md\` | full-paper |\n| R04 | Batch Normalization | 2015 | \`sources/batch-normalization-2015.md\` | full-paper |\n| R05 | Delving Deep into Rectifiers | 2015 | \`sources/rectifier-initialization-2015.md\` | full-paper |\n| R06 | Highway Networks | 2015 | \`sources/highway-networks-2015.md\` | full-paper |\n| R07 | Understanding the Difficulty of Training Deep Feedforward Neural Networks | 2010 | \`sources/deep-training-difficulty-2010.md\` | full-paper |\n| R08 | Deep Learning Made Easier by Linear Transformations in Perceptrons | 2012 | \`sources/linear-transformations-2012.md\` | skimmed |\n\n完整的 44 篇清单及引用边保存在 \`reports/image-classification-literature-index.md\`。\n\n> 当前只完成来源收集和元数据核验，不产生研究结论。`,
  `## paper-ingest 处理报告\n\n### 上游输入\n\n- 文献索引：\`reports/image-classification-literature-index.md\`\n- 原始来源：\`raw/sources/<paper-id>.pdf\`\n\n### 逐篇处理记录\n\n| Paper | 原文状态 | 页面结构 | Claims | Lint |\n|---|---|---|---:|---|\n| R01 AlexNet | full text | 11/11 sections | 6 | PASS |\n| R02 VGG | full text | 11/11 sections | 8 | PASS |\n| R04 BatchNorm | full text | 11/11 sections | 5 | PASS |\n| R06 Highway Networks | full text | 11/11 sections | 4 | PASS |\n| R08 Linear Transformations | partial text | 11/11 sections | 2 | PASS · limited |\n\n### 批次结果\n\n- **44** 个结构化论文页\n- **36** 个 \`full-paper\`，**8** 个 \`skimmed\`\n- **0** 个阻塞性 provenance 缺口\n- 未提供信息统一标记为“论文中未明确说明”\n\n下游将从这些 Wiki 页面读取证据，不依赖当前对话记忆。`,
  `# VGG：实验结果深化提取\n\n\`category: reading-note\` · \`evidence_level: full-paper\`\n\n## 0. 文档定位\n\n- 论文页：\`sources/vgg-2014.md\`\n- 深化产出：\`reports/vgg-2014-experiment-extract.md\`\n- 任务：ImageNet 图像分类与定位\n\n## 1. 核心结论\n\nVGG 用统一的 3×3 卷积设计系统隔离“深度”变量，证明把网络扩展到 16–19 个权重层可以改善图像分类表征。\n\n## 2. 实验设置总览\n\n| 项目 | 提取结果 |\n|---|---|\n| 数据集 | ILSVRC-2012，约 120 万训练图像、1000 类 |\n| 深度 | 11、13、16、19 个权重层 |\n| 主要指标 | top-1 / top-5 classification error |\n| 结构控制 | 以堆叠 3×3 卷积为主，逐阶段增加通道 |\n| 训练细节 | SGD、dropout、多尺度训练；部分配置继承浅层初始化 |\n\n## 3. 主结果与模式\n\n- 从较浅配置增加到 16 层时，分类表现持续改善。\n- 19 层相对 16 层的收益已经缩小，说明深度收益并非无限线性增长。\n- 多尺度评估进一步改善结果，但它与纯深度收益需要分开解释。\n\n## 4. 证据充分性\n\n> **论文报告：** 深度增加与性能改善在多个配置中一致出现。  
> **间接观察：** 更深模型需要更谨慎的初始化与训练策略。  
> **论文中未明确说明：** 超过 19 层的普通网络为何难以继续获益。\n\n## 5. Connections\n\n- **→ AlexNet（R01）**：继承大规模 CNN 范式，但用更小卷积核和更深堆叠推进表征能力。\n- **↔ GoogLeNet（R03）**：两者都提升 ImageNet 性能；VGG 选择规则堆叠，GoogLeNet 强调多分支与计算效率。\n- **→ He Initialization（R05）**：VGG 暴露的深层训练敏感性，为更适合 ReLU 的初始化研究提供动机。\n- **→ BatchNorm（R04）**：归一化缓解深层网络训练稳定性，但尚未回答任意增加深度是否必然更好。\n- **↔ Highway Networks（R06）**：后者通过门控跨层路径训练更深模型，提示纯堆叠结构可能存在优化瓶颈。\n\n## 6. 对问题发现最有价值的信息\n\n1. 深度是有效变量，但收益在 16–19 层附近开始减弱。\n2. 普通堆叠网络需要额外训练技巧才能稳定优化。\n3. 文献尚未解释：更深网络拥有包含浅层解的函数空间，为何训练结果仍可能更差。`,
  `## 候选研究问题\n\n| ID | 候选问题 | Evidence anchors | 重要性 | 验证成本 |\n|---|---|---|---|---|\n| Q1 | 深度带来的精度收益是否抵消计算成本？ | R02 §Experiments；R03 Table 1 | medium | 中 |\n| Q2 | 为什么更深的普通网络可能具有更高的训练误差？ | R02 §Limitations；\`reports/depth-comparison.md\` | **high** | **低** |\n| Q3 | 分类模型对分布变化是否稳定？ | R01 §Limitations；R03 §Open Questions | medium | 高 |\n| Q4 | 如何区分架构收益与参数量收益？ | R02/R03 comparison page | medium | 中 |\n\n### Q2 的最小验证\n\n固定 CIFAR-10 数据、优化器和通道配置，只改变普通网络深度；同时观察训练误差与测试误差。若只是过拟合，深层模型训练误差应更低。\n\n### 决策门\n\n> 推荐优先验证 Q2，但系统不会自动进入下一阶段。等待研究者选择 Q1–Q4。`,
  `## 被选问题\n\n**Q2：为什么普通卷积网络加深后，训练误差反而可能升高？**\n\n## Survived Hypothesis\n\n> **Claim:** 若新增层改为学习残差 $F(x)=H(x)-x$，并通过无参数恒等路径输出 $H(x)=F(x)+x$，更深网络将更容易得到不差于浅层网络的训练解。\n>\n> **Evidence:** 深层普通网络训练误差更高；Highway Networks 表明跨层信息路径有助于极深网络训练。\n>\n> **Source:** \`reports/depth-comparison.md#training-error\`；\`sources/highway-networks-2015.md#method\`。\n>\n> **Scope:** CIFAR-10，同宽度 20–56 层卷积分类网络。\n>\n> **Confidence:** medium；机制合理但尚未经过直接对照。\n>\n> **Tensions:** 改善可能来自梯度传播、表示复用或隐式正则化，当前证据不能区分。\n\n**证伪条件**：相同训练协议下，加入恒等路径后深层网络的训练误差仍随深度上升。`,
  `## 验证实验设计\n\n### 上游依赖\n\n- 问题分析：\`reports/depth-degradation-critic.md\`\n- 假说卡：\`concepts/identity-residual-hypothesis.md\`\n\n| 项目 | 预注册设计 |\n|---|---|\n| 自变量 | 普通堆叠 / 恒等快捷连接 |\n| 深度 | 20、32、44、56 层 |\n| 控制变量 | CIFAR-10 split、通道数、初始化、SGD、LR schedule、epoch |\n| 主要终点 | 最终训练误差及收敛速度 |\n| 次要终点 | 测试误差 |\n| 支持假说 | 56 层实验组训练误差低于 20 层实验组 |\n| 推翻假说 | 实验组仍呈现随深度增加的训练退化 |\n\n\`\`\`python\n# 唯一结构差异\nidentity = x\nout = conv2(relu(conv1(x)))\nout = relu(out + identity)\n\`\`\`\n\n实现规格已写入 \`reports/depth-validation-spec.md\`，包含配置开关、runner、日志与结果保存格式。`,
  `## Evidence Audit\n\n原论文 Figure 6 定性显示更深普通网络具有更高训练误差和测试误差；曲线未提供可安全引用的最终小数。Table 6 明确报告 ResNet-20/32/44/56/110 的 CIFAR-10 测试误差为 8.75%/7.51%/7.17%/6.97%/6.43%。\n\n**证据等级：source-reported/full-paper**。本演示未运行 GPU 训练，不标记为 reproduced。`,
  `## 审计后的结论\n\n- **来源直接支持**：残差参数化缓解深层网络的优化退化。\n- **系统推导**：恒等路径提供了可退化为浅层解的结构先验。\n- **尚未复现**：本演示未执行独立训练。\n\n完整审计：[Wiki / 深层视觉网络的优化与架构设计](/resnet-demo/wiki)。`,
]

const comparisonMarkdown = `## 跨文献对齐

| 文献 | 主要问题 | 核心机制 | 深度/规模 | 训练难点 |
|---|---|---|---|---|
| AlexNet | 大规模图像分类 | GPU CNN + ReLU | 8 层 | 过拟合与计算 |
| VGG | 深度是否提升表征 | 规则 3×3 堆叠 | 11–19 层 | 初始化敏感、成本高 |
| GoogLeNet | 精度与效率平衡 | Inception 多分支 | 22 层 | 架构复杂 |
| BatchNorm | 稳定深层训练 | 激活归一化 | 多架构 | 统计漂移 |
| Highway Networks | 训练极深网络 | 门控跨层路径 | 100+ 层 | 门控优化 |

## 一致证据

1. 增加有效深度通常能够提升图像分类表示。
2. 深度增加同时提高优化难度和计算成本。
3. 初始化、归一化和跨层信息路径都能改善训练，但作用机制不同。

## Tensions

- VGG 支持规则堆叠的深度收益；Highway Networks 暗示极深网络需要显式跨层路径。
- BatchNorm 缓解训练不稳定，但没有证明普通网络可以无限加深而不退化。
- GoogLeNet 的精度包含多分支结构收益，不能直接归因于深度。

## 未闭合证据链

> 更深网络在函数空间中应至少能够复现浅层网络的解，但现有工作没有解释为什么实际训练可能得到更差结果。

比较产出：\`comparisons/deep-image-classification-architectures.md\`。`

const problemCardMarkdown = `# Problem Card: Q2 深层普通网络的训练退化

\`category: critic\` · \`status: selected\` · \`claim_id: Q2-DEG-01\`

## Precise Research Question

在 CIFAR-10 上，当网络采用相同的 3×3 卷积块、BatchNorm、ReLU、He 初始化与 SGD 协议时，为什么把 plain CNN 从 20 层扩展到 56 层，反而提高训练误差？需要区分数值传播、优化参数化与有效路径长度三类机制。

## Observed Evidence

- **嵌套解论证**：若新增卷积块能实现恒等映射，56 层模型至少可以嵌入 20 层模型的已知解，故其全局最优经验风险不应更差。
- **训练侧异常**：原论文 Figure 6 中 Plain-56 的训练误差高于 Plain-20；异常发生在训练集，不能用泛化间隙解释。
- **经典解释不足**：网络已经采用 ReLU、BatchNorm 与适配 ReLU 的初始化，不符合 sigmoid/tanh 饱和造成的传统退化叙事。
- **机制未知**：障碍可能来自深层复合映射的条件数、Jacobian 奇异值漂移，或优化器难以将新增块推向恒等映射附近。

## Why This Is Surprising

设浅层模型为 $f_{20}(x)$。更深模型若令新增的 18 个双卷积块满足 $G_i(z)=z$，即可构造 $f_{56}(x)=f_{20}(x)$。因此，更深假设类包含与浅层模型等价的可行点。训练误差升高并非表达能力不足，而是标准参数化下“实现恒等映射”不是优化器容易到达的参数状态。问题由此收缩为：**能否改变参数化，使恒等解对应于低复杂度、易到达的状态？**

## Evidence Anchors

| Claim | Source | Evidence level | Limitation |
|---|---|---|---|
| Plain-56 训练曲线劣于 Plain-20 | [原论文 Figure 6](https://openaccess.thecvf.com/content_cvpr_2016/papers/He_Deep_Residual_Learning_CVPR_2016_paper.pdf) | full-paper / qualitative | 不读取曲线端点小数 |
| BN 改善深层优化稳定性 | [Batch Normalization](https://arxiv.org/abs/1502.03167) | full-paper / indirect | 不保证恒等映射可达 |
| 门控跨层路径可训练 100+ 层网络 | [Highway Networks](https://arxiv.org/abs/1505.00387) | full-paper / indirect | gate 引入额外参数 |

## Competing Explanations and Tests

1. **H-overfit：泛化过拟合**——若成立，只应扩大 train–test gap；无法解释训练误差上升，排除。
2. **H-scale：信号尺度失控**——记录每块激活方差与 $‖∂ L/∂ x_l‖_2$；若 BN 后统计稳定而退化持续，则不足以解释。
3. **H-budget：优化预算不足**——延长训练并做等收敛对照；若损失差距持续，则否决“只是收敛更慢”。
4. **H-parameterization：恒等映射难优化**——若无参数 identity shortcut 同时恢复训练损失的深度单调性，则获得直接支持。
5. **H-effective-depth：有效路径过长**——通过改变 shortcut 间隔而保持参数量近似不变进行消融。

## Minimum Discriminative Experiment

训练 Plain-{20,32,44,56} 与 Identity-shortcut-{20,32,44,56}。主要终点为最后 10 epoch 平均训练交叉熵；辅助终点为训练错误率、达到 10% 训练错误率所需 epoch、逐块梯度范数与 $‖F_l(x_l)‖_2/‖x_l‖_2$。若 shortcut 只改善测试误差而不改善训练目标，则“优化参数化”假说不获支持。

## Controls and Validity

匹配 stem、通道增长位置、初始化、样本顺序、学习率日程与训练预算；同维块只用无参数 identity shortcut，投影 shortcut 单独报告；至少 5 个随机种子并报告 mean ± std。结论范围限于 CIFAR-10 basic block，不直接外推至 ImageNet bottleneck。

问题卡：[\`reports/q2-depth-degradation-problem-card.md\`](/resnet-demo/wiki)。`

const enhancedHypothesisMarkdown = `## 候选机制与判别性预测

| Candidate | 精确机制 | 可观测预测 | 判别实验 | Verdict |
|---|---|---|---|---|
| H1 信号尺度失控 | 深度使层间 Jacobian 奇异值连乘偏离 1 | 梯度范数随层号指数衰减或放大 | 记录 activation/gradient norm；BN 后稳定而退化仍在则否决 | rejected as sufficient cause |
| H2 优化预算不足 | 56 层仅比 20 层收敛慢 | 延长训练或调 LR 后最终损失追平 | 等算力与等收敛双协议；差距持续则否决 | rejected as sole cause |
| H3 门控捷径 | 学习门 $T(x)$ 动态选择变换或直通 | gate 偏向 carry 时极深网络可训练 | 与无参数 shortcut 做参数量匹配 | retained control |
| H4 残差参数化 | 写成 $y=x+F(x;W)$，恒等解对应 $F=0$ | 深度增加时训练损失不再恶化，早期残差幅度较小 | 同深度 plain/residual 配对并测残差范数 | **primary survived** |

## Primary Hypothesis H4

> 对采用相同 stem、通道数与训练协议的 CIFAR-10 网络，参数化为 $x_{l+1}=x_l+F_l(x_l;W_l)$ 将使 56 层模型最后 10 epoch 的平均训练交叉熵不高于 20 层模型；plain 参数化不满足这一单调性。同维 shortcut 不含可学习参数，且 $F_l=0$ 即为精确恒等映射。

## Mechanistic Readouts

- 残差相对幅度：$r_l=‖F_l(x_l)‖_2/‖x_l‖_2$。
- 反向信号：$g_l=‖∂ L/∂ x_l‖_2$。
- 优化速度：达到固定训练损失阈值所需 epoch 与累计 FLOPs。
- 若训练改善但 $g_l$ 不变，不能归因于梯度传播；若仅测试误差改善，则更像正则化而非优化效应。

## Evidence Chain

[VGG](https://arxiv.org/abs/1409.1556) 提供深度收益背景；[Highway Networks](https://arxiv.org/abs/1505.00387) 提供跨层路径先例；[Q2 Problem Card](/resnet-demo/wiki) 给出嵌套解反常。三者只构成机制动机，不替代直接对照实验。

**预注册证伪条件：** 至少 5 个随机种子下，Residual-56 的最终训练交叉熵显著高于 Residual-20，或相对 Plain-56 的改善只出现在测试集而不出现在训练集。`

const specializedCandidateQuestionsMarkdown = `## 候选研究问题：从证据缺口到可测变量

| ID | 可操作化问题 | 关键观测量 | 排除性对照 | 优先级 |
|---|---|---|---|---|
| Q1 | 在固定感受野增长与通道预算下，16→19 层的收益来自有效深度还是参数量？ | top-1 error、参数量匹配后的 Δerror | 加宽浅层网络匹配参数/FLOPs | medium |
| Q2 | 使用 BN 与 He 初始化后，Plain-56 为何仍比 Plain-20 具有更高训练误差？ | train CE、逐块梯度范数、Jacobian 谱代理 | 同配置 identity shortcut | **highest** |
| Q3 | 跨层路径的收益来自无参数恒等通路，还是额外门控容量？ | 收敛速度、carry gate 分布、参数匹配误差 | identity / gated / projection 三臂消融 | high |
| Q4 | 深层网络的性能上限由优化失败还是表示饱和主导？ | linear probe、CKA、训练损失随深度变化 | 固定训练损失比较表示质量 | medium |

## Selection Rationale

Q2 同时满足三项条件：已有反常观测、最小实验可隔离自变量、结果能推翻明确机制。其核心不是“深度有没有用”，而是**为何更大的嵌套假设类在经验风险优化上反而得到更差解**。

## Decision Gate

系统只完成排序，不替研究者选择。进入 Q2 后，必须先建立 Problem Card，再生成方法假说。`

const specializedExperimentDesignMarkdown = `## 预注册验证协议

### Factorial Design

- 架构：Plain vs. identity-residual。
- 深度：20 / 32 / 44 / 56。
- 重复：每个 cell 5 个随机种子，共 40 runs。
- 同维块使用零参数 shortcut；通道翻倍处的 projection 单独标记，避免把参数增量混入主效应。

### Locked Training Protocol

| 项目 | 固定值 |
|---|---|
| 数据 | CIFAR-10 固定 train/test split，训练集随机裁剪与水平翻转 |
| 优化器 | SGD，momentum=0.9，weight decay=1e-4 |
| 初始化 | He initialization；BN gamma/beta 明确记录 |
| 日程 | 所有组共享 epoch、batch size 与 LR milestone |
| 主终点 | 最后 10 epoch 平均训练 cross-entropy |
| 次终点 | train/test error、time-to-threshold、累计 FLOPs |
| 机制读出 | 每块 activation norm、gradient norm、residual/identity norm ratio |

### Statistical Decision Rule

拟合二因素模型 $L_{train}∼ architecture+depth+architecture× depth$，以 architecture×depth 交互项为主检验；同时报告每个深度配对差异的 bootstrap 95% CI。支持 H4 需要 residual 组不出现随深度恶化的训练损失趋势，且改善首先出现在训练目标而非仅测试误差。

### Falsification and Ablations

1. Residual-56 的训练损失显著高于 Residual-20：否决 H4。
2. 只改善测试误差：不支持优化机制，转向隐式正则化解释。
3. identity 与 gated shortcut 效果相当：不支持“门控参数必要”。
4. 延长 Plain-56 训练即可追平：退化更可能是预算不足。

### Implementation Artifacts

- [\`configs/cifar10/plain_vs_residual.yaml\`](/resnet-demo/wiki)
- [\`experiments/depth_degradation/train.py\`](/resnet-demo/wiki)
- [\`reports/depth-validation-spec.md\`](/resnet-demo/wiki)
- [\`schemas/run-metrics.v1.json\`](/resnet-demo/wiki)`

const correctedExperimentMarkdown = `## 证据核验与实验判定

### 预注册判定规则

1. 若深层普通网络训练误差高于浅层普通网络，则确认“退化”不是普通过拟合。
2. 若残差网络随深度增加训练误差下降，则支持残差参数化改善优化。
3. 不把论文未提供的曲线端点读成精确数值。

### Plain Network Evidence

原论文 Figure 6 显示 Plain-56 的训练误差和测试误差均高于 Plain-20。论文没有在 Table 6 中给出 Plain-20/56 的精确最终误差，因此这里保留为**图形支持的定性证据**，不编造小数。

### CIFAR-10 Residual Results

| 网络 | 测试误差 | Source | Evidence |
|---|---:|---|---|
| ResNet-20 | 8.75% | Table 6 | source-reported |
| ResNet-32 | 7.51% | Table 6 | source-reported |
| ResNet-44 | 7.17% | Table 6 | source-reported |
| ResNet-56 | **6.97%** | Table 6 | source-reported |
| ResNet-110 | **6.43%** | Table 6 | source-reported |

### Verdict

**SUPPORTED BY SOURCE EVIDENCE**：残差网络随深度增加获得更低训练误差和测试误差，符合预注册支持条件。当前演示没有真实执行训练，因此证据等级保持为 \`source-reported/full-paper\`，不标记为 \`reproduced\`。

- [原始论文 PDF](https://openaccess.thecvf.com/content_cvpr_2016/papers/He_Deep_Residual_Learning_CVPR_2016_paper.pdf)
- [CVPR 论文页面](https://openaccess.thecvf.com/content_cvpr_2016/html/He_Deep_Residual_Learning_CVPR_2016_paper.html)
- [Wiki 证据页](/resnet-demo/wiki)`

const correctedConclusionMarkdown = `## 审计后的结论

### Source-supported Claims

1. Figure 6 支持普通深层网络存在训练退化，但不提供可安全引用的曲线端点小数。
2. Table 6 报告 ResNet-20/32/44/56/110 测试误差依次为 8.75%、7.51%、7.17%、6.97%、6.43%。
3. 证据支持恒等快捷连接与残差参数化改善深层网络优化。

### Derived Claim

**残差学习**：不直接拟合完整映射 $H(x)$，而是学习 $F(x)=H(x)-x$，并通过恒等快捷连接得到 $H(x)=F(x)+x$。

### Evidence Boundary

- **full-paper/source-reported**：CIFAR-10 和 ImageNet 原论文实验。
- **derived**：本系统完成的跨文献比较、问题卡和候选假说筛选。
- **not reproduced**：本演示没有实际启动 GPU 训练，不宣称独立复现。

### Remaining Tensions

- 优化路径、梯度传播与表示复用的贡献尚未分离。
- 需要真实运行多随机种子实验并报告 mean ± std。
- ImageNet、bottleneck 和下游任务需要独立复现。

[查看完整 Wiki Topic](/resnet-demo/wiki) · [查看原始论文](https://openaccess.thecvf.com/content_cvpr_2016/papers/He_Deep_Residual_Learning_CVPR_2016_paper.pdf)`

const markdownDetails = [
  ...baseMarkdownDetails.slice(0, 3),
  comparisonMarkdown,
  specializedCandidateQuestionsMarkdown,
  problemCardMarkdown,
  enhancedHypothesisMarkdown,
  specializedExperimentDesignMarkdown,
  correctedExperimentMarkdown,
  correctedConclusionMarkdown,
]

const evidenceAppendices = [
  `### 可核验证据\n\n- [VGG 原文](https://arxiv.org/abs/1409.1556)\n- [Batch Normalization 原文](https://arxiv.org/abs/1502.03167)\n- [Highway Networks 原文](https://arxiv.org/abs/1505.00387)\n- [Wiki 文献索引](/resnet-demo/wiki)`,
  `### 产物链接\n\n- [Wiki Topic](/resnet-demo/wiki)\n- [原始论文来源索引](/resnet-demo/wiki)`,
  `### Source Links\n\n- [VGG 原文](https://arxiv.org/abs/1409.1556)\n- [VGG Wiki 页面](/resnet-demo/wiki)`,
  `### 比较依据\n\n[VGG](https://arxiv.org/abs/1409.1556) · [BatchNorm](https://arxiv.org/abs/1502.03167) · [Highway Networks](https://arxiv.org/abs/1505.00387)`,
  '', '', '', '', '', '',
]

const baseCompletionNotes = [
  '完成 44 篇相关文献的检索、去重、元数据核验与引用关系整理；当前仅建立文献集，尚未提前给出方法结论。',
  '完成 44 篇论文的 paper-ingest，生成结构化论文页、标注证据等级，并通过 Wiki provenance 与结构检查。',
  '完成 VGG 的全文精读和实验深化提取，并建立它与 AlexNet、GoogLeNet、初始化、BatchNorm 和 Highway Networks 的证据联系。',
  '从图像分类文献中形成四个候选研究问题，并按证据强度、重要性和验证成本排序；等待研究者选择，不自动替用户决定。',
  '从深度退化问题形成可证伪的残差学习假说，并明确机制、证据链、反驳条件与最小验证实验。',
  '完成单变量对照实验设计与实现规格，锁定自变量、控制变量、评价指标、证伪条件和代码入口。',
  '完成原论文实验结果核验；保留 Figure 6 的定性结论与 Table 6 的可核验数值，并明确未独立复现。',
  '完成整条研究链的证据审计与结论汇总，并将 atomic claims、局限性和后续验证问题写入 Wiki。',
]

const completionNotes = [
  ...baseCompletionNotes.slice(0, 3),
  '完成五篇关键文献的统一维度比较，识别三条一致证据、三组张力和一条未闭合证据链。',
  baseCompletionNotes[3],
  '完成 Q2 的详细问题分析与标准 Problem Card，记录证据锚点、竞争解释、范围、置信度、最小验证和开放风险。',
  baseCompletionNotes[4],
  baseCompletionNotes[5],
  '完成原论文 Figure 6 与 Table 6 的证据核验，删除未经报告的 Plain 网络精确数字，并明确当前证据不是独立复现。',
  '完成最终证据审计，区分 source-reported、derived 与 not reproduced，并保留需要真实实验验证的边界。',
]

const agentArtifacts = [
  ['wiki://topic/image-classification/index', 'reports/literature-query-results.json', 'reports/image-classification-literature-index.md'],
  ['jobs/paper-ingest-batch.json', 'sources/<paper-id>.md', 'reports/wiki-lint.json'],
  ['sources/vgg-2014.md', 'reports/vgg-2014-experiment-extract.md', 'comparisons/vgg-connections.md'],
  ['bundle://five-paper-evidence', 'comparisons/deep-image-classification-architectures.md', 'claims/unclosed-evidence-chain.json'],
  ['reports/experiment-extracts/*', 'reports/candidate-questions.md', 'decisions/question-ranking.json'],
  ['claims/Q2-DEG-01.json', 'reports/q2-evidence-grade.json', 'reports/q2-depth-degradation-problem-card.md'],
  ['reports/q2-depth-degradation-problem-card.md', 'concepts/hypothesis-candidates.json', 'concepts/identity-residual-hypothesis.md'],
  ['concepts/identity-residual-hypothesis.md', 'reports/depth-validation-design.md', 'configs/cifar10/plain-vs-residual.yaml'],
  ['paper://resnet/Figure-6+Table-6', 'reports/resnet-source-extract.json', 'reports/evidence-verdict.md'],
  ['bundle://research-chain/Q2', 'reports/final-evidence-audit.md', 'wiki://topic/deep-network-optimization'],
]

function taskSender(stageIndex: number, taskIndex: number) {
  return taskIndex === 0 ? 'Main Agent' : stages[stageIndex].agents[taskIndex - 1].name
}

function taskReceiver(stageIndex: number, taskIndex: number) {
  return taskIndex === stages[stageIndex].agents.length - 1 ? 'Main Agent' : stages[stageIndex].agents[taskIndex + 1].name
}

function taskArtifact(stageIndex: number, taskIndex: number) {
  return agentArtifacts[stageIndex]?.[taskIndex] || `artifacts/stage-${stageIndex + 1}-${taskIndex + 1}.json`
}

const active = ref(0)
const revealed = ref(1)
const playing = ref(false)
const typing = ref(false)
const renderedLengths = ref(stages.map(() => 0))
const detailLengths = ref(stages.map(() => 0))
const visualReady = ref(stages.map(() => false))
const promptSent = ref(stages.map(() => false))
const responseStarted = ref(stages.map(() => false))
const composerText = ref('')
const composingPrompt = ref(false)
const messageList = ref<HTMLElement | null>(null)
const followingBottom = ref(true)
let timer: number | undefined
let streamTimer: number | undefined
let holdTimer: number | undefined
let promptTimer: number | undefined
// 录屏节奏：以原始时间轴的 0.8× 播放（所有停顿放大 1.25 倍）。
const responseDelay = 1625
const readingTime = 5250

const currentTask = computed(() => {
  const stage = stages[active.value]
  const runningIndex = stage.agents.findIndex((_, index) => agentState(active.value, index) === 'running')
  return stage.agents[runningIndex >= 0 ? runningIndex : stage.agents.length - 1]
})

function clearPlayback() {
  if (timer) window.clearTimeout(timer)
  if (streamTimer) window.clearInterval(streamTimer)
  if (promptTimer) window.clearInterval(promptTimer)
  timer = undefined
  streamTimer = undefined
  promptTimer = undefined
  playing.value = false
  typing.value = false
  composingPrompt.value = false
}

function visibleSummary(index: number): string {
  return stages[index].summary.slice(0, renderedLengths.value[index])
}

function stageMarkdown(index: number): string {
  const evidence = evidenceAppendices[index] ? `\n\n${evidenceAppendices[index]}` : ''
  return `${markdownDetails[index]}${evidence}\n\n---\n\n**本轮完成：${completionNotes[index]}**`
}

function visibleStageMarkdown(index: number): string {
  return stageMarkdown(index).slice(0, detailLengths.value[index])
}

function agentState(stageIndex: number, taskIndex: number): 'waiting' | 'running' | 'done' {
  if (visualReady.value[stageIndex]) return 'done'
  if (stageIndex < active.value) return 'done'
  if (stageIndex > active.value) return 'waiting'
  const ratio = renderedLengths.value[stageIndex] / Math.max(1, stages[stageIndex].summary.length)
  const start = taskIndex / stages[stageIndex].agents.length
  const end = (taskIndex + 1) / stages[stageIndex].agents.length
  if (ratio >= end) return 'done'
  if (ratio >= start || (taskIndex === 0 && typing.value)) return 'running'
  return 'waiting'
}

function followLatest(behavior: ScrollBehavior = 'auto') {
  if (!followingBottom.value) return
  nextTick(() => {
    const el = messageList.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  })
}

function onMessageScroll() {
  const el = messageList.value
  if (!el) return
  followingBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 72
}

function returnToLatest() {
  followingBottom.value = true
  followLatest('smooth')
}

function startCurrentStage() {
  if (typing.value || composingPrompt.value || visualReady.value[active.value]) return
  if (!promptSent.value[active.value]) {
    typePromptAndSend()
    return
  }
  playing.value = true
  beginStage()
}

function typePromptAndSend() {
  const index = active.value
  const prompt = stages[index].prompt
  composerText.value = ''
  composingPrompt.value = true
  let cursor = 0
  promptTimer = window.setInterval(() => {
    cursor = Math.min(prompt.length, cursor + 2)
    composerText.value = prompt.slice(0, cursor)
    if (cursor < prompt.length) return
    if (promptTimer) window.clearInterval(promptTimer)
    promptTimer = undefined
    composingPrompt.value = false
    timer = window.setTimeout(() => {
      promptSent.value[index] = true
      composerText.value = ''
      followLatest('smooth')
      playing.value = true
      timer = window.setTimeout(beginStage, 650)
    }, 550)
  }, 42)
}

function moveToNextStage() {
  if (active.value >= stages.length - 1) return
  if (timer) window.clearTimeout(timer)
  active.value += 1
  revealed.value = active.value + 1
  followLatest('smooth')
  playing.value = true
  timer = window.setTimeout(startCurrentStage, 1125)
}

function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function onSpaceDown(event: KeyboardEvent) {
  if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return
  event.preventDefault()
  holdTimer = window.setTimeout(() => {
    showAllResults()
  }, 700)
}

function onSpaceUp(event: KeyboardEvent) {
  if (event.code !== 'Space' || isTypingTarget(event.target)) return
  event.preventDefault()
  if (holdTimer) window.clearTimeout(holdTimer)
  holdTimer = undefined
}

function showAllResults() {
  clearPlayback()
  active.value = stages.length - 1
  revealed.value = stages.length
  promptSent.value = stages.map(() => true)
  responseStarted.value = stages.map(() => true)
  renderedLengths.value = stages.map((stage) => stage.summary.length)
  detailLengths.value = stages.map((_, index) => stageMarkdown(index).length)
  visualReady.value = stages.map(() => true)
  composerText.value = ''
  followingBottom.value = true
  followLatest('smooth')
}

function beginStage() {
  if (!playing.value) return
  const index = active.value
  responseStarted.value[index] = true
  typing.value = true
  timer = window.setTimeout(() => {
    streamTimer = window.setInterval(() => {
      const total = stages[index].summary.length
      const detailTotal = stageMarkdown(index).length
      if (renderedLengths.value[index] < total) {
        renderedLengths.value[index] = Math.min(total, renderedLengths.value[index] + 3)
      } else {
        detailLengths.value[index] = Math.min(detailTotal, detailLengths.value[index] + 4)
      }
      followLatest()
      if (renderedLengths.value[index] < total || detailLengths.value[index] < detailTotal) return
      if (streamTimer) window.clearInterval(streamTimer)
      streamTimer = undefined
      typing.value = false
      visualReady.value[index] = true
      followLatest('smooth')
      timer = window.setTimeout(() => {
        if (!playing.value) return
        if (active.value >= stages.length - 1) {
          playing.value = false
          return
        }
        moveToNextStage()
      }, readingTime)
    }, 48)
  }, responseDelay)
}

onBeforeUnmount(() => {
  clearPlayback()
  if (holdTimer) window.clearTimeout(holdTimer)
  window.removeEventListener('keydown', onSpaceDown)
  window.removeEventListener('keyup', onSpaceUp)
})
onMounted(() => {
  window.addEventListener('keydown', onSpaceDown)
  window.addEventListener('keyup', onSpaceUp)
  timer = window.setTimeout(() => {
    playing.value = true
    startCurrentStage()
  }, 1800)
})
</script>

<template>
  <main class="demo-shell">
    <header class="topbar">
      <nav class="native-nav">
        <span>容器管理</span><b>对话</b><router-link to="/resnet-demo/wiki">Wiki</router-link><span>Categories</span><span>Model 配置</span><span>账号管理</span><span>内容消息</span>
      </nav>
    </header>

    <section class="workspace">
      <aside class="research-panel">
        <div class="panel-label">容器</div>
        <div class="container-pill"><span class="pulse"></span>alice</div>
        <div class="panel-label session-label">会话</div>
        <div class="workflow">
          <button class="workflow-item"><span><b>图神经网络论文整理</b></span></button>
          <button class="workflow-item"><span><b>扩散模型评测方案</b></span></button>
          <button class="workflow-item active"><span><b>深层视觉网络研究</b></span></button>
          <button class="workflow-item"><span><b>数据集标注质量检查</b></span></button>
          <button class="workflow-item"><span><b>本周文献阅读计划</b></span></button>
        </div>
        <button class="new-session">＋ 新会话</button>
      </aside>

      <section class="conversation">
        <div class="conversation-head">
          <div><h1>深层视觉网络优化研究</h1></div>
          <div class="header-tags"><span>alice</span><span class="connected">● 已连接</span></div>
        </div>
        <div class="live-status" :class="{ complete: visualReady[active] }">
          <span class="simple-status-dot"></span>
          <strong>{{ visualReady[active] ? '当前任务已完成' : `正在运行 ${currentTask.name}` }}</strong>
          <p>{{ visualReady[active] ? stages[active].finding : currentTask.task }}</p>
        </div>
        <div ref="messageList" class="messages" @scroll="onMessageScroll">
          <template v-for="(stage, index) in stages" :key="stage.title">
            <div v-if="promptSent[index]" class="user-message">
              <div class="avatar user">YOU</div>
              <div><span class="speaker">研究者</span><p>{{ stage.prompt }}</p></div>
            </div>
            <div v-if="responseStarted[index]" class="agent-message">
              <div class="avatar agent">R</div>
              <div class="agent-content">
                <span class="speaker">Researcher <em>AI research agent</em></span>
                <div class="agent-orchestration">
                  <div class="orchestration-title"><span class="network-icon">⌘</span><b>Main Agent · 任务委派与产物回传</b><em>{{ stage.agents.filter((_, taskIndex) => agentState(index, taskIndex) === 'done').length }}/{{ stage.agents.length }}</em></div>
                  <div class="handoff-summary"><b>调度说明</b><span>Main Agent 拆解请求，将证据文件顺序传给专门执行 Agent；每一步只接收显式产物，完成后将可审计文件回传给 Main Agent 汇总。</span></div>
                  <div v-for="(task, taskIndex) in stage.agents" :key="task.name" class="agent-task" :class="agentState(index, taskIndex)">
                    <span class="task-state">{{ agentState(index, taskIndex) === 'done' ? '✓' : agentState(index, taskIndex) === 'running' ? '●' : '○' }}</span>
                    <b>{{ task.name }}</b>
                    <p>
                      <span class="handoff-route">{{ taskSender(index, taskIndex) }} → {{ task.name }}</span>
                      {{ task.task }}
                      <small>产物：{{ taskArtifact(index, taskIndex) }} → {{ taskReceiver(index, taskIndex) }}</small>
                    </p>
                    <em>{{ agentState(index, taskIndex) === 'done' ? '已回传' : agentState(index, taskIndex) === 'running' ? '工作中' : '待接收' }}</em>
                  </div>
                </div>
                <p class="summary">{{ visibleSummary(index) }}<span v-if="typing && index === active" class="stream-cursor"></span></p>

                <MarkdownRenderer v-if="detailLengths[index] > 0" class="markdown-answer" :text="visibleStageMarkdown(index)" :streaming="typing && !visualReady[index]" />

                <div v-if="false && visualReady[index] && stage.kind === 'sources'" class="source-list">
                  <div><span>01–12</span><p><b>深层网络训练与优化</b><small>梯度传播 · 初始化 · 归一化 · 优化器</small></p><em>12 PAPERS</em></div>
                  <div><span>13–24</span><p><b>视觉网络架构演进</b><small>ImageNet CNN · 多尺度结构 · 深度扩展</small></p><em>12 PAPERS</em></div>
                  <div><span>25–31</span><p><b>快捷连接与恒等映射</b><small>Highway networks · skip connections · transformations</small></p><em>7 PAPERS</em></div>
                  <div><span>32–39</span><p><b>检测、定位与分割</b><small>R-CNN family · SPP · semantic segmentation</small></p><em>8 PAPERS</em></div>
                  <div><span>40–44</span><p><b>数据集与评测协议</b><small>ImageNet · CIFAR-10 · COCO · evaluation</small></p><em>5 PAPERS</em></div>
                </div>

                <div v-else-if="false && visualReady[index] && stage.kind === 'ingest'" class="ingest-card">
                  <div class="ingest-head"><b>paper-ingest batch</b><span>44 / 44 完成</span></div>
                  <div class="ingest-progress"><i></i></div>
                  <div class="ingest-stats">
                    <div><b>44</b><span>论文页</span></div><div><b>36</b><span>full-paper</span></div><div><b>8</b><span>skimmed</span></div><div><b>0</b><span>lint blockers</span></div>
                  </div>
                  <p>✓ Citation　✓ Method　✓ Experiments　✓ Results　✓ Reusable Claims　✓ Provenance</p>
                </div>

                <div v-else-if="false && visualReady[index] && stage.kind === 'diagnosis'" class="chart-card">
                  <div class="chart-head"><b>Plain Network · CIFAR-10</b><span><i class="legend blue"></i>20-layer <i class="legend coral"></i>56-layer</span></div>
                  <svg viewBox="0 0 560 150" role="img" aria-label="训练误差曲线">
                    <g class="grid"><line v-for="y in [25,55,85,115]" :key="y" x1="34" :y1="y" x2="540" :y2="y" /></g>
                    <polyline class="line blue-line" points="35,25 100,54 165,76 230,91 295,103 360,111 425,119 490,124 540,127" />
                    <polyline class="line coral-line" points="35,25 100,46 165,61 230,70 295,77 360,82 425,86 490,89 540,91" />
                    <text x="36" y="143">0</text><text x="497" y="143">epochs →</text>
                  </svg>
                  <div class="insight">更深的模型具有更高的训练误差 → 优化退化，而非过拟合</div>
                </div>

                <div v-else-if="false && visualReady[index] && stage.kind === 'hypothesis'" class="equation-card">
                  <div class="mapping"><span>x</span><i></i><div>weight layers<br><b>F(x)</b></div><i></i><span class="plus">＋</span><i></i><span>H(x)</span><svg viewBox="0 0 220 44"><path d="M3 6V36H196V21" /></svg></div>
                  <div class="equation"><span>直接映射</span>H(x)<b>=</b>F(x) + x <em>identity shortcut</em></div>
                </div>

                <div v-else-if="false && visualReady[index] && stage.kind === 'design'" class="code-card">
                  <div class="code-head"><span><i></i><i></i><i></i></span><b>basic_block.py</b><em>PyTorch</em></div>
                  <pre><code><span class="kw">class</span> <span class="fn">BasicBlock</span>(nn.Module):
  <span class="kw">def</span> <span class="fn">forward</span>(self, x):
    identity = x
    out = self.relu(self.bn1(self.conv1(x)))
    out = self.bn2(self.conv2(out))
    out += identity
    <span class="kw">return</span> self.relu(out)</code></pre>
                </div>

                <div v-else-if="false && visualReady[index] && stage.kind === 'experiment'" class="results-card">
                  <div class="metric"><span>ResNet-20</span><b>8.75%</b><i style="--w: 75%"></i></div>
                  <div class="metric"><span>ResNet-32</span><b>7.51%</b><i style="--w: 65%"></i></div>
                  <div class="metric"><span>ResNet-44</span><b>7.17%</b><i style="--w: 62%"></i></div>
                  <div class="metric winner"><span>ResNet-56</span><b>6.97%</b><i style="--w: 56%"></i></div>
                  <div class="result-note"><b>✓ 假说获得支持</b><span>深度增加不再导致训练退化</span></div>
                </div>

                <div v-else-if="false && visualReady[index]" class="conclusion-card">
                  <span class="quote">“</span>
                  <p>残差连接并非只是增加一条信息通路；它重新参数化了目标函数，让网络能够围绕恒等映射学习增量变化。</p>
                  <div><span>Next</span>ResNet-152 · Bottleneck blocks · ImageNet validation</div>
                </div>
              </div>
            </div>
          </template>
          <div v-if="typing" class="typing"><span></span><span></span><span></span> 正在组织研究结果</div>
        </div>
        <button v-if="!followingBottom" class="return-latest" @click="returnToLatest">↓ 回到最新内容</button>

        <footer class="composer">
          <textarea :value="composerText" rows="2" readonly :placeholder="active === stages.length - 1 && visualReady[active] ? '研究任务已完成' : '发消息…'"></textarea>
          <button :disabled="typing || composingPrompt || (active === stages.length - 1 && visualReady[active])" @click="startCurrentStage">发送</button>
        </footer>
      </section>
    </section>
  </main>
</template>

<style scoped>
:global(body) { background: #f2f0eb; overflow: hidden; }
:global(#app) { width: 100%; max-width: none; border: 0; background: #f2f0eb; text-align: left; }
* { box-sizing: border-box; }
button { font: inherit; }
.demo-shell { --ink:#17201d; --muted:#6d7672; --green:#173f35; --mint:#dce9e1; --paper:#fbfaf7; width:100vw; height:100vh; min-width:980px; color:var(--ink); background:#f2f0eb; font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif; }
.topbar { height:72px; display:grid; grid-template-columns:280px 1fr 280px; align-items:center; padding:0 26px; background:#f8f7f3; border-bottom:1px solid #d8d7d1; }
.brand { display:flex; align-items:center; gap:11px; font-family:Georgia,serif; font-size:21px; font-weight:700; }
.brand-mark { width:29px; height:29px; display:flex; align-items:flex-end; gap:3px; padding:6px; border-radius:8px; background:var(--green); }
.brand-mark i { display:block; width:4px; border-radius:3px; background:#cfe6d8; }.brand-mark i:nth-child(1){height:8px}.brand-mark i:nth-child(2){height:16px}.brand-mark i:nth-child(3){height:12px}
.project-title { justify-self:center; display:flex; align-items:center; gap:10px; font-size:14px; }.project-dot{width:8px;height:8px;border-radius:50%;background:#4d9c72}.saved{color:#87908b;font-size:11px;border-left:1px solid #d2d3ce;padding-left:10px}
.top-actions { justify-self:end; display:flex; gap:9px; }.icon-button,.play-button{border:1px solid #cfd2cd;background:white;border-radius:9px;height:38px;cursor:pointer}.icon-button{width:38px;font-size:22px;color:#6c756f}.play-button{padding:0 16px;background:var(--green);color:white;border-color:var(--green);font-size:12px;font-weight:700;letter-spacing:.03em}.play-button span{margin-right:8px}
.workspace{height:calc(100vh - 72px);display:grid;grid-template-columns:280px 1fr;max-width:1600px;margin:auto;background:var(--paper);box-shadow:0 12px 45px rgba(30,40,35,.08)}
.research-panel{padding:30px 20px;background:#eef0eb;border-right:1px solid #d8dbd5;position:relative}.panel-label{padding:0 10px 18px;color:#818985;font-size:10px;font-weight:800;letter-spacing:.15em}.workflow{display:flex;flex-direction:column;gap:5px}.workflow-item{display:flex;align-items:center;gap:13px;width:100%;padding:12px 11px;border:0;border-radius:10px;background:transparent;text-align:left;color:#65706a;cursor:pointer}.workflow-item:disabled{opacity:.42;cursor:default}.workflow-item.active{background:#fff;color:var(--ink);box-shadow:0 4px 15px rgba(30,45,38,.07)}.step-icon{display:grid;place-items:center;width:29px;height:29px;flex:none;border:1px solid #bcc5bf;border-radius:8px;font-size:9px;font-weight:800}.active .step-icon{background:var(--green);color:white;border-color:var(--green)}.complete .step-icon{background:#d7e6dc;color:#2f7558;border-color:#c8dbcf}.workflow-item b{display:block;font-size:12px;line-height:1.35}.workflow-item small{display:block;margin-top:3px;color:#929a96;font-size:8px;letter-spacing:.1em}.source-card{position:absolute;left:20px;right:20px;bottom:22px;padding:16px;border:1px solid #d6dbd5;border-radius:11px;background:#f8f9f5;color:#738079;font-size:10px;line-height:1.45}.source-card>div{margin-bottom:9px;color:#496057;font-weight:700}.source-card strong{font-family:Georgia,serif;font-size:23px;color:var(--ink)}.source-card p{margin-top:8px}.pulse{display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:#52a274;box-shadow:0 0 0 4px #dcece2}
.conversation{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--paper)}.conversation-head{height:92px;display:flex;align-items:center;justify-content:space-between;padding:18px 48px 15px;border-bottom:1px solid #e4e2dc}.conversation-head span{color:#808c87;font-size:9px;font-weight:800;letter-spacing:.14em}.conversation-head h1{margin:5px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:25px;letter-spacing:-.02em;color:var(--ink)}.stage-count{font-family:ui-monospace,monospace;font-size:11px;color:#8b928e}.progress{height:2px;background:#e6e6e0}.progress i{display:block;height:100%;background:#447b65;transition:width .7s ease}
.messages{flex:1;min-height:0;overflow-y:auto;padding:28px max(44px,calc((100% - 850px)/2));scroll-behavior:auto}.messages::-webkit-scrollbar{width:6px}.messages::-webkit-scrollbar-thumb{background:#d8d9d4;border-radius:9px}.user-message,.agent-message{display:grid;grid-template-columns:34px 1fr;gap:13px;margin-bottom:22px;animation:rise .45s ease both}.avatar{width:31px;height:31px;display:grid;place-items:center;border-radius:9px;font-size:8px;font-weight:800}.avatar.user{background:#e6e3dc;color:#69716d}.avatar.agent{background:var(--green);color:white;font-family:Georgia,serif;font-size:14px}.speaker{display:block;margin:1px 0 7px;font-size:10px;font-weight:800;color:#54615b}.speaker em{margin-left:8px;color:#98a09c;font-size:8px;font-style:normal;font-weight:500}.user-message p{padding:12px 15px;border:1px solid #deded8;border-radius:4px 13px 13px 13px;background:#f4f2ed;color:#3d4843;font-size:12px;line-height:1.55}.agent-content>.summary{font-family:Georgia,'Songti SC',serif;color:#25312c;font-size:13px;line-height:1.75}
.source-list,.chart-card,.equation-card,.code-card,.results-card,.conclusion-card{margin-top:16px;border:1px solid #dcddd7;border-radius:12px;background:#fff;overflow:hidden}.source-list>div{display:flex;align-items:center;gap:13px;padding:12px 15px;border-bottom:1px solid #ecece7}.source-list>div:last-child{border:0}.source-list>div>span{font:10px ui-monospace;color:#87918c}.source-list p{flex:1}.source-list b{display:block;font-family:Georgia,serif;font-size:12px}.source-list small{display:block;color:#8a918e;font-size:9px;margin-top:3px}.source-list em{padding:3px 6px;border-radius:4px;background:#e9f1eb;color:#397056;font-size:7px;font-style:normal;font-weight:800}
.chart-card{padding:14px 17px}.chart-head{display:flex;justify-content:space-between;font-size:10px}.chart-head span{color:#7d8682;font-size:8px}.legend{display:inline-block;width:7px;height:7px;margin:0 3px 0 8px;border-radius:50%}.blue{background:#356d78}.coral{background:#d6765f}.chart-card svg{width:100%;height:145px;overflow:visible}.grid line{stroke:#e9e9e4;stroke-width:1}.line{fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.blue-line{stroke:#356d78}.coral-line{stroke:#d6765f}.chart-card text{fill:#9ba19e;font-size:8px}.insight{padding:8px 10px;border-radius:7px;background:#f4eee9;color:#8b523f;font-size:9px;font-weight:700}
.equation-card{padding:20px}.mapping{height:70px;display:flex;align-items:center;justify-content:center;gap:10px;position:relative}.mapping>span{padding:7px 9px;border-radius:6px;background:#e8efea;font:12px Georgia}.mapping>div{padding:8px 18px;border:1px solid #bacbc1;border-radius:8px;text-align:center;color:#607069;font-size:8px}.mapping>i{width:28px;height:1px;background:#8aa195}.mapping .plus{padding:0;background:none;font-size:18px}.mapping svg{position:absolute;width:250px;height:50px;left:calc(50% - 195px);top:31px;overflow:visible}.mapping path{fill:none;stroke:#80a18f;stroke-width:1;stroke-dasharray:3}.equation{text-align:center;font:21px Georgia;color:#1f3b31}.equation span,.equation em{font:8px system-ui;color:#8b9691;margin:0 14px}.equation b{font-weight:400;margin:0 9px}
.code-card{background:#17221f;color:#dbe8df}.code-head{display:flex;align-items:center;padding:9px 13px;border-bottom:1px solid #2a3733;font-size:8px}.code-head>span{display:flex;gap:4px;margin-right:13px}.code-head i{width:6px;height:6px;border-radius:50%;background:#68756f}.code-head b{flex:1}.code-head em{font-style:normal;color:#7f9189}.code-card pre{margin:0;padding:14px 20px;font:10px/1.7 ui-monospace,monospace}.code-card code{display:block;padding:0;background:none;color:inherit}.kw{color:#d2a7e1}.fn{color:#8dd6ad}
.results-card{padding:14px 17px}.metric{display:grid;grid-template-columns:95px 1fr 50px;align-items:center;gap:10px;margin:9px 0;font-size:9px}.metric b{text-align:right;font:11px ui-monospace}.metric i{grid-column:2;grid-row:1;height:6px;width:var(--w);border-radius:9px;background:#52826d}.metric i.bad{background:#c77d69}.metric.winner{color:#1c6246;font-weight:800}.result-note{display:flex;justify-content:space-between;margin-top:13px;padding-top:12px;border-top:1px solid #e8e9e4;font-size:9px}.result-note b{color:#397257}.result-note span{color:#858d89}
.conclusion-card{position:relative;padding:18px 22px;background:#eef4ef}.conclusion-card .quote{position:absolute;right:18px;top:5px;font:46px Georgia;color:#c7d9ce}.conclusion-card>p{max-width:88%;font:14px/1.7 Georgia;color:#284137}.conclusion-card>div{margin-top:12px;padding-top:10px;border-top:1px solid #d5e2d9;color:#668075;font-size:9px}.conclusion-card>div span{margin-right:12px;color:#34664f;font-weight:800}
.typing{margin:0 0 18px 47px;color:#7d8983;font-size:9px}.typing span{display:inline-block;width:5px;height:5px;margin-right:3px;border-radius:50%;background:#648273;animation:bounce 1s infinite}.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}
.composer{height:76px;margin:0 max(44px,calc((100% - 850px)/2)) 18px;padding:12px 13px 12px 18px;border:1px solid #d7d9d3;border-radius:12px;background:white;display:flex;align-items:center;box-shadow:0 9px 26px rgba(30,45,38,.06)}.composer>div{flex:1}.composer span{display:block;color:#48564f;font-size:9px;font-weight:800}.composer p{margin-top:4px;color:#9aa19e;font-size:10px}.composer button{width:36px;height:36px;border:0;border-radius:9px;background:var(--green);color:white;cursor:pointer}.composer button:disabled{background:#cbd0cc;cursor:default}
@keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}@keyframes bounce{0%,70%,100%{transform:none;opacity:.5}35%{transform:translateY(-4px);opacity:1}}
/* 与项目原生 ChatView 保持同一套 Element Plus 视觉语言。 */
:global(body){background:var(--el-bg-color)}
:global(#app){background:var(--el-bg-color)}
.demo-shell{--ink:var(--el-text-color-primary);--green:var(--el-color-primary);--paper:var(--el-bg-color);background:var(--el-bg-color);font-family:var(--sans)}
.topbar{height:41px;display:flex;grid-template-columns:none;align-items:center;justify-content:space-between;padding:0 20px;background:var(--el-bg-color);border-color:var(--el-border-color)}
.native-nav{display:flex;align-items:center;gap:18px;height:100%;font-size:14px;color:var(--el-text-color-secondary)}
.native-nav a,.native-nav a:visited,.native-nav a:hover,.native-nav a:active{color:var(--el-text-color-secondary);text-decoration:none}
.native-nav b{height:100%;display:flex;align-items:center;color:var(--el-color-primary);font-weight:600;border-bottom:2px solid var(--el-color-primary)}
.top-actions{display:flex;gap:6px}.icon-button,.play-button{height:28px;border:1px solid var(--el-border-color);border-radius:7px;background:var(--el-bg-color)}.icon-button{width:30px;font-size:17px;color:var(--el-text-color-secondary)}.play-button{padding:0 12px;border-color:var(--el-color-primary);background:var(--el-color-primary);font-size:11px;font-weight:400}
.workspace{height:calc(100vh - 41px);grid-template-columns:220px 1fr;max-width:none;margin:0;box-shadow:none}
.research-panel{padding:12px;background:var(--el-bg-color);border-color:var(--el-border-color)}
.panel-label{padding:0;margin:8px 0 4px;color:var(--el-text-color-secondary);font-size:12px;letter-spacing:0;text-transform:uppercase}
.session-label{margin-top:16px}.container-pill{display:flex;align-items:center;padding:7px 10px;border-radius:7px;background:var(--el-color-primary-light-8);color:var(--el-color-primary);font-size:14px}
.workflow{gap:0}.workflow-item{padding:7px 10px;border-radius:7px;color:var(--el-text-color-secondary)}.workflow-item.active{background:var(--el-color-primary-light-8);color:var(--el-color-primary);box-shadow:none}.workflow-item b{display:block;max-width:176px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400}.workflow-item small,.step-icon{display:none}
.new-session{position:absolute;left:12px;bottom:14px;width:calc(100% - 24px);padding:6px;border:1px dashed var(--el-border-color);border-radius:7px;background:transparent;color:var(--el-text-color-secondary);font-size:13px}.pulse{width:8px;height:8px;margin-right:8px;background:var(--el-color-success);box-shadow:none}
.conversation-head{height:45px;padding:0 18px;border-color:var(--el-border-color)}.conversation-head h1{margin:0;font-family:var(--sans);font-size:16px;font-weight:600;letter-spacing:0}.header-tags{display:flex;gap:8px}.header-tags span{padding:2px 8px;border-radius:10px;background:var(--el-fill-color-light);color:var(--el-text-color-secondary);font-size:11px;letter-spacing:0}.header-tags .connected{color:var(--el-color-success)}
.live-status{height:38px;display:flex;align-items:center;gap:8px;padding:0 18px;border-bottom:1px solid var(--el-border-color-lighter);background:var(--el-fill-color-lighter)}.simple-status-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--el-color-primary);animation:pulseAgent 1s infinite}.live-status.complete .simple-status-dot{background:var(--el-color-success);animation:none}.live-status strong{flex:none;color:var(--el-text-color-primary);font-size:11px}.live-status p{min-width:0;overflow:hidden;color:var(--el-text-color-secondary);font-size:10px;text-overflow:ellipsis;white-space:nowrap}
.progress{background:var(--el-border-color-lighter)}.progress i{background:var(--el-color-primary)}
.messages{padding:18px;display:flex;flex-direction:column}.user-message,.agent-message{display:flex;grid-template-columns:none;gap:0;margin-bottom:14px}.user-message{justify-content:flex-end}.agent-message{justify-content:flex-start}.avatar,.speaker{display:none}.user-message>div:last-child{max-width:840px}.user-message p{padding:10px 14px;border:0;border-radius:12px;background:var(--el-color-primary-light-8);color:var(--el-text-color-primary);font-size:14px}.agent-content{max-width:840px;padding:10px 14px;border-radius:12px;background:var(--el-fill-color-light)}.agent-content>.summary{font-family:var(--sans);color:var(--el-text-color-primary);font-size:14px;line-height:1.65}
.source-list,.chart-card,.equation-card,.code-card,.results-card,.conclusion-card{border-color:var(--el-border-color);border-radius:8px}.conclusion-card{background:var(--el-color-primary-light-9)}
.ingest-card{margin-top:16px;padding:14px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color)}.ingest-head{display:flex;justify-content:space-between;font-size:10px}.ingest-head span{color:var(--el-color-success)}.ingest-progress{height:6px;margin:10px 0 13px;border-radius:8px;background:var(--el-fill-color)}.ingest-progress i{display:block;width:100%;height:100%;border-radius:8px;background:var(--el-color-success)}.ingest-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.ingest-stats>div{padding:8px;border-radius:7px;background:var(--el-fill-color-lighter);text-align:center}.ingest-stats b{display:block;color:var(--el-text-color-primary);font:15px ui-monospace,monospace}.ingest-stats span{color:var(--el-text-color-secondary);font-size:8px}.ingest-card>p{margin-top:11px;color:var(--el-text-color-secondary);font-size:8px}
.agent-orchestration{margin-bottom:12px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color);overflow:hidden}.orchestration-title{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid var(--el-border-color-lighter);background:var(--el-fill-color-lighter);font-size:11px}.orchestration-title .network-icon{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;background:var(--el-color-primary-light-8);color:var(--el-color-primary);font-weight:700}.orchestration-title b{flex:1;color:var(--el-text-color-primary)}.orchestration-title em{color:var(--el-text-color-placeholder);font-style:normal;font-family:ui-monospace,monospace}.handoff-summary{display:flex;gap:8px;padding:7px 11px;border-bottom:1px solid var(--el-border-color-lighter);font-size:9px;line-height:1.5;color:var(--el-text-color-secondary)}.handoff-summary b{flex:0 0 auto;color:var(--el-text-color-primary)}.agent-task{display:grid;grid-template-columns:18px 108px 1fr 48px;align-items:start;gap:6px;padding:8px 11px;border-bottom:1px solid var(--el-border-color-lighter);font-size:10px;transition:background .25s}.agent-task:last-child{border-bottom:0}.agent-task .task-state{padding-top:2px;color:var(--el-text-color-placeholder);font-size:10px}.agent-task>b{padding-top:1px;color:var(--el-text-color-regular);font-size:10px}.agent-task p{display:flex;flex-direction:column;gap:3px;color:var(--el-text-color-secondary);font-size:10px;line-height:1.45}.agent-task p .handoff-route{color:var(--el-color-primary);font-family:ui-monospace,SFMono-Regular,monospace;font-size:9px}.agent-task p small{color:var(--el-text-color-placeholder);font-family:ui-monospace,SFMono-Regular,monospace;font-size:8px;overflow-wrap:anywhere}.agent-task em{padding-top:1px;text-align:right;color:var(--el-text-color-placeholder);font-size:9px;font-style:normal}.agent-task.running{background:var(--el-color-primary-light-9)}.agent-task.running .task-state,.agent-task.running em{color:var(--el-color-primary);animation:pulseAgent 1s infinite}.agent-task.done .task-state,.agent-task.done em{color:var(--el-color-success)}.agent-task.waiting{opacity:.52}@keyframes pulseAgent{50%{opacity:.35}}
.reasoning-summary{margin-top:14px}.reasoning-summary>div{padding:10px 12px;border:1px solid var(--el-border-color-lighter);border-radius:8px;background:var(--el-bg-color)}.reasoning-summary b{display:block;margin-bottom:5px;color:var(--el-color-primary);font-size:11px}.reasoning-summary p{color:var(--el-text-color-regular);font-size:12px;line-height:1.55}
.wiki-delivery{display:grid;grid-template-columns:24px 1fr auto auto;align-items:center;gap:9px;margin-top:9px;padding:9px 11px;border:1px solid var(--el-color-success-light-7);border-radius:8px;background:var(--el-color-success-light-9)}.wiki-check{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--el-color-success);color:#fff;font-size:11px}.wiki-delivery b{display:block;color:var(--el-text-color-primary);font-size:10px}.wiki-delivery p{margin-top:2px;color:var(--el-text-color-secondary);font:9px ui-monospace,monospace}.artifact-note{color:var(--el-text-color-secondary);font-size:9px}.wiki-delivery em{padding:2px 6px;border-radius:9px;background:var(--el-bg-color);color:var(--el-color-success);font-size:8px;font-style:normal;font-weight:700}
.markdown-answer{margin-top:12px;padding:2px 4px;color:var(--el-text-color-primary);font-size:13px}.return-latest{position:absolute;right:28px;bottom:78px;z-index:5;padding:7px 12px;border:1px solid var(--el-border-color);border-radius:16px;background:var(--el-bg-color);color:var(--el-color-primary);box-shadow:var(--el-box-shadow-light);font-size:11px;cursor:pointer}.conversation{position:relative}
.completion-note{display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:11px 13px;border-left:3px solid var(--el-color-primary);border-radius:4px 8px 8px 4px;background:var(--el-color-primary-light-9);color:var(--el-text-color-primary);font-size:12px;line-height:1.6}.completion-note span{flex:none;display:grid;place-items:center;width:18px;height:18px;margin-top:1px;border-radius:50%;background:var(--el-color-primary);color:#fff;font-size:9px}.completion-note strong{font-weight:700}
.typing{align-self:flex-start;margin-left:14px;color:var(--el-text-color-secondary)}.stream-cursor{display:inline-block;width:7px;height:14px;margin-left:2px;background:var(--el-color-primary);vertical-align:-2px;animation:blink 1s steps(1) infinite}@keyframes blink{50%{opacity:0}}
.composer{height:68px;margin:0;padding:12px 18px;border:0;border-top:1px solid var(--el-border-color);border-radius:0;background:var(--el-bg-color);box-shadow:none}.composer>div{height:44px;padding:7px 9px;border:1px solid var(--el-border-color);border-radius:8px}.composer span{display:none}.composer p{margin-top:5px;color:var(--el-text-color-placeholder);font-size:13px}.composer button{width:auto;height:40px;margin-left:8px;padding:0 16px;border-radius:8px;background:var(--el-color-primary)}
.composer textarea{flex:1;height:44px;resize:none;padding:8px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color);color:var(--el-text-color-primary);font:13px/1.4 var(--sans);outline:none}.composer textarea:focus{border-color:var(--el-color-primary)}.composer button{border:0;color:#fff}.composer button:disabled{opacity:.55;cursor:default}
@media(max-width:1150px){.topbar{grid-template-columns:220px 1fr 220px}.workspace{grid-template-columns:230px 1fr}.research-panel{padding-left:14px;padding-right:14px}.source-card{left:14px;right:14px}.messages{padding-left:32px;padding-right:32px}.composer{margin-left:32px;margin-right:32px}}
@media(prefers-color-scheme:dark){
  .demo-shell{--paper:#16171d;--ink:#f3f4f6;--el-bg-color:#16171d;--el-bg-color-overlay:#242630;--el-fill-color-light:#242630;--el-fill-color-lighter:#1d1f27;--el-border-color:#3a3d47;--el-border-color-lighter:#2e303a;--el-text-color-primary:#f3f4f6;--el-text-color-regular:#d1d5db;--el-text-color-secondary:#9ca3af;--el-text-color-placeholder:#737b87;background:#16171d;color:#e5e7eb}.topbar,.research-panel,.conversation,.composer{background:#16171d;border-color:#2e303a}.workspace{background:#16171d}.native-nav{color:#9ca3af}.native-nav a,.native-nav a:visited,.native-nav a:hover,.native-nav a:active{color:#9ca3af}.container-pill,.workflow-item.active,.user-message p{background:rgba(64,158,255,.18)}.workflow-item{color:#a4abb5}.conversation-head{border-color:#2e303a}.conversation-head h1{color:#f3f4f6}.header-tags span{background:#242630;color:#aeb4bf}.live-status{background:#1d1f27;border-color:#2e303a}.live-status strong{color:#e5e7eb}.live-status p{color:#9ca3af}.agent-content{background:#242630}.agent-content>.summary{color:#e5e7eb}.agent-orchestration{background:#1b1d24;border-color:#343741}.orchestration-title{background:#22242c;border-color:#343741}.orchestration-title b,.agent-task b{color:#e5e7eb}.agent-task{border-color:#30333c}.agent-task.running{background:rgba(64,158,255,.12)}.agent-task p{color:#9ca3af}.composer>div{border-color:#3a3d47;background:#1d1f27}.markdown-answer{color:#e5e7eb}.return-latest{background:#242630;border-color:#3a3d47;color:#79bbff}.source-list,.ingest-card,.chart-card,.equation-card,.results-card{background:#1d1f27;border-color:#343741}.code-card{background:#101512}.reasoning-summary>div{background:#1d1f27;border-color:#343741}
}
</style>

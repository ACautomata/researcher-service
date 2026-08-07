<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import WikiGraph from '@/components/WikiGraph.vue'

const graphOpen = ref(true)
const currentPath = ref('syntheses/deep-visual-network-optimization.md')

const researchGraph = {
  nodes: [
    { id: 'syntheses/deep-visual-network-optimization.md', title: '深层网络优化' },
    { id: 'syntheses/deep-image-classification-architectures.md', title: '架构比较' },
    { id: 'concepts/depth-degradation.md', title: '深度退化' },
    { id: 'concepts/identity-mapping.md', title: '恒等映射' },
    { id: 'concepts/residual-parameterization.md', title: '残差参数化' },
    { id: 'domains/computer-vision/papers/alexnet-2012.md', title: 'AlexNet' },
    { id: 'domains/computer-vision/papers/vgg-2014.md', title: 'VGG' },
    { id: 'domains/computer-vision/papers/googlenet-2015.md', title: 'GoogLeNet' },
    { id: 'domains/computer-vision/papers/batch-normalization-2015.md', title: 'BatchNorm' },
    { id: 'domains/computer-vision/papers/highway-networks-2015.md', title: 'Highway Networks' },
    { id: 'reports/vgg-2014-experiment-extract.md', title: 'VGG 实验提取' },
    { id: 'reports/q2-depth-degradation-problem-card.md', title: 'Q2 Problem Card' },
    { id: 'reports/depth-validation-spec.md', title: '验证设计' },
    { id: 'reports/residual-evidence-audit.md', title: '证据审计' },
    { id: 'sources/image-classification-literature-index.md', title: '文献索引' },
  ],
  edges: [
    { from: 'domains/computer-vision/papers/alexnet-2012.md', to: 'syntheses/deep-image-classification-architectures.md' },
    { from: 'domains/computer-vision/papers/vgg-2014.md', to: 'syntheses/deep-image-classification-architectures.md' },
    { from: 'domains/computer-vision/papers/googlenet-2015.md', to: 'syntheses/deep-image-classification-architectures.md' },
    { from: 'domains/computer-vision/papers/vgg-2014.md', to: 'reports/vgg-2014-experiment-extract.md' },
    { from: 'reports/vgg-2014-experiment-extract.md', to: 'concepts/depth-degradation.md' },
    { from: 'domains/computer-vision/papers/batch-normalization-2015.md', to: 'concepts/depth-degradation.md' },
    { from: 'domains/computer-vision/papers/highway-networks-2015.md', to: 'concepts/identity-mapping.md' },
    { from: 'concepts/depth-degradation.md', to: 'reports/q2-depth-degradation-problem-card.md' },
    { from: 'reports/q2-depth-degradation-problem-card.md', to: 'concepts/residual-parameterization.md' },
    { from: 'concepts/identity-mapping.md', to: 'concepts/residual-parameterization.md' },
    { from: 'concepts/residual-parameterization.md', to: 'reports/depth-validation-spec.md' },
    { from: 'reports/depth-validation-spec.md', to: 'reports/residual-evidence-audit.md' },
    { from: 'reports/residual-evidence-audit.md', to: 'syntheses/deep-visual-network-optimization.md' },
    { from: 'syntheses/deep-image-classification-architectures.md', to: 'syntheses/deep-visual-network-optimization.md' },
    { from: 'sources/image-classification-literature-index.md', to: 'domains/computer-vision/papers/vgg-2014.md' },
    { from: 'sources/image-classification-literature-index.md', to: 'domains/computer-vision/papers/batch-normalization-2015.md' },
    { from: 'sources/image-classification-literature-index.md', to: 'domains/computer-vision/papers/highway-networks-2015.md' },
  ],
}

const wikiGroups = [
  { name: 'syntheses', pages: [
    { path: 'syntheses/deep-visual-network-optimization.md', title: '深层视觉网络的优化与架构设计' },
    { path: 'syntheses/deep-image-classification-architectures.md', title: '深层图像分类架构比较' },
  ] },
  { name: 'concepts', pages: [
    { path: 'concepts/depth-degradation.md', title: '深度退化' },
    { path: 'concepts/identity-mapping.md', title: '恒等映射' },
    { path: 'concepts/residual-parameterization.md', title: '残差参数化' },
  ] },
  { name: 'domains/computer-vision/papers', pages: [
    { path: 'domains/computer-vision/papers/alexnet-2012.md', title: 'AlexNet · 2012' },
    { path: 'domains/computer-vision/papers/vgg-2014.md', title: 'VGG · 2014' },
    { path: 'domains/computer-vision/papers/googlenet-2015.md', title: 'GoogLeNet · 2015' },
    { path: 'domains/computer-vision/papers/batch-normalization-2015.md', title: 'Batch Normalization · 2015' },
    { path: 'domains/computer-vision/papers/highway-networks-2015.md', title: 'Highway Networks · 2015' },
  ] },
  { name: 'reports', pages: [
    { path: 'reports/vgg-2014-experiment-extract.md', title: 'VGG 实验深化提取' },
    { path: 'reports/q2-depth-degradation-problem-card.md', title: '深度退化问题卡' },
    { path: 'reports/depth-validation-spec.md', title: '残差验证设计' },
    { path: 'reports/residual-evidence-audit.md', title: '残差证据审计' },
  ] },
  { name: 'sources', pages: [
    { path: 'sources/image-classification-literature-index.md', title: 'arXiv · DOI · CVPR 来源索引' },
    { path: 'sources/provenance-registry.md', title: '原始材料与 provenance' },
  ] },
  { name: 'entities', pages: [] },
]

const pageSummaries: Record<string, string> = {
  'syntheses/deep-image-classification-architectures.md': '在统一维度下比较 AlexNet、VGG、GoogLeNet、BatchNorm 与 Highway Networks，区分深度、宽度、多分支结构、归一化和跨层路径各自贡献。',
  'concepts/depth-degradation.md': '深度退化指更深普通网络不仅测试误差更高，训练误差也更高。由于更深模型原则上可通过新增恒等层复现浅层解，该现象属于优化异常而非经典过拟合。',
  'concepts/identity-mapping.md': '恒等映射保持输入不变：H(x)=x。在同维残差块中，无参数 shortcut 精确提供恒等通路，使新增变换分支可以围绕零函数学习增量。',
  'concepts/residual-parameterization.md': '残差参数化把直接拟合 H(x) 改写为 F(x)=H(x)-x，并输出 H(x)=F(x)+x。核心预测是深度增加时训练目标不再系统性恶化。',
  'domains/computer-vision/papers/alexnet-2012.md': '建立大规模 GPU 卷积网络在 ImageNet 分类上的有效性，为后续扩大视觉模型深度提供经验起点。',
  'domains/computer-vision/papers/vgg-2014.md': '用规则的 3×3 卷积堆叠系统考察 11–19 个权重层，提供深度收益及其边际递减的关键证据。',
  'domains/computer-vision/papers/googlenet-2015.md': '通过 Inception 多分支结构平衡感受野、计算量与模型深度，说明性能收益不能简单归因于层数。',
  'domains/computer-vision/papers/batch-normalization-2015.md': '通过小批量统计归一化中间激活，改善优化稳定性和学习率容忍度，但并不保证新增层容易实现恒等映射。',
  'domains/computer-vision/papers/highway-networks-2015.md': '使用 transform/carry gate 建立跨层信息通路，可训练百层级网络，为快捷路径提供直接先例，但引入了额外门控参数。',
  'reports/vgg-2014-experiment-extract.md': '提取 VGG 的配置、控制变量、ImageNet 指标、深度收益和未解释边界，并建立与初始化、归一化及跨层路径工作的连接。',
  'reports/q2-depth-degradation-problem-card.md': '记录 Q2-DEG-01 的嵌套解反常、五项竞争解释、证据锚点、最小判别实验及外部有效性边界。',
  'reports/depth-validation-spec.md': '预注册 Plain/Residual × 20/32/44/56 层的二因素实验、5 个随机种子、训练交叉熵主终点和 architecture×depth 交互检验。',
  'reports/residual-evidence-audit.md': '核验 Figure 6 的定性曲线与 Table 6 的精确数值，区分 source-reported、derived 和 not reproduced。',
  'sources/image-classification-literature-index.md': '保存 44 篇去重来源的标题、作者、年份、DOI、arXiv、出版页面与引用关系。',
  'sources/provenance-registry.md': '记录每个 Wiki claim 对应的原始来源、页码或表图位置、摄入时间、全文可用性和证据等级。',
}

const currentMeta = computed(() => wikiGroups.flatMap(group => group.pages).find(page => page.path === currentPath.value))
const generatedPage = computed(() => `# ${currentMeta.value?.title || 'Wiki Page'}

> **Path:** \`${currentPath.value}\`  
> **Evidence level:** ${currentPath.value.startsWith('domains/') ? 'full-paper' : currentPath.value.startsWith('sources/') ? 'provenance' : 'derived from cited evidence'}  
> **Status:** verified

## Summary

${pageSummaries[currentPath.value] || '该页面尚未填充摘要。'}

## Evidence Boundary

- 页面结论必须能够追溯到 \`sources/\` 或领域论文页。
- 原文没有明确报告的数值不进行曲线估读。
- 本演示没有运行独立训练，因此不标记为 \`reproduced\`。

## Connections

- [[深层视觉网络的优化与架构设计]]
- [[深度退化]]
- [[残差参数化]]

---

**本页完成：已将该研究对象纳入可追溯 Wiki，并建立与综合主题、概念和来源证据的连接。**`)

function openPage(path: string) {
  currentPath.value = path
}

const topic = `# 深层视觉网络的优化与架构设计

> **Topic status:** stable  
> **Evidence:** 36 full-paper · 8 skimmed · 1 source-audited synthesis  
> **Updated:** 2026-08-07

## Current Thesis

深层卷积网络的表达能力随深度增加，但普通的逐层参数化会产生优化退化：更深模型不仅测试误差升高，训练误差也可能高于较浅模型。围绕恒等映射学习残差，并通过无参数快捷连接保留输入表示，可以显著降低深层网络的优化难度。

## Scope

本 Topic 汇总 1989–2015 年间与深层视觉网络、梯度传播、初始化、归一化、恒等映射、快捷连接及大规模图像识别相关的 44 篇来源。页面只记录有来源支持的主张；全文不可用的论文标记为 \`skimmed\`，不用于支撑高置信度结论。

## Research Object Map

| Wiki object | Canonical page | Role in the research chain |
|---|---|---|
| 综合主题 | \`syntheses/deep-visual-network-optimization.md\` | 汇总跨文献结论与开放问题 |
| 核心问题 | \`concepts/depth-degradation.md\` | 定义嵌套解反常、竞争解释和验证边界 |
| 方法假说 | \`concepts/identity-residual-learning.md\` | 记录残差参数化及可证伪预测 |
| 论文语料 | \`domains/computer-vision/papers/*.md\` | 保存逐篇论文的结构化精读页 |
| 来源材料 | \`sources/*.md\` | 保存导入来源、标识符和 provenance |
| 质量审计 | \`reports/residual-evidence-audit.md\` | 区分 source-reported、derived 与 not reproduced |

## Key Threads

### 1. 深度带来更强的视觉表征

- **Krizhevsky et al., 2012 — ImageNet Classification with Deep Convolutional Neural Networks**：证明大规模深度卷积网络在 ImageNet 上的有效性。
- **Simonyan & Zisserman, 2014 — Very Deep Convolutional Networks for Large-Scale Image Recognition**：系统展示小卷积核与网络深度的收益。
- **Szegedy et al., 2015 — Going Deeper with Convolutions**：通过多分支结构提高计算效率和表示能力。

### 2. 深层网络的优化障碍

- **Glorot & Bengio, 2010 — Understanding the Difficulty of Training Deep Feedforward Neural Networks**：分析深层网络信号传播与初始化困难。
- **He et al., 2015 — Delving Deep into Rectifiers**：提出适配 ReLU 的初始化方法。
- **Ioffe & Szegedy, 2015 — Batch Normalization**：通过归一化改善训练稳定性和收敛速度。

### 3. 信息跨层传递与恒等路径

- **Raiko et al., 2012 — Deep Learning Made Easier by Linear Transformations in Perceptrons**：研究线性变换对深层优化的帮助。
- **Srivastava et al., 2015 — Highway Networks**：使用门控信息通路训练极深网络。
- **Long et al., 2015 — Fully Convolutional Networks for Semantic Segmentation**：通过跨层融合恢复空间信息。

## Atomic Claims

> **Claim:** 普通网络增加深度后可能出现训练误差上升。  
> **Evidence:** 原论文 Figure 6 定性显示 Plain-56 的训练与测试曲线均劣于 Plain-20；不从曲线臆测端点小数。  
> **Scope:** CIFAR-10，匹配的普通卷积架构与训练协议。  
> **Confidence:** high  
> **Tensions:** 不能由过拟合解释；梯度消失证据不足。

> **Claim:** 恒等快捷连接与残差参数化能够缓解观察到的深度退化。  
> **Evidence:** 原论文 Table 6 报告 ResNet-20/32/44/56/110 的测试误差为 8.75%/7.51%/7.17%/6.97%/6.43%；Figure 6 提供 plain/residual 训练曲线的定性对照。  
> **Scope:** CIFAR-10 对照实验；除快捷连接外保持训练条件一致。  
> **Confidence:** high · source-reported/full-paper

> **Claim:** 残差参数化的主要价值是改善优化，而非单纯增加模型容量。  
> **Evidence:** 快捷连接几乎不引入参数，同时训练误差与测试误差同步改善。  
> **Scope:** 当前证据覆盖 20–56 层网络。  
> **Confidence:** medium-high

## Evidence Table

| 研究线索 | 代表来源 | Evidence level | 对当前结论的作用 |
|---|---|---|---|
| 深度与表征 | AlexNet · VGG · GoogLeNet | full-paper | 建立“增加深度有潜在收益”的前提 |
| 优化与初始化 | Glorot · He initialization · BatchNorm | full-paper | 排查训练不稳定与梯度传播问题 |
| 跨层信息通路 | Highway Networks · FCN | full-paper | 提供快捷连接的先行证据 |
| 深度退化对照 | Plain-20 / Plain-56 · Figure 6 | full-paper / qualitative | 定义需要解决的核心问题 |
| 残差验证 | ResNet-20–110 · Table 6 | full-paper / source-reported | 支持残差学习假说 |

## Tensions

- **优化解释与表示解释尚未完全分离**：现有对照支持优化改善，但没有单独量化每条快捷路径对表示复用的贡献。
- **Highway Networks 与恒等快捷连接机制不同**：前者使用可学习门控，后者采用无参数加法；不能把两者的实验结论直接互换。
- **证据等级边界**：CIFAR-10、ImageNet 与下游任务目前均为论文来源报告；演示未执行独立训练，不标记为 \`reproduced\`。
- **未报告信息**：部分早期论文没有公开完整训练配置，相关比较保留为 \`skimmed\`，不用于精确数值归因。

## Connections

- [[深层网络优化]]
- [[恒等映射]]
- [[快捷连接]]
- [[CIFAR-10 评测协议]]
- [[ImageNet 规模化验证]]

## Artifact Inventory

- **12 篇领域论文页**：\`domains/computer-vision/papers/\`
- **3 个概念对象**：深度退化、恒等映射、残差参数化
- **2 个综合页面**：架构比较、深层视觉网络优化
- **3 个研究报告**：VGG 实验提取、Q2 问题卡、残差证据审计
- **1 个验证规格**：\`reports/depth-validation-spec.md\`

## Provenance Policy

1. 精确数值必须锚定论文表格、正文或补充材料。
2. 从曲线读取但原文未报告的端点只记作 qualitative，不生成小数。
3. 跨文献推论标记为 \`derived\`，不能升级为来源直接结论。
4. 未实际运行训练的结果一律标记为 \`not reproduced\`。

## Open Questions

1. 残差连接的收益中，优化路径与梯度传播分别贡献多少？
2. 当输入输出维度不一致时，投影快捷连接是否会改变机制解释？
3. 瓶颈结构扩展至 50、101、152 层后，收益是否仍保持一致？
4. 该结构能否迁移到检测、分割和其他非视觉任务？

---

**本页完成：将 44 篇参考文献组织为可追溯的研究脉络，沉淀 3 条原子主张、5 组证据关系与 4 个后续研究问题。**`

const currentDocument = computed(() => currentPath.value === 'syntheses/deep-visual-network-optimization.md' ? topic : generatedPage.value)
</script>

<template>
  <main class="wiki-demo">
    <header class="topbar">
      <nav class="native-nav">
        <span>容器管理</span><router-link to="/resnet-demo">对话</router-link><b>Wiki</b><span>Categories</span><span>Model 配置</span><span>账号管理</span><span>内容消息</span>
      </nav>
    </header>
    <section class="wiki-view">
      <header class="wiki-header">
        <span class="wiki-brand">Wiki</span>
        <select class="switcher"><option>alice</option></select>
        <span class="save-state">已保存</span>
        <span class="page-count">24 pages · 6 groups · 44 sources</span>
        <button class="toggle-graph" :aria-pressed="graphOpen" @click="graphOpen = !graphOpen">
          <span class="graph-button-icon">{{ graphOpen ? '◧' : '◇' }}</span>
          {{ graphOpen ? '隐藏图谱' : '显示图谱' }}
        </button>
      </header>
      <div class="wiki-body">
        <aside class="left">
          <div class="tree-header"><span>文件</span><button title="新建页面">＋</button></div>
          <div class="tree-filter">⌕ 搜索 Wiki…</div>
          <template v-for="group in wikiGroups" :key="group.name">
            <div class="group-name"><span>{{ group.pages.length ? '⌄' : '›' }} {{ group.name }}</span><em>{{ group.name === 'sources' ? 44 : group.name.includes('papers') ? 12 : group.pages.length }}</em></div>
            <button
              v-for="page in group.pages"
              :key="page.path"
              class="tree-node"
              :class="{ active: currentPath === page.path }"
              :title="page.path"
              @click="openPage(page.path)"
            >
              <span>{{ page.title }}</span>
            </button>
            <div v-if="group.name.includes('papers')" class="tree-node muted"><span>另有 7 篇论文…</span></div>
          </template>
        </aside>
        <main class="center">
          <div class="document-bar">
            <div><span class="file-kind">MD</span><code>{{ currentPath }}</code></div>
            <div class="document-meta"><span>source-audited</span><span>已保存</span></div>
          </div>
          <MarkdownRenderer class="wiki-markdown" :text="currentDocument" :streaming="false" />
        </main>
        <aside v-if="graphOpen" class="right">
          <div class="graph-title"><span>关系图谱</span><em>15 nodes · 17 links</em></div>
          <div class="graph-canvas">
            <WikiGraph class="research-network" :graph="researchGraph" :active-path="currentPath" @open="openPage" />
            <div class="graph-legend"><span><i></i>当前页面</span><span><i></i>关联页面</span></div>
          </div>
        </aside>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(body){margin:0;overflow:hidden;background:var(--el-bg-color)}:global(#app){width:100%;max-width:none;border:0;text-align:left}*{box-sizing:border-box}.wiki-demo{width:100vw;height:100vh;color:var(--el-text-color-primary);font-family:var(--sans)}.topbar{height:41px;display:flex;align-items:center;padding:0 20px;border-bottom:1px solid var(--el-border-color)}.native-nav{display:flex;align-items:center;gap:18px;height:100%;font-size:14px;color:var(--el-text-color-secondary)}.native-nav a{color:inherit;text-decoration:none}.native-nav b{height:100%;display:flex;align-items:center;color:var(--el-color-primary);font-weight:600;border-bottom:2px solid var(--el-color-primary)}
.wiki-view{display:flex;flex-direction:column;height:calc(100vh - 41px)}.wiki-header{height:45px;display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid #e4e7ed}.wiki-brand{font-weight:600}.switcher{padding:4px 8px;border:1px solid #dcdfe6;border-radius:4px;background:var(--el-bg-color);color:var(--el-text-color-primary)}.save-state{font-size:12px;color:#67c23a}.toggle-graph{margin-left:auto;padding:4px 10px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#606266;cursor:pointer}.wiki-body{display:flex;flex:1;min-height:0}.left{width:220px;border-right:1px solid #e4e7ed;overflow-y:auto;font-size:13px}.tree-header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #e4e7ed;font-weight:600;color:#303133}.tree-header button,.tree-node button{border:0;background:none;color:#409eff;font-size:16px}.group-name{padding:6px 10px 2px;color:#909399;font-size:12px}.tree-node{display:flex;justify-content:space-between;align-items:center;padding:6px 8px 6px 20px;color:#606266}.tree-node.active{background:#ecf5ff;color:#409eff}.tree-node span{max-width:175px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tree-node button{color:#c0c4cc;font-size:13px}.center{flex:1;overflow-y:auto;padding:16px 24px}.document-path{padding:0 2px 12px;border-bottom:1px solid var(--el-border-color-lighter);color:var(--el-text-color-placeholder);font:10px ui-monospace,monospace}.wiki-markdown{max-width:860px;margin:18px auto 60px;font-size:14px;line-height:1.7}.right{width:320px;border-left:1px solid #e4e7ed;overflow:hidden}.graph-title{height:38px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #e4e7ed;color:#606266;font-size:12px;font-weight:600}.graph-canvas{position:relative;height:calc(100% - 38px);background:radial-gradient(circle,#dfe3e8 1px,transparent 1px);background-size:18px 18px}.graph-node{position:absolute;z-index:2;display:grid;place-items:center;width:74px;height:32px;border:1px solid #b9c9df;border-radius:16px;background:#fff;color:#606266;text-align:center;font-size:9px;box-shadow:0 2px 6px rgba(0,0,0,.06)}.graph-node.core{left:108px;top:45%;width:104px;height:48px;border-color:#409eff;background:#ecf5ff;color:#409eff;font-weight:600}.graph-node.n1{left:25px;top:25%}.graph-node.n2{right:24px;top:28%}.graph-node.n3{left:30px;top:68%}.graph-node.n4{right:25px;top:66%}.edge{position:absolute;z-index:1;left:75px;width:105px;height:1px;background:#b9c2cc;transform-origin:left center}.edge.e1{top:31%;transform:rotate(25deg)}.edge.e2{left:168px;top:49%;transform:rotate(-49deg)}.edge.e3{top:72%;transform:rotate(-22deg)}.edge.e4{left:168px;top:54%;transform:rotate(43deg)}
.page-count{color:var(--el-text-color-placeholder);font-size:11px}.toggle-graph{display:flex;align-items:center;gap:6px;transition:border-color .2s,color .2s,background .2s}.toggle-graph:hover{border-color:#409eff;color:#409eff;background:#ecf5ff}.graph-button-icon{font-size:12px}.tree-filter{margin:8px;padding:6px 8px;border:1px solid var(--el-border-color-lighter);border-radius:5px;background:var(--el-fill-color-lighter);color:var(--el-text-color-placeholder);font-size:11px}.group-name{display:flex;justify-content:space-between;align-items:center;gap:6px;padding-top:8px;text-transform:none}.group-name span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-name em{flex:none;font-style:normal;font:10px ui-monospace,monospace}.tree-node{width:100%;min-height:30px;border:0;border-left:2px solid transparent;background:transparent;text-align:left;font:inherit;cursor:pointer}.tree-node:hover{background:var(--el-fill-color-lighter)}.tree-node.active{border-left-color:#409eff}.tree-node.muted{color:var(--el-text-color-placeholder);font-size:11px;font-style:italic;cursor:default}.document-bar{position:sticky;z-index:4;top:-16px;display:flex;justify-content:space-between;align-items:center;margin:-16px -24px 0;padding:9px 16px;border-bottom:1px solid var(--el-border-color-lighter);background:color-mix(in srgb,var(--el-bg-color) 94%,transparent);backdrop-filter:blur(8px);color:var(--el-text-color-placeholder);font-size:10px}.document-bar>div{display:flex;align-items:center;gap:8px}.document-bar code{font:10px ui-monospace,SFMono-Regular,monospace}.file-kind{padding:2px 4px;border-radius:3px;background:#ecf5ff;color:#409eff;font-size:8px;font-weight:700}.document-meta span{padding:2px 6px;border-radius:10px;background:var(--el-fill-color-lighter)}.document-meta span:last-child{color:#67c23a}.wiki-markdown{max-width:800px;margin-top:24px}.right{width:440px;flex:0 0 440px}.graph-title{justify-content:space-between}.graph-title em{color:var(--el-text-color-placeholder);font-size:9px;font-style:normal;font-weight:400}.graph-legend{position:absolute;bottom:14px;left:14px;display:flex;gap:12px;padding:6px 8px;border:1px solid var(--el-border-color-lighter);border-radius:5px;background:var(--el-bg-color);color:var(--el-text-color-placeholder);font-size:8px}.graph-legend span{display:flex;align-items:center;gap:4px}.graph-legend i{width:6px;height:6px;border-radius:50%;background:#b9c9df}.graph-legend span:first-child i{background:#409eff}.graph-node{font-family:inherit;cursor:pointer}.graph-node:hover{border-color:#409eff;color:#409eff;box-shadow:0 4px 12px rgba(64,158,255,.18)}.graph-node.core{left:163px;width:112px;height:52px}.graph-node.n1{left:35px;top:23%}.graph-node.n2{right:34px;top:26%}.graph-node.n3{left:42px;top:70%}.graph-node.n4{right:36px;top:68%}.edge{left:90px;width:150px}.edge.e2,.edge.e4{left:220px}@media(max-width:1100px){.page-count{display:none}.right{width:340px;flex-basis:340px}.graph-node.core{left:108px;width:104px;height:48px}.graph-node.n1{left:25px;top:25%}.graph-node.n2{right:24px;top:28%}.graph-node.n3{left:30px;top:68%}.graph-node.n4{right:25px;top:66%}.edge{left:75px;width:105px}.edge.e2,.edge.e4{left:168px}}@media(max-width:900px){.right{width:280px;flex-basis:280px}.left{width:200px}.center{padding-left:18px;padding-right:18px}}
@media(prefers-color-scheme:dark){
  .wiki-demo{--el-bg-color:#16171d;--el-bg-color-overlay:#242630;--el-fill-color-light:#242630;--el-fill-color-lighter:#1d1f27;--el-border-color:#3a3d47;--el-border-color-lighter:#2e303a;--el-text-color-primary:#f3f4f6;--el-text-color-regular:#d1d5db;--el-text-color-secondary:#9ca3af;--el-text-color-placeholder:#737b87}.wiki-demo,.topbar,.wiki-view,.wiki-header,.wiki-body,.center,.left,.right{background:#16171d;color:#e5e7eb}.topbar,.wiki-header,.left,.right,.tree-header,.graph-title{border-color:#2e303a}.native-nav{color:#9ca3af}.native-nav a,.native-nav a:visited{color:#9ca3af}.switcher,.toggle-graph{background:#22242c;border-color:#3a3d47;color:#d1d5db}.tree-header{color:#f3f4f6}.group-name,.tree-node,.graph-title{color:#9ca3af}.tree-node.active{background:rgba(64,158,255,.18);color:#79bbff}.document-path{border-color:#2e303a;color:#7f8792}.wiki-markdown{color:#e5e7eb}.graph-canvas{background-color:#181a20;background-image:radial-gradient(circle,#353943 1px,transparent 1px)}.graph-node{background:#242630;border-color:#4b5563;color:#c7ccd4;box-shadow:0 2px 7px rgba(0,0,0,.28)}.graph-node.core{background:rgba(64,158,255,.18);border-color:#409eff;color:#79bbff}.edge{background:#525866}
}
</style>

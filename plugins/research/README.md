# 科研工作流（research）

科研工作流插件把四条固定科研流程接进 chat 会话：**单一入口、意图自动路由、流程互斥**。
你在对话里用自然语言描述科研诉求，或直接敲斜杠命令，插件会把它分派到对应的流程执行。

## 启用

插件默认未启用。在面板插件目录中一键启用后，**新会话**即获得 `research_workflow` 工具与
4 条命令；禁用后新会话不再可见，进行中的运行不受影响，历史回放保持原样。

## 四条流程

| 命令 | 流程 | 适用场景 |
|---|---|---|
| `/ingest` | 知识库深度构建 | 把 `/lab/uploads` 下的论文 PDF 精读整理成结构化笔记页入库 wiki |
| `/discover` | 科学问题可信发现 | 从一篇已有论文中审稿式地找出问题、弱点与研究缺口 |
| `/hypothesize` | 科学假说自主生成 | 生成新的研究想法、方向与假说 |
| `/experiment` | 实验自主设计与执行 | 为明确的问题或想法设计验证实验，并在沙箱中真实执行 |

## 入口与路由

两种触发方式汇聚到同一个执行面：

- **命令直达**：`/ingest /discover /hypothesize /experiment` 显式指定流程，不经过意图分类。
- **自然语言**：直接描述诉求（如「帮我把这篇论文的问题找出来」），主 agent 调用
  `research_workflow` 工具，入口图内的意图分类器自动判定流程；置信度不足时会**反问澄清**
  （列出最可能的候选流程供你选择），不会盲目执行。

```mermaid
flowchart TD
    U["chat 会话<br/>（自然语言或命令）"]

    U -->|"直接描述诉求"| AGENT["主 agent<br/>组织 topic / question"]
    U -->|"/ingest /discover<br/>/hypothesize /experiment"| CMD["命令直达<br/>显式指定 workflow"]

    AGENT --> TOOL["research_workflow 工具"]
    CMD --> TOOL

    TOOL --> G{{"入口图"}}

    G -->|"命令带 workflow（seed 透传）"| R
    G -->|"自然语言（无 workflow）"| C["classify 意图分类<br/>5 值标签 + 置信度"]

    C -->|"高置信 ≥ 0.60"| R["互斥分发<br/>（恰一流程在跑）"]
    C -->|"低置信 < 0.60"| CL["clarify 反问<br/>列出最可能的候选流程"]
    C -->|"不属于科研诉求（none）"| CLN["clarify 如实拒识<br/>请改述需求"]

    CL --> U
    CLN --> U

    R --> W1["ingest<br/>知识库深度构建"]
    R --> W2["discover<br/>科学问题可信发现"]
    R --> W3["hypothesize<br/>科学假说自主生成"]
    R --> W4["experiment<br/>实验自主设计与执行"]

    W1 --> E["产物落 wiki（页面 + claims）<br/>进度经 SSE 实时上报"]
    W2 --> E
    W3 --> E
    W4 --> E
```

### 路由规则速记

- **命令路径恒直达**：命令已显式指定流程，永不触发分类与澄清兜底。
- **seed 透传**：请求中已带 `workflow`（命令 / 你显式指定 / 实验流程的结果收集调用）时，
  跳过分类器直接进入对应流程。
- **多意图输入**：高置信时选首个意图执行，并在结果末尾提示「检测到后续意图 X，可继续发起」。
- **澄清后再发**：回复 clarify 提示时，重新描述诉求或直接说「用 discover 流程」，主 agent
  会带着显式流程重新调用。

## 流程详情

> 已上线：**W1 ingest**（知识库深度构建）与 **W2 discover**（科学问题可信发现）。
> **W3 hypothesize** / **W4 experiment** 节点链仍在按计划接入——此阶段发起会收到占位说明。

### W1 `/ingest` 知识库深度构建（七节点链，V1 单篇）

```mermaid
flowchart TD
    S(["/ingest /lab/uploads/论文.pdf"]) --> C["capture<br/>路径前缀 + 单篇校验<br/>（确定性）"]
    C -->|"非 /lab/uploads 前缀<br/>URL 来源暂不支持"| F1["明确失败<br/>（诊断回喂）"]
    C --> E["extract<br/>PDF 按页提取文本<br/>（超限明确报错）"]
    E --> CR["create<br/>LLM 生成 11 节论文页<br/>+ claims 结构化提交"]
    CR --> V["validate<br/>11 节标题齐全 / ≥100 行<br/>Results 含具体数字（确定性）"]
    V -->|"不过 → 附诊断<br/>回 create 重试 1 次"| CR
    V -->|"通过"| P["persist<br/>幂等哨兵写入 wiki<br/>（页已存在 = 跳过不覆盖）"]
    P --> VF["verify<br/>回读 11 节对账 + 产物指纹<br/>（确定性）"]
    VF --> SM["summary<br/>≤1k + 产物路径"]
```

- 产物：`papers/<kebab-case 标题>.md` 论文页（frontmatter 溯源由核心组装 + Atomic Claims 块）。
- **重跑/断线重放安全**：persist 的幂等哨兵保证同一论文不建重复页；verify 回读对账确认落盘完整。
- 生成质量门：LLM 产出经确定性校验（节结构 / 行数 / Results 数字），不过则带诊断自动重试一次，再不过即明确失败。

### W2 `/discover` 科学问题可信发现（九节点链）

```mermaid
flowchart TD
    S(["/discover 研究问题"]) --> RI["resolveInputs<br/>定位论文页<br/>（确定性）"]
    RI -->|"论文页不存在"| CL["clarify 出口<br/>提示先 /ingest（产物串联）"]
    RI --> L["load<br/>按 11 节锚回读论文页"]
    L --> EX["extract<br/>LLM 12 节实验深度提取"]
    EX --> V1["validate¹<br/>12 节 checklist<br/>+ 三态标注禁语扫描"]
    V1 -->|"不过 → 附诊断<br/>回 extract 重试 1 次"| EX
    V1 --> CR["critic<br/>LLM §0–§7 审稿式分析<br/>+ 候选问题 2–4 带优先级"]
    CR --> V2["validate²<br/>节齐全 + category 标签<br/>+ 候选 2–4（确定性）"]
    V2 -->|"不过 → 附诊断<br/>回 critic 重试 1 次"| CR
    V2 --> EG["evidenceGate<br/>证据引用存在性回查<br/>（确定性）"]
    EG --> P["persist<br/>critic 页 + 候选问题 claims"]
    P --> SM["summary<br/>≤1k + 产物路径<br/>+ 剔除清单（不静默）"]
```

- 产物：`critics/<slug>.md` critic 页（§0–§7 + `category: critic` 机读标签 + 验证候选问题进 Atomic Claims）。
- **证据可溯源**：候选问题的每条证据引用（论文页章节 / extract 节 / 上传件）逐一回查，
  不可溯源的引用被剔除——剔除清单进 summary，本身就是溯源信息。
- 两个校验节点检查对象不同（extract 12 节 vs critic §0–§7），分别把关各自生成质量。

## 产物与进度

> **当前版本说明**：W1（ingest）与 W2（discover）节点链已全链可用（见上方流程详情）；
> W3 / W4 的节点链正按计划接入——此阶段发起会收到「已受理 + 流程待接入」的占位说明。
> 下述人审能力随 W4 实现票生效。

- 发现、假说与实验报告落 **wiki**（页面 + Atomic Claims 溯源块），中间产物落 **lab**；
  页面带 frontmatter 溯源（来源插件 / 工具调用 / 流程名 / 生成时间 / 180 天陈旧标记）。
- 流程进度以裸节点名经 `research_run.progress` SSE 事件实时上报，前端按流程 + 阶段双段
  徽标呈现。
- 实验流程（experiment）在设计方案产出后设有**方案人审门禁**：方案以审批卡呈现，你批准后
  才进入沙箱执行段；拒绝可附理由进入修订（上限 3 轮）。

## 配置

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `RESEARCH_MODEL` | 否 | 意图分类与流程节点的 LLM 模型 id（面板级 pin；缺省跟随 owner 默认链 primary）。 |

其余阈值（意图置信阈值 0.60、生成重试、扇出上限等）为代码常量，随版本发布走，不做配置面。

## 开发者注

- 规格：`docs/research/853-research-workflows-plugin.md`（#906 修订版）
- 实施拆分：#873（本 README 随 [#873·3] 骨架票落档；四流程详图各随实现票补齐）
- 意图分类评估锚点：throwaway 分支 `research/intent-classifier-eval`（40 条 bad case ×
  3 轮实测，复跑需 `LLM_API_KEY`）

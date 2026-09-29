# 744 AutoFigure 换轨 AutoFigure-Edit 与 LangGraph 化融合规格

> Wayfinder 票 [#744](https://github.com/ACautomata/researcher-service/issues/744)，map：[#734 LangGraph agent runtime 替代 OpenClaw](https://github.com/ACautomata/researcher-service/issues/734)。
> 根决策 [#722](https://github.com/ACautomata/researcher-service/issues/722)（LangGraph JS + 集中式 runner + LLM 移控制面）是本规格的钉定前提；接缝引述 #726（SSE 事件面）/ #728（双容器）/ #729（审批漏斗）/ #730（前端单管线渲染）/ #731（ProviderRegistry）。
> 状态：**v2 修订**（2026-09-29，插件系统 effort 票 [#753](https://github.com/ACautomata/researcher-service/issues/753) 定稿）：宿主形态（Q2）与入口面打包部分（Q10）supersede 为「官方插件目录首个插件」（map [#750](https://github.com/ACautomata/researcher-service/issues/750) / 根决策 [#749](https://github.com/ACautomata/researcher-service/issues/749) Q9·Q16 / 契约 [#752](https://github.com/ACautomata/researcher-service/issues/752) [docs/research/752](./752-plugin-system.md)）；§5.5 事件族按 #747 wiki_run 先例修订；§8 退役 env 勘误；§10 六票拆分按插件契约改写；新增 §11 插件接缝规格。换轨 -Edit / graph 节点规格 / 数据模型 / 凭证面 / 产物契约等其余决策**原样不动**。v1 原文见 [PR #746](https://github.com/ACautomata/researcher-service/pull/746)。

## 0. 上游事实与换轨前提

### 0.1 两个上游，不是一回事

| | `ResearAI/AutoFigure`（原始版） | `ResearAI/AutoFigure-Edit` |
|---|---|---|
| 链路 | LLM 生成 mxGraph/draw.io XML（多模态 + 5 张 bundled 参考图）→ Playwright + draw.io embed 渲染 PNG → VLM judge 评分 | 生图 LLM → SAM3 分割 → 裁切/去背景 → 多模态 LLM 复刻 SVG template（fix/optimize 循环）→ 图标替换 → final SVG |
| 面板关系 | vendored（`deploy/autofigure-sidecar/`，pin `454ee86` = 该仓库当前 HEAD，2026-06-26 后上游零演进） | 未集成；[#348 深读](./autofigure-edit-codebase.md)（HEAD `16f3749` = 当前 HEAD，同构） |
| 产物 | mxGraph XML（也可 SVG——上游模板两套，bridge 硬编码 mxgraphxml） | **SVG**（Figure Editor 的 SVG-Edit 画布原生格式） |
| 质量机制 | VLM judge 评分（面板 V1 只跑 iteration=1，未启用迭代） | 4.5 fix（≤3 次 LLM 修复）+ 4.6 optimize（多模态自检迭代）；**无 VLM judge** |

### 0.2 换轨决策与零迁移前提

- **换轨**：生成链路基线 = AutoFigure-Edit 流水线（text→figure 的完整产品语义：先出图再矢量化为可编辑 SVG）。
  原始版 vendored 全量退役——换轨理由：产物 SVG 与 Figure Editor（F2/F3，SVG-Edit）形成「生成→编辑」闭环（mxGraph↔SVG 往返有损）；-Edit 的链路语义（图像→结构化 SVG）与「研究员在会话里产出可编辑图」的产品意图一致。
- **零迁移**：沿 [#732](https://github.com/ACautomata/researcher-service/issues/732) 前提（产品未上线、无真实用户/数据）——旧 Figure 行不迁移、旧产物不转换，直接换轨删除。
- 上游演进压力：两上游均近乎冻结（原始版 6 月末后零提交；-Edit 自 v1.1 后仅 README/社区图改动）——**逐字移植无跟进负担，re-vendor 机制随退役作废**。

### 0.3 计算侧无硬阻塞（调研核实）

-Edit 链的非 LLM 计算步骤全部有控制面 TS 可行解：

| 步骤 | 上游实现 | 控制面实现 |
|---|---|---|
| SAM3 分割 | local（torch）/ fal / Roboflow 三后端 | 云 API：fal `fal-ai/sam-3/image`（上游已适配）/ Roboflow |
| 裁切 + 去背景 | PIL + RMBG-2.0（torch + HF gated） | 裁切 = TS 原生（sharp）；去背景 = fal Bria RMBG 2.0（`fal-ai/bria/background/remove`，已核实存在） |
| SVG→PNG 渲染（optimize 循环输入 + 预览） | cairosvg | resvg-j / sharp（无浏览器路径） |
| SVG 语法校验 / 修复 | lxml | TS XML/SVG parser（parse5 / svgson 族） |
| 图标 base64 内嵌 / 坐标对齐 | 纯 Python 字符串/数值逻辑 | TS 直译 |

## 1. 目标形态总览

```
deepagents 会话 (thread)
  └─ figure 工具（唯一生成入口，domain-scoped 工具；v2：AutoFigure 插件贡献，默认未启用）
       └─ 控制面专用 LangGraph graph（固定 pipeline，非 agent loop）── 随会话 run 执行
            ├─ 生图节点      image-gen LLM（figure 域面板级配置）
            ├─ 分割节点      SAM3 云 API（fal/Roboflow）
            ├─ 图标准备节点  裁切（TS）+ 去背景（fal Bria RMBG）
            ├─ 模板生成节点  多模态文本 LLM（ProviderRegistry，owner）── fix ≤3 / optimize 迭代循环
            ├─ 组装节点      图标替换 + 坐标对齐（TS 纯逻辑）
            └─ 预览渲染节点  SVG→PNG（resvg-j）
       └─ 产物落 Figure 行（final SVG + 预览 PNG + 运行元数据）
            └─ 工具结果 = figureId 引用 → 对话内渲染/下载（figures API）
```

与根决策的关系：LLM 全部经控制面出口（多模态文本 = ProviderRegistry 单出口原则的自然延伸；生图与云 API = 面板级配置的服务端出口，凭证纪律同现行：env 注入、不落盘、不入日志、不进事件载荷）。

> **v2 修订（#753）**：figure 工具可用性 = owner 插件启用集过滤后的 run 装配结果（#752 §4.2）——默认未启用、目录一键启用（#749 Q16）；图中 figure 工具/graph/图卡的注册宿主 = 官方插件 AutoFigure（§11），Figure 表与 figures API 留核心。

## 2. 决策全录（grilling 三轮 10 决策；Q2/Q10 经 v2 修订注记）

| # | 决策 | 选定 | 要点 |
|---|---|---|---|
| Q1 | 重构基线 | **换轨 AutoFigure-Edit** | 产物 SVG 与 Figure Editor 闭环；原版 vendored 全量退役（§8） |
| Q2 | 宿主形态 | **固定 graph 包装为 deepagents 可调用工具**（v2 修订，原表述「全内嵌控制面」supersede） | 专用 LangGraph pipeline graph（非 agent loop）不变；v2：graph 物理落位 `plugins/autofigure/`，工具/命令/渲染经插件 manifest 注册（§11） |
| Q3 | run 形态 | **figure run 实体 + 事件族** | 用户面进度随会话 run 的工具调用事件（v2 定形 = `figure_run.progress`，§5.5）；`figure_run.*` 机器面/审计（对齐 `wiki_run.*`） |
| Q4 | 数据模型 | **Figure 保留，GenerationJob 退役** | 幂等/归属门是资产；状态机/超时/reconcile 由 run 域统一机制承载，不养两套 |
| Q5 | 计算宿主 | **纯控制面 + 云 API** | SAM3/RMBG 走 fal；计算 Port 保持可换，本地重计算 sidecar 为回退形态（§9）；v2：计算 Port 落 `plugins/autofigure/` |
| Q6 | V1 输入面 | **仅 method_text** | 幂等身份单字段；参数内置常量；参考图/导入工作流按产品拉动后续加（加字段须同步扩幂等/去重身份——`service.ts` fingerprint 扩展点注释的契约延续） |
| Q7 | 评审形态 | **忠实 -Edit，不嫁接 judge** | 质量机制 = fix/optimize 循环；`evaluation` 列改存 pipeline 元数据（迭代数/模型/参数） |
| Q8 | 凭证面 | **文本走 ProviderRegistry，生图面板级** | 见 §6；figure 生成随会话 run 占 per-user `maxConcurrentRuns`，不开第二套配额 |
| Q9 | 产物契约 | **thread 为中心** | 存储沿 Figure 行（`xml` 列语义 → final SVG 文本）；工具结果带 figureId 引用不内联 SVG；只持久化 final SVG + 预览 PNG |
| Q10 | 入口面 | **工具唯一入口**（语义不变） | `AutoFigureView` 退役；REST 创建端点退役；figures API 保留读/下载面；v2 修订：工具/命令/图卡三件打包进插件包（§11），能力可见性 = 插件启用位 |

## 3. 生成流水线 graph 规格

> **v2 落位（#753）**：graph 与计算 Port 实现代码落 `plugins/autofigure/`（server 面源目录直引，#752 R1）——纯逻辑模块不依赖插件运行时，票 1/2 随 #747 先行施工时插件目录先行存在（#749 Q2 时序 / Q4 落位裁决）；数据模型（Figure 表/figures API）留核心 `server/src/figures/`。

### 3.1 节点与状态

graph 状态（LangGraph state）：`methodText`、`figurePng`（步骤 1 产物）、`samedPng` + `boxlib`（步骤 2）、`icons[]`（步骤 3：裁切图 + 去背景图 + 坐标）、`templateSvg` → `optimizedSvg`（步骤 4/4.6，fix/optimize 循环计数）、`finalSvg`（步骤 5）、`previewPng`、`evaluationMeta`（元数据聚合）。

| 节点 | 上游对应（autofigure2.py） | 实现宿主 | 失败语义 |
|---|---|---|---|
| 生图 | 步骤 1 `generate_figure_from_method` | image-gen LLM（面板级配置） | 失败即 run failed（上游 raise 语义） |
| 分割 | 步骤 2 `segment_with_sam3` | fal/Roboflow API | 无命中 → `no_icon_mode`（上游回退链保留，§3.2） |
| 图标准备 | 步骤 3 `crop_and_remove_background` | sharp + fal RMBG | 失败 → no_icon_mode；no_icon_mode 下跳过 |
| 模板生成 | 步骤 4 `generate_svg_template` + 4.5 `check_and_fix_svg` + 4.6 `optimize_svg_with_llm` | 多模态文本 LLM（ProviderRegistry，owner；v2 经 `ctx.llm` 出口，§11.1） | 上游保真：fix ≤3；optimize 单次迭代异常 continue、base64 校验不过保留上一版 |
| 组装 | 步骤 5 `replace_icons_in_svg` | TS 纯逻辑直译（label 邻近/坐标匹配/追加末尾的替换策略链） | — |
| 预览渲染 | `svg_to_png`（cairosvg） | resvg-j | 渲染失败不致命（SVG 仍是产物；预览缺失标记进元数据） |

### 3.2 保底链（上游语义逐点保留）

`no_icon_mode`（SAM 无命中）→ 跳过图标准备 → 模板生成走「像素级复现、禁止占位符」prompt → 若模板生成仍失败 → **内嵌原图的保底 SVG**（`create_embedded_figure_svg` 语义）——保证工具调用几乎总有可用 SVG 结果。

### 3.3 移植策略

- **逐字移植** prompt 模板与结构约束（`<g id="AF01">` 占位符、`viewBox/width/height` = 原图像素、`#808080` 灰底黑框 spec、optimize 八要点检查单）到 TS——步骤 5 的正则/坐标替换依赖这些结构约定，改写即断链。
- **golden-file 对照测试**：移植验收 = 同输入下与上游 Python 实现的产物对照（SVG 结构性 diff，容忍渲染器差异）。
- **署名**：移植是 MIT（Autofigure2 contributors）derivative work，保留版权与来源声明（UPSTREAM 精神延续，vendor 目录本身退役）。
- 渲染器差异（cairosvg vs resvg-j）影响 optimize 循环的多模态对比输入——golden-file 验收覆盖此差异面；若差异实质影响迭代收敛，回退项：sharp/librsvg 二次校准。

## 4. figure 工具与 thread 产物契约

### 4.1 工具形态

- **可用性（v2 修订）**：figure 工具与 `/figure` 命令只在 owner 启用 AutoFigure 插件后可达——run 装配按启用集静态过滤（#752 §4.2），命令目录经启用位过滤（#752 R4）。v1「对所有会话可用」语义以此为准：两触发面均只在启用后可达，执行面契约零变化。
- **签名（V1）**：输入 `method_text`（唯一参数，长度上限沿 4000 UTF-16 单元语义）；无文件/exec 参数。
- **执行语义**：**同步长工具调用**——随调用方的会话 run 执行（graph 在 run 内运行），分钟级时长内 agent loop 阻塞等待（语义即「agent 决定画图并等结果」）。阶段进度经 `figure_run.progress` SSE 事件给前端（v2 定形，§5.5；工具行显示：生图中 / 分割中 / 模板生成中 / 组装中）。
- **中断联动**：会话 run aborted（#726 `aborted{by}`）→ figure run 联动 aborted 终态（无半产物落 Figure 成功态）；v2 落实 = `exec.signal` 传播（#752 §2.2）+ 插件 catch 落 `figure_run.aborted` 审计（§11.2）。
- **审批边界**：figure 工具是 domain-scoped 工具（非文件/exec 类），**不进 #729 三层漏斗**——漏斗对象是 file/exec 工具参数，figure 工具的输入是纯文本描述。spec 记边界：domain 工具的白名单外地位由 #729 工具类别映射表（#737 回填）正式收录（v2 不动：#752 §3 已正式收录 category=domain 先例）。
- **手动调用**：`/figure <method_text>` 作为插件命令注册（v2：命名空间「系统 > 插件 > 用户」的插件层，#752 R4；原「V1 第四个系统命令」表述随打包转移）——用户不经 agent 自由裁量直接触发生成，命令 handler 走 `{execute}` outcome 直达本插件工具（#752 R9，两条触发面一条执行面契约的落位）。与 agent 自动调用的关系：两条触发面、一条执行面；手动调用同样随会话 run 占并发名额。
- **回退形态**（若分钟级阻塞 UX 不可接受）：异步工具（立即返 figureId、完成以事件+附件出现）——留档不默认。

### 4.2 产物契约（Q9 核心）

- **工具结果 = figureId 引用**，不内联 SVG（含 base64 图标的 SVG 可达 MB 级，事件/消息载荷装引用）。结果负载进 #726 `attachmentsJson v1` 附件机制（类型 = figure 引用，含 figureId + 状态 + 预览可用性）；v2 定形：details（≤4KB，#752 R5）携带 `{figureId, state, previewReady}`（§7 数据流）。
- **对话内渲染**：前端经 `GET /api/v1/figures/:id/svg` 拉取，`<img>` 装 blob URL 渲染——SVG 经 `<img>` 加载时脚本不执行，安全面天然收敛；**禁止** innerHTML 直插 SVG。
- **下载**：同端点 `Content-Disposition: attachment`（或独立 `/svg?download` 参数）；PNG 预览端点保留。
- **持久化**：Figure 行只存 final SVG（`xml` 列语义改造）+ 预览 PNG + 元数据；template/optimized/icons 中间产物只在 graph 状态与事件流里 transient，不落库。
- **回放**：附件渲染走 #730 单管线渲染（实时 ≡ 回放，同一投影归约器）——工具结果图卡在会话回放中同样渲染。

## 5. run 与数据模型

### 5.1 Figure 行（保留 + 改造）

| 列 | 现状 | 换轨后 |
|---|---|---|
| `prompt` | text-to-figure 输入 | 保留（语义 = method_text） |
| `idempotencyKey` | REST 幂等键 | **退役**（REST 创建端点退役，§8；工具侧去重见 5.3） |
| `xml` | mxGraph XML | 语义改 **final SVG 文本**（列名是否改 `svg` 随实施迁移定，反正是空库直建） |
| `png` | PNG BLOB | 保留（预览 PNG） |
| `evaluation` | VLM judge JSON | 改存 **pipeline 元数据**（fix/optimize 迭代数、模型名、no_icon_mode 标记、渲染器标记） |
| 新增 | — | `sessionId String?` 溯源（thread 内生成可回链；null = 机器面/未来其他入口） |

归属门（`findFigureForUser` 70040 同码防探测）、admin 跨用户可见、`createdAt DESC, id DESC` 排序——**原样保留**（已验证资产；v2 不变，留核心）。

### 5.2 GenerationJob（退役）

状态机（queued/running/succeeded/failed CAS）、超时 sweeper、启动 reconcile、迟到结果围栏——全部由 run 域统一机制承载（会话 run 的终态/超时/恢复即 #722 runner 职责）；figures 域不自建第二套。工具调用失败语义 = 工具结果 error + figure run failed 记录（审计面）。

### 5.3 幂等与去重

REST `Idempotency-Key` 机制随创建端点退役。工具侧：同一工具调用的事务性重试（网络层重试、run 恢复重放）**不得重复生成**——去重身份 = 调用方 run 的 toolCallId（graph 执行记录天然携带）；实施时在工具包装层落实（同 toolCallId 重入 = 返回既有 figure 状态）。v2 落实注记（#753）：重入检测经 run 域既有机制（工具执行记录/checkpoint 包），figures 数据面**不加** toolCallId 列——去重身份活在 run 机制数据里，Figure 行保持产物聚合语义（§5.1）；呼应 `ctx.figures` 只有 create 单写方法（§11.1）。

### 5.4 配额与并发

figure 生成随会话 run 执行 → 自动占 per-user `maxConcurrentRuns` 名额（#731），**不开第二套配额**。云 API（fal/Roboflow）成本治理：V1 仅审计（调用量落元数据），不设限流（无产品拉动）。

### 5.5 事件族（v2 修订：progress 落 SSE，修 v1 与 wiki_run 先例的表面出入）

- **用户面**：阶段进度 = `figure_run.progress{toolCallId, stage}` SSE 事件（stage ∈ `generating | segmenting | preparing | templating | assembling | rendering`，对应 §3.1 六节点）；完成 = tool.end 结果 + details 附件引用。v1「figure_run.* 不落 SSE 用户面」表述**作废**——#747 §C 事件目录中 wiki_run.progress 即落用户面（debug 类不落），本修订坐实对齐关系；通用 `tool.progress` 事件仍归 V2（#752 §7 #726 接缝行）。
- **机器面/审计**：`figure_run.created` / `figure_run.stage_transitions` / `figure_run.completed{figureId}` / `figure_run.failed{reason}` / `figure_run.aborted` 落审计域（TextTrace 弱关联，traceId 关联会话 run），对齐 `wiki_run.*` 定位。事件形状定稿见 §11.2。
- **双面事实同源**：`figure_run.progress`（SSE 投影）与 `figure_run.stage_transitions`（审计记录）是同一阶段变化事实的两面——插件 execute 内经 `onUpdate({stage})` 上报一次，runner 同时落两面（#752 R6 事实同源不变量的域级形态）。

## 6. 凭证与 provider 接缝

| 调用 | 出口 | 凭证 |
|---|---|---|
| 模板生成 / fix / optimize（多模态文本） | **ProviderRegistry**（#731，ownerId 查询——figure run 有 ownerId；v2 经 `ctx.llm` 句柄，§11.1） | owner 的 per-user provider |
| 生图（步骤 1） | figure 域**面板级配置**（沿 `AUTOFIGURE_*` env 形态；生图模型市场碎片化且每图仅一次调用，V1 不扩 registry 面） | 面板 env（服务端注入） |
| SAM3 / RMBG（云 API） | fal / Roboflow | 面板 env（服务端注入） |

- **owner 无 provider 回退**：面板级默认 provider（figure 域配置，与生图配置同域）；无默认 → 工具返回明确配置错误（不静默换模型）。v2 落实：回退链封装在核心 `ctx.llm` 实现内（§11.1），插件不触碰 registry 查询逻辑。
- **registry 扩面预留**：真出现 per-user 生图需求时，ProviderRegistry 增 image-gen capability 面（chat + image 双能力出口）——本规格不实施。
- **数据出网**：用户描述与中间图经 fal/Roboflow 处理 = 第三方数据流。对齐 #728「V1 出网放行 + 审计」立场：调用量与目标记审计；产品文档明示。若产品要求零出网 → 回退 §9 本地重计算形态。
- 凭证纪律沿现行：env 注入、不落盘、不入日志、不进事件载荷/产物。

## 7. 前端面

- **`AutoFigureView` 退役**（含 `stores/autofigure.ts` 轮询逻辑；`api/figures.ts` 收缩为读/下载面）。工具是唯一生成入口——agent 自动调用与 `/figure` 手动命令两条触发面，生成体验完全在会话流内。**v2 修订**：能力可见性入口 = 插件目录页（插件系统管理面，#752 R8 REST）；figure 工具行/图卡经插件渲染注册——web.ts + `FigureCard.vue` 落 `plugins/autofigure/`（components/，#752 §1 单包双面）。
- **工具结果图卡**（ChatView 工具行扩展）：进行态 = 阶段进度（`figure_run.progress` 消费 + `isPartial` 装饰，#752 §2.4）；终态 = SVG 渲染（`<img>` blob URL）+ 下载按钮 + 失败态（稳定非敏感原因）。走 #730 单管线渲染。**v2 数据流（#753）**：details（≤4KB）携带 `{figureId, state, previewReady}` 引用形态；SVG 本体由组件经 `GET /figures/:id/svg` 拉取 blob——拉取是渲染层只读 IO（幂等、无独立状态），实时与回放同一代码路径，单管线约束不破：投影归约器仍是唯一数据流真相源。
- **Figure Editor（F2/F3）接缝**：编辑器经 figures API 读写 SVG（`GET/PUT /figures/:id/svg`）——[其侦察文档 §3](../figure-editor/reconnaissance.md) 已预留「优先复用 figures/files 能力」；编辑产物版本策略归 figure-editor effort 自定。生成→编辑闭环即：thread 内生成 → Figure 行 → 编辑器打开改 → 存回。
- 中间产物（template/optimized）不在前端暴露（未持久化）；「从模板重新组装」类高级操作不在 V1。

## 8. 退役清单（随新架构实施，另 effort）

**删除**：
- `deploy/autofigure-sidecar/` 全目录（vendored 原始版 `autofigure/` 包 + `service/` bridge + Dockerfile + T07/T08 契约 + UPSTREAM.md）；dev/deploy compose 的 sidecar 服务段。
- `server/src/figures/httpPort.ts`、`runner.ts`（状态机/sweeper/reconcile）、`assembly.ts`、**`port.ts`（v2 增补：AutoFigureGenerationPort 旧链路接口，v1 漏列）**；`service.ts` 幂等编排段（`createOrReplayFigure`/`FigureCreateTx`/幂等键路由件）。
- Prisma `GenerationJob` 表、`Figure.idempotencyKey` 列；REST `POST /api/v1/figures`（含 `Idempotency-Key` 头契约）。
- env（**v2 勘误**：实际存在四键）——`AUTOFIGURE_ENABLED` / `AUTOFIGURE_LLM_KEY` / `AUTOFIGURE_JOB_TIMEOUT_MS` / `AUTOFIGURE_SIDECAR_URL` 全数退役（v1 所列 PROVIDER/MODEL/BASE_URL 三键不存在，勘误）。新面板级配置随实施另定名（经插件 configSchema 声明，#752 §5），仍走 config.ts 单一来源。
- **AUTOFIGURE_ENABLED 退役裁定（v2）**：现行域开关（默认关，T01）随 sidecar 同窗退役——能力上线语义由 per-user `plugin_enablements` 承接（#752 §4.2），不并存、无迁移（零真实用户前提，#732）。
- 前端 `AutoFigureView.vue` + 路由 + nav 入口 + `stores/autofigure.ts` 写面。
- `docs/autofigure/` 票据史保留为历史档案（不删，标注 superseded 指向本文档）。

**保留（改造）**：Figure 表（§5.1）、figures 读路径（list/detail/svg/png + 7xxxx 码段 + 归属门）、`validation/schemas.ts` figures 段、config.ts figures 段（改读新配置；v2：figures 读面 + ctx 四件核心实现（§11.1）是 figures 域留核心的全部内容）。

**保留（不动）**：`deploy/` 其余、`legacy` 退役清单（#732）不含 AutoFigure 的既有裁定不变。

## 9. 风险与回退

| 风险 | 缓解 / 回退 |
|---|---|
| 云 API 依赖（fal 可用性/成本/配额/出网顾虑） | 计算 Port 保持可换（每个云步骤一个 Port 接缝）；回退形态 = 本地重计算 slim sidecar（SAM3-local + RMBG-2.0 + torch，无 LLM 凭证）——设计上不排除，实施不默认 |
| 分钟级同步工具调用阻塞 run（UX/超时） | 阶段进度流缓解等待感（v2：`figure_run.progress`）；回退形态 = 异步工具（§4.1）；run 超时语义随 #722 runner 统一机制 |
| prompt 移植保真（结构约定断链 → 步骤 5 替换失败） | 逐字移植 + golden-file 对照验收（§3.3） |
| resvg vs cairosvg 渲染差异影响 optimize 收敛 | golden-file 覆盖；必要时 sharp/librsvg 校准 |
| 生图模型碎片化/迭代快 | 面板级配置 + 模型名纯字符串显式配置（沿 -Edit 经验：换模型 = 改配置不改代码） |
| 插件接缝返工（ctx 形状随首个消费者校准） | v2 已随 #753 定稿（§11）；后续插件复用同形，差异经 ctx 扩面评审 |
| 工作量 | #724 教训（估计偏乐观 3–5 倍）适用：graph 移植 + 工具包装 + 数据迁移 + 前端图卡 + 退役五段，估 15–25 人日（×1.5–2 风险乘数）；实施拆分见 §10 |

## 10. 实施拆分（v2 改写 #753；另 effort，不属本 map）

时序原则（#749 Q2 分层解耦）：票 1/2/3 纯逻辑随 #747 先行（不等插件契约，产物可直接落最终家）；票 4/5 挂插件契约（依赖 #752 定稿 + M3 插件骨架，#749 Q14）。

1. **graph 移植票**：流水线 graph + prompt golden-file 对照（纯逻辑，可独立测）。产物落 `plugins/autofigure/`（server 面源目录直引，不依赖插件运行时）。
2. **计算 Port 票**：SAM3/RMBG/渲染 Port + fal 适配器（契约测试，无真 API）。同上落位 `plugins/autofigure/`。
3. **数据模型迁移票**：Figure 改造 + GenerationJob 退役 + figures API 收缩（svg 端点）。**留核心** `server/src/figures/`——不依赖插件契约，三票中最先行。
4. **figure 工具票**：manifest 工具注册（category=domain）+ execute 包装 + ctx 接缝接线（§11.1）+ `/figure` `{execute}` 命令注册（#752 R9）+ figure_run 事件族接线（§11.2）。依赖 1–3 + M3 插件骨架（Plugin API + 目录 + 启用模型）。
5. **前端图卡票**：web.ts + `FigureCard.vue`（落 `plugins/autofigure/components/`）+ 默认渲染回退 + `figure_run.progress` 进行态消费。依赖 4，走 #730 单管线。
6. **退役 PR**：sidecar 全目录 + env（§8 勘误后四键）+ compose 段（一次性，对齐 #732 T0 窗口原则——本域无双协议期）。

## 11. 插件接缝规格（v2 新增，#753 定稿）

AutoFigure = 官方插件目录首个插件（#749 Q9/Q16；插件契约总形 = #752 [docs/research/752](./752-plugin-system.md)）。本节钉插件与核心的挂接缝——#752 §9 开放点 1（ctx 服务句柄形状）与开放点 2（域 run 事件族形状）的定稿；目录/启用/渲染注册的通用契约不在此重复。

### 11.1 ctx 服务句柄（execute 上下文四件 + 装配身份）

```ts
// PluginToolContext 的 figure 消费形状（#752 §2.2「随首个消费者校准」的校准结果）
interface FigureToolContext {
  config: AutofigureConfig   // configSchema 解析后：生图模型/fal/Roboflow 键（#752 §5，env 形态沿 AUTOFIGURE_* 纪律）
  logger: Logger             // ctx 最小面既有
  run: {                      // run 装配注入——execute 签名（toolCallId, params, exec）无身份参数，
    ownerId: string           //   ownerId/sessionId/runId 全经此进（身份面单点，防插件隐式抓全局）
    sessionId: string
    runId: string
  }
  figures: {                  // 核心 server/src/figures/ 实现的落库面——终态一次性 create；
    create(input: {           //   GenerationJob 退役后 Figure 无状态列，单写方法即全写面
      prompt: string          //   method_text
      svg: string             //   final SVG 文本
      pngBytes?: Uint8Array   //   预览 PNG（渲染失败不致命 → 缺省 + meta 标记，§3.1）
      meta: EvaluationMeta    //   §5.1 evaluation 列语义：迭代数/模型/no_icon_mode/渲染器标记
      sessionId: string       //   溯源列（§5.1）
    }): Promise<{ figureId: string }>
  }
  llm: {                      // 核心 ProviderRegistry 出口的高层句柄
    generateMultimodal(opts: …): Promise<…>
                              //   owner 无 provider → 面板默认 → 明确报错（#744 §6 回退链
                              //   封装在核心实现，插件不碰 registry 查询逻辑）
  }
  audit: {                    // TextTrace 弱关联审计面（traceId 关联会话 run）
    emitFigureRun(event: FigureRunAuditEvent): void   // 形状见 §11.2
  }
}
```

- **接缝 vs 直引**：四件全是副作用面（DB/LLM/审计/装配身份），经 ctx 注入（可测接缝，#752 §2.2）；插件内纯逻辑（graph 节点/坐标组装/golden-file 对照）零接缝直写。直接 import server 模块不被禁止（#752 §2.2），但 figure 域触核心只经此四件——files 域 fsPort/沙箱 exec/凭证面无直连口（#752 §2.2 既有边界）。
- **配额/并发**：无独立句柄——figure 生成随会话 run 自动占 per-user `maxConcurrentRuns`（§5.4），run 域统一承载。

### 11.2 figure_run 事件族（形状定稿）

| 事件 | 面 | 载荷 | 落点 |
|---|---|---|---|
| `figure_run.progress` | **SSE 用户面**（对齐 wiki_run.progress 先例） | `{toolCallId, stage}`，stage ∈ §5.5 六值 | SSE 事件目录（#747 §C 增补） |
| `figure_run.created` | 审计 | `{toolCallId, methodText 截断}` | TextTrace |
| `figure_run.stage_transitions` | 审计 | `{toolCallId, from?, to, at}`——与 progress 同一事实的审计面 | TextTrace |
| `figure_run.completed` | 审计 | `{toolCallId, figureId, iterations, durationMs}` | TextTrace |
| `figure_run.failed` | 审计 | `{toolCallId, reason 稳定非敏感}` | TextTrace |
| `figure_run.aborted` | 审计 | `{toolCallId, by}`——会话 run aborted 联动（exec.signal 传播 + 插件 catch 落终态） | TextTrace |

- **翻译链**：插件 execute 内经 `onUpdate({stage})` 上报（#752 §2.2 签名）→ runner 同时发 `figure_run.progress`（SSE）与落 `figure_run.stage_transitions`（TextTrace）——双面事实同源（#752 R6 的域级形态）。
- 用户面进度只此 progress 一类；debug/中间产物不落任何面（#747 wiki_run debug 先例）。

### 11.3 启用语义（#749 Q16 / #752 §4.2 的域级落实）

- 默认未启用；owner 目录一键启用 → `plugin_enablements` 行（ownerId+pluginId 复合主键）；run 装配静态过滤 tools/commands/promptSnippet。
- 禁用后：新 run 不见 figure 工具/`/figure` 命令；进行中 run 不中断（per-run 快照）；历史回放不受影响（details 自带渲染数据，#752 §2.4）。
- 启动期 env 校验不看启用位（#752 R7）——任何用户随时可启用 = 面板永远备好生图/fal 配置。

### 11.4 物理落位总表

| 件 | 落位 |
|---|---|
| manifest.ts / server.ts（execute 包装）/ graph.ts / 计算 Port / golden-file 对照 | `plugins/autofigure/`（server 面源目录直引，#752 R1） |
| web.ts / FigureCard.vue | `plugins/autofigure/`（components/） |
| Figure 表 / figures API（读/下载/SVG）/ 归属门 / 7xxxx 码段 | 核心 `server/src/figures/` |
| ctx 四件核心实现（figures 落库 / llm 出口 / audit 面） | 核心（`server/src/figures/` + ProviderRegistry 域 + TextTrace 域） |
| plugin_enablements / 8xxxx 段 / 目录与启用 REST | 核心（#752 §4.2/§4.3） |

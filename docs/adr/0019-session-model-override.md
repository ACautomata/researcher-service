# ADR 0019: 会话模型覆盖——快照生效语义与生效域边界（#925 图 B2 #932 · B4 #934）

日期：2026-10-15 ｜ 状态：已接受（决策定稿，施工未开）｜ 关联：#925、#931、#932、#934、[ADR 0016](0016-plugin-llm-assignment.md)（热生效相邻语义）、[ADR 0017](0017-llm-endpoint-presets-byok.md)（端点预设制）、[ADR 0020](0020-reasoning-effort-tiers.md)（effort 档位语义）

## 背景

对话级模型选择的现状唯一先例 = `/model` 斜杠命令写 `Session.preferredModelJson`（per-session，run 启动快照，`runService.resolveModelSelection`）；无 per-message 覆盖。wayfinder #925 图引入 composer 模型菜单 + 推理强度滑块（UI 形态归 #933 变体 C 定稿，档位映射归 ADR 0020），生效语义若不在此钉死，实现就会在 per-message / 两级制上发明新机制，与图模型构造期绑定的运行时形态冲突。

## 决策

1. **生效语义 = per-session 持久覆盖**：`preferredModelJson` 扩为 `{providerId, modelId, effort?}`（effort 词汇与映射规则归 ADR 0020）。run 启动快照、下一 run 生效、在飞 run 持旧快照跑完——与 ADR 0016 插件 LLM 指派热生效同一机制（配置变更 bump 版本，下一 run 重建快照），不发明新形态。拒绝 per-轮次覆盖与两级制：图模型构造期绑定（graphFactory「拓扑必须可由持久化状态推导、绝不允许运行期可变闭包」红线）、各家 per-call effort 能力不齐、图缓存抖动。历史无 effort 旧行读面宽松接受——运行层不注入（行为与今日逐字节等价），该行下次经菜单任何写自动补齐。

2. **双入口同真源**：`/model` 斜杠命令与 composer 菜单读写同一持久化状态；收敛同一 zod schema（`validation/schemas.ts` 单源）+ service 写路径单点（sessions 事务内 `tx.session.update` 抽共享 helper，斜杠与 REST 同点写）。菜单「默认」项 = 清空覆盖（JSON 置 null），与 `/model default` 同语义。v1 effort 无命令入口（滑块唯一入口，免 parser/校验双份维护）。

3. **接口面（登记 `openapi/paths.ts`，apiDocsCoverage 双向守卫红线）**：
   - 写 = PATCH `/sessions/{id}` 扩 `preferredModel` 字段（`{providerId, modelId, effort?} | null`，null = 清空；既有登记改 body schema 与 summary，不开新路径）。
   - 读 = 会话投影（列表/详情）暴露解析后的 `preferredModel`——composer 刷新/切会话恢复 chip 与滑块态（现状 `summary()` 不含此字段，缺口补齐）。
   - 模型清单 = 新只读端点 `GET /api/v1/models/available` 下发 `{providerId, modelId, name, capability, effortNote}`——能力元数据与映射注记由 presets.ts 单源服务端下发，前端零映射表副本（防漂移）；BYOK 第三方模型按默认 native 生成注记。复用 `GET /models/providers`（BYOK 管理面，缺平台虚拟条目）已否决。
   - SSE 零新增事件类型——写后广播沿用既有 `session.updated {model, appliesTo:'next-run'}` 形状，多标签/斜杠命令经订阅同步。
   - 否决复用消息通道：`executeSystemCommand` 恒建可见 `/model …` user message 行，菜单静默切换不该留消息痕迹。

4. **workflow fence = 装配点结构性隔离（非运行时判定）**：会话覆盖唯一消费点 = leader 图装配（`runService.getDefaultModel(snapshot, preferred)`）；模型实例缓存键 `modelKey` 并入 effort——同 session 换档不命中旧图（B1 硬坑②的免费修法）。插件/research_workflow 域模型解析走 ctx.llm 链（env pin > 用户指派 > 默认链，`llmToolPort.ts`），代码路径从不读会话覆盖——结构性异源，零运行时 if（运行期可变判定违拓扑可推导红线）；workflow 以 leader 图内 subagent 形态执行时以 deepagents `SubAgent.model` 显式钉默认链、不继承覆盖。teammate 通道（含 wiki-update 治理 run）维持既有契约「`modelProviderId` 缺省 = 随 leader 模型」——随 leader 覆盖（含 effort）不算 fence 违例，本决策不扩大 fence 至 teammate 通道。fence 锁测试：会话覆盖变化不改变 workflow 侧装配产物。

## 后果

- composer 刷新/切会话从投影恢复状态；双入口互通由同真源 + SSE 订阅保证，无独立同步机制。
- 默认态（覆盖为空）无单一映射对象——默认链 primary 随用户端点配置浮动，前端不可知也不稳定，滑块置灰（呈现规格归 ADR 0020 四态可视）。
- 注入通道改动点清单（B1 盘点 8 处）以 #931 Resolution 评论 + 代码重建为准——findings 分支 `research/b1-reasoning-effort` 已丢失，勿当权威。
- 附件按钮内移不属本决策——纯 DOM/CSS、门语义零改动（置灰条件/草稿指纹/粘贴拖拽/data-test 原样），归 #934 交接规格。

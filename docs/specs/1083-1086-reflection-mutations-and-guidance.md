# #1083 / #1086：反思变更与 Leader 指引验收

## 已确认事项

- 用户明确要求 #1083 与 #1086 一起实施、一起测试和提交，使用一个 PR。
- 两票已确认由代理决定实施拆分；#1083 采用真实 SQLite 公共业务口与并发屏障，#1086 采用真实 RunService/图 + ScriptedChatModel。
- 依赖 #1082 已合并；本次审查基线是 `636fcfb`。原工作区 GLOSSARY 与未跟踪规格资料保留，不纳入本次提交。
- 生产工具仍等待父规格完整门禁；本次不发布、不部署、不运行收费模型评测。

## 行为与边界

`draft.targets` 指定 record_id/version，服务端冻结 generation、状态和结构化证据 hash。`revise/review` 保存同 record 的新 revision；`replace/merge` 分配新 record 并将源记录置为 superseded。替代目标永远由服务端新建，源记录不可再次作为替代目标，关系保持无环。

完整操作（动作、目标基准、五部分正文、去重后的原始来源）进入展示 hash。聊天显示目标与影响，完整渲染后 ack；只有之后的真实用户自然语言确认能形成授权。签授权及提交均在短 SQLite 事务内复核目标和原始产品消息，冲突只返回差异，不改写已确认版本。来源失效的记录不能合并洗白；review 需剩余/补充原证据重新展示确认。

历史草稿证据只接纳当前会话或本轮 session_history read 实际交付的本人主线程稳定消息。search 节选、截断和未完整分段不授予这种来源能力。旧记录的结构化证据继承仍逐条追溯原消息；子助手不继承历史/反思工具与 Leader 指引。

Leader 指引版本由 `REFLECTION_GUIDANCE_VERSION` 定义；图缓存包括核心工具集、Leader 能力与指引版本。执行身份、signal、主请求额度和实际历史来源绑定于运行上下文，不捕获进缓存。

`reflection_episodes` 仅存 hash 与引用：同主请求、类别、规范化问题、原始证据版本、目标集复用同一草稿。完成标记涵盖无新教训的请求，模型/图重建时不重置。规范化去重不等于同义语义去重，换词循环还由固定指引与分析评测约束。

## 验收接缝

| 范围 | 自动验收 |
|---|---|
| RF07/RF10/RF13 | `reflectionsMutations.test.ts`：同 record 新版本、旧版本管理读取、两会话同基准冲突、合并单源变化整体失败、重复提交、失效源与补证复核及旧来源不误伤新版本、去重/来源关系、独立连接屏障、墓碑 generation、替代环与 8 目标上限 |
| RF09/RF11/RF22/RF23、G7–G9 | `runnerReflectionAnalysis.test.ts`：失败→真实历史 search/read→草稿/present→原任务继续；无新教训；证据不足；旧经验冲突；子助手非法工具错误回喂 |
| 完整动作呈现 | `reflectionBlock.test.ts`：所有合并来源 ID/版本、操作影响与正文在 ack 前完整渲染 |
| 恢复 | `reflectionsMutations.test.ts` 重建 runtime 后复用 episode，新证据版本可产生新草稿；图测试验证无新教训完成标记持久化 |

## 真实模型评测

固定集：`server/test/fixtures/reflection-analysis.json`，30 案例，每例计划运行 3 次。六类过程问题以及证据不足、截断、注入、旧经验冲突、无需新增、模型切换、源失效和原任务推进均有评分锚点。

当前状态 **not_run**。ScriptedChatModel 证明协议、授权与任务推进的可观察路径，不证明真实模型的语义判断质量。发布时记录实际 provider/model、prompt 版本、采样参数、每次输出与具名人审五维分数；至少 90% 达到 8/10 且证据支持=2，虚构证据、越权保存、秘密泄漏、主动使用失效经验必须为零。父规格其他门禁仍由后续发布票统一汇总。

## 验证记录

- server typecheck/build 与 frontend 全量 1001 项测试/build 通过。
- server 全量已运行；宿主回归 2134 项通过。最后补充的 revision 隔离修复已通过 51 项相关回归。为避开当前 Docker CLI 在 daemon 不可达时仍返回 0 导致的旧探测误判，宿主测试显式排除五个 `*Smoke.test.ts` 文件单独验证。
- 真实 Docker 额外完成 sandbox（5）、archive backend（4）、wiki container（5）、background exec（3），共 17 项通过。既有 wiki/docs（2）受 Docker Hub 拉取 Debian 基础镜像元数据超时阻断，不记为通过。
- Standards / Spec 双轴复核未解决项均为 0；审查发现的根证据继承、容量限制、元数据恢复故障停止增强及重复幂等逻辑已修复。

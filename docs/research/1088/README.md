# #1088 反思验收与发布交接

## 已确认事项

- 用户要求按 implement 技能完成 #1088 的实现、验证、双轴审查并提交当前分支。
- 接缝沿 #1088 / #1076：公开业务口、真实 SQLite、真实只读子进程、真实 RunService/图、聊天组件；模型与确认分类器可在离线接缝注入。
- 早期版本由用户指定语义审阅者为 **jrz** 并跳过真模型评测；本轮用户明确改为 **由 Claude Code 代评**，并授权使用平台 DeepSeek 凭证完成真实模型采样。AI 代评是验收方案变更，**真人审核未执行**；不冒用 jrz 或任何真人署名。
- 真实采样使用 `deepseek-v4-flash`（provider 返回版本 `deepseek-flash`），固定 temperature=0、thinking=disabled；确认集 v2 180/180、分析集 90/90 均有执行记录（分析集 7 样本因递归上限提前失败）。最终授权总预算 1200 次请求，最终正式请求 660 次（确认 180 + 分析 480）；另含确认 v1 180 次与 12 次定向 pilot，总观测约 852 次，仍在授权内。
- 两个工具保持生产不装配；本次没有部署、灰度、合并或关闭 #1088。确认集 v2 已通过；分析集质量/零容忍门禁未通过，详见 [model-eval/README.md](model-eval/README.md)。

## 当前结果

用户授权范围内的离线验收已完成：30 个分析场景真实状态构造、118 个矩阵编号的运行证据、跨会话完整链路、浏览器交互、真实 Docker/Redis 人工冒烟、128 MiB 合成历史清理测量。最终测试数量与报告指纹见 [validation.json](validation.json)。

真实模型评测已在 [model-eval/](model-eval/) 执行并由 Claude Code 逐项 AI 代评：确认集 v2 正例 60/60=100%（门槛 ≥95%，通过）、非授权误签 0；分析集 72/90=80.00% 达到总分≥8且证据支持=2（门槛 ≥90%，未通过），另有 7 个递归上限失败样本与 AN-29 的 3 个 `secret_leak`。确认集 v1 的 50/60=83.33% 失败报告保留为历史；生产开放门禁因分析集仍关闭。早期 [confirmation-results.json](confirmation-results.json) 与 [analysis-results.json](analysis-results.json) 的 `not_run` 保留为历史记录，不改写为已执行。

历史矩阵快照 [history-matrix.md](history-matrix.md) 与反思矩阵快照 [reflection-matrix.md](reflection-matrix.md) 逐行合计 118 个编号。[coverage.json](coverage.json) 关联具名测试及实际 Vitest 断言、原报告 SHA-256。编号映射只证明测试运行，不代替模型语义和 AI 代评。

## 离线状态与业务链路

`server/scripts/acceptance/reflection-fixtures.ts` 为每个分析场景创建独立临时 SQLite，通过公开流程构造旧经验、相互冲突经验、真实来源变更失效、截断工具输出、其他用户/teammate 禁止来源、已完成 analysis episode 与运行时重开状态；30 项均有实际测试。输出保留来源 region、toolCallId、授权及截断属性；检查器拒绝越权、截断、不匹配引用和未确认正式写入。

真实 RunService/图与 SQLite 的 RF24 覆盖历史 read → >4KiB 全文草稿 → present → recordTurn → 全文 ack → 自然确认 → commit → 新会话 search/read → 修订 → 合并 → 来源失效 → 硬删 → 回放占位。浏览器发现并修复同轮在飞证据绑定后正文哈希陈旧问题：只刷新尚未绑定产品消息、尚未确认的有效展示，旧哈希 ack 必须失败。

## 浏览器与容器人工冒烟

[浏览器证据](evidence/browser-workflow.json) 与 [容器证据](evidence/container-workflow.json) 保存实际会话/记录/展示 ID、版本、ack 与最终状态。两轮均执行：

1. 读取合成历史失败，展示 >4KiB 完整正文，绑定同轮待落库证据。
2. 页面完整渲染后 ack，自然语言确认保存。
3. 新建会话，检索/读取刚保存经验并继续原任务。
4. 修订第一条、创建第二条，分别展示、确认。
5. 合并两条，确认后核对来源记录退出主动使用。
6. 删除来源会话（级联删除原始消息），立即封锁，刷新页面重验失效状态。
7. 展示硬删边界、确认删除合并记录，刷新后仍是无正文占位。

容器轮控制面运行于 `panel-server:dev` 基础镜像挂载当前编译代码，真实 Redis/BullMQ 派发、真实 Docker sandbox/wiki 生命周期；全部临时合成账户和数据库。模型共 32 次脚本响应，真实模型调用 0 次。宿主轮作为隔离调试证据，容器轮作为实际编排证据。当前基础镜像缺少的依赖只装入临时容器，没有发布镜像或修改生产配置。

![容器验收删除后回放](evidence/container-replay.jpg)

截图中的长正文是有意构造的长度测试样本，不是模型生成循环。现已使用编号合成段落，测试页面顶部显示黄色「仅合成数据 · 脚本模型 · 未调用真实模型 API」标识；该标识只在显式启用的 Vite dev 验收环境出现。

## 清理资源与恢复边界

工具输入副本按可信 `(owner, thread, toolCallId, draftId, version)` 绑定清理，保留无正文墓碑；迟到 checkpoint、pending writes 和产品写入在同一事务查询墓碑。模型边界每轮过滤失效/已关闭反思参数，增强不可用时仍脱敏并继续主任务。普通用户文本及合法 bytes 不变，schema 维持 25。

兼容旧数据先在 SQL 按 owner、专属工具标识和 draft/call 引用预筛选，再解码候选行；调用 ID 与所属 thread 绑定。两阶段检索由旧工具结果发现 callId，补清首结果之前尚无 draftId 的输入快照。无关同用户不透明历史不再被解码。数据库仍需检索候选，不能据本次测量承诺任意规模容量。

[资源测量](evidence/cleanup-benchmark.json)：128 个无关 1MiB checkpoint、两个同用户会话；真实公开 cancel 事务清除目标副本并读取验证，耗时约 747 ms（阈值 2000 ms），堆增长约 2.15 MB。此为本机合成数据测量，无模型调用。

## 可复现验证

```bash
cd server
npm run typecheck
DOCKER_HOST=unix:///Users/jrz/.colima/default/docker.sock npm test -- --reporter=json --outputFile=/tmp/rf-server.json
npm run build
npx tsx scripts/acceptance/reflection-cleanup-benchmark.ts /tmp/rf-cleanup.json
cd ../frontend
npm run test -- --reporter=json --outputFile=/tmp/rf-frontend.json
npm run build
cd ../server
npx tsx scripts/acceptance/reflection-coverage.ts /tmp/rf-coverage.json /tmp/rf-server.json /tmp/rf-frontend.json
```

结果文件拒绝覆盖，请使用新路径。Docker socket 按实际环境调整。人工容器冒烟用 `server/scripts/acceptance/run-container-smoke.sh`（要求本地 Docker 与 panel-server:dev，脚本不属于自动测试依赖）；它输出临时账号及前端启动方式，退出时保存报告并清理自身资源。前端显式设置 `VITE_ACCEPTANCE_FIXTURE=1` 并将 API 代理指向冒烟端口。脚本模型与真实模型质量评测严格分开。

## 真实模型与 AI 代评

本轮按用户显式授权执行真实模型采样，并以 **Claude Code（deepseek-v4.1-flash）** 代评；原规格的具名真人审核未执行。方法、逐项理由、门禁与偏差说明见 [model-eval/README.md](model-eval/README.md) 与 [analysis-scoring-rubric.md](model-eval/analysis-scoring-rubric.md)。

命令（只读取显式环境变量；不自动 source deploy/.env；密钥不进入日志/提交）：

```bash
cd server
RF_EVAL_API_KEY=… RF_EVAL_MODEL=deepseek-v4-flash RF_EVAL_BASE_URL=https://api.deepseek.com \
RF_EVAL_PROTOCOL=openai RF_EVAL_THINKING=disabled RF_EVAL_MAX_REQUESTS=600 \
npx tsx scripts/acceptance/reflection-model-eval.ts confirmation /tmp/rf-confirmation.json
RF_EVAL_MAX_REQUESTS=900 npx tsx scripts/acceptance/reflection-model-eval.ts analysis /tmp/rf-analysis.json
npx tsx scripts/acceptance/reflection-eval-check.ts confirmation ../docs/research/1088/confirmation-cases.json /tmp/rf-confirmation.json
npx tsx scripts/acceptance/reflection-eval-check.ts analysis test/fixtures/reflection-analysis.json /tmp/rf-analysis.json
```

固定 temperature=0、thinking=disabled（否则 DeepSeek 忽略 temperature）、输出上限确认 500/分析 6000 tokens、请求 120 秒、分析 recursionLimit=20、每例三次；`reflectionEvalHarness.ts` 在 fetch 边界验证实际报文参数并硬计数预算，错误/缺失样本保留在原分母。逐项评分覆盖全部 270 个样本；确认集 scores 为空数组，分析集五维 0–2 并另记 `dispositionMatched`。分析至少 90% 总分≥8 且证据支持=2；确认正例≥95%、非授权误识别 confirm=0；虚构证据、越权保存、泄密、主动使用失效经验任一项阻断。不能用字符串命中或外部 LLM judge 代替评分主体；完整评分后才改 `reviewed`，再由检查器校验指纹、唯一采样、元数据、评分与副作用。

结果：确认集 v2 60/60（100%）通过 ≥95%，非授权误签 0（v1 50/60 的失败保留为历史）；分析集 72/90（80.00%）未达 90%，且 AN-29 3/3 记录 `secret_leak`、7 个样本因递归上限未完成。分析集门禁仍未通过；生产装配保持关闭。AI 代评不能消除同族评分偏差，结论不等价于独立真人审核。

## 灰度、失败关闭与数据保留回滚

1. 发布候选版本必须固化 commit、prompt/fixture 指纹、实际 provider/model/version/采样参数、逐项测试运行证据和具名评测；任何缺项保持当前未装配版本，不能以环境变量或用户开关绕过。规格/任务发布不执行部署。
2. 全部门禁通过后另一个固定版本提交同时装配 history 与 reflections，不得只开其中一个。首批观察主任务完成率、确认失败/误签、查询超时/取消和槽回收、失效封锁/硬删回放；记录时间、观察者与实际结果。目前未灰度。
3. 出现任一零容忍项立即停止该开放版本，回到本票这种不注入两个工具的装配；查询/确认故障不得终止原任务，也不得自动授予新额度或授权。
4. 回滚保留数据库、记录ID/generation墓碑、安全日志、来源失效/outbox与清理逻辑。不得回退到不认识当前 schema 的旧二进制、还原旧正文或清空墓碑。若需数据库恢复，严格执行 `docs/research/1087/recovery-validation.md` 的停写水位、独立日志和清理重放门禁；不具备权威日志时继续关闭。
5. 验收材料只使用合成数据；凭证不进入日志与版本库。实际模型的留存与用户自行复制/导出不在专属硬删范围，删除前继续说明既有边界。

## Server

类型检查、构建通过。本轮最终全量 **198 文件、2221 项：2220 通过，1 项既有 sandboxSmoke OOM 容器存活断言失败**（不是本轮反思功能回归）；该文件独立复跑 5/5 通过。全量运行不记为整轮绿灯，报告 SHA-256 与复跑指纹见 validation.json。新增 `reflectionConfirmation.test.ts` 动作确认覆盖、`reflectionEvalHarness.test.ts`（报文参数/预算/版本采集）与 `leasedProcessPool.test.ts`（已退出子进程 dispose 回归）；累计修复确认识别 prompt/harness、评测脚手架与只读进程池 teardown 缺陷。历史/反思 118 个编号的映射断言全部通过。真实 Docker smoke 使用本机 Colima socket。退役扫描只枚举 Git 跟踪及未忽略的新文件，避免用户嵌套 worktree 和忽略的运行产物干扰全仓检查。

## Frontend

85 个文件、1003 项全量测试和构建通过，全文组件新增哈希刷新 ack 回归；浏览器验证完整交互、失效刷新及硬删后缓存/回放占位。

## Standards

双轴复审已完成。异常清理采用两层 finally，线程限定 SQL 调用标识；最终无剩余确定问题。评测脚手架新增请求级参数/预算/版本护栏；修复只读进程池在子进程已退出时 dispose 永久挂起（已补回归）。

## Spec

离线与容器验收有实测证据；真实模型采样与逐项语义评分已按用户变更后的方案由 Claude Code 完成。确认集 v2 已通过（60/60，误签 0；v1 83.33% 失败保留为历史）；分析集 80.00% <90%，且有 3 个 `secret_leak` 与 7 个递归上限失败，分析门禁未通过。AI 代评替代原具名真人审核的差异已显式记录，不宣称原规格全部满足。Standards 0 项；生产工具继续关闭，未部署、未灰度、未合并、未关闭 #1088。

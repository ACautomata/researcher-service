# ADR 0017：LLM 端点预设、BYOK 与用户模型归属

日期：2026-10-09 ｜ 状态：已接受 ｜ 关联：#880、#881–#886、[ADR 0016](0016-plugin-llm-assignment.md)、[插件契约 §5](../research/752-plugin-system.md#5-配置面)

面板原先共享一把模型 key，用户不能自主承担费用或选择插件模型，自由地址又要求部署方维护安全策略。本决策汇编 #880 终态，supersede #731 端点双层设计，并收口 ADR 0016 的后续计划。

1. **BYOK 凭证加密激活**：AES-256-GCM v1 信封保存用户 key，生产 `LLM_CREDENTIAL_SECRET` 必填（≥32 字符）；写明文单向入库，读只出掩码，错误标 key_error，运行时解密失败拒绝调用。cipher NULL 使用平台 key——**限平台预设端点**：非平台预设新建/试连须自带 key（写侧 90002、试连 90003 拒绝），防平台 key 外发第三方服务商地址；存量迁移行不受影响，运行时悬挂回落语义不变。平台默认端点由 `LLM_API_KEY` + `LLM_PRESET` + 可选 `LLM_MODEL` 派生，不落库、不建用户种子。V1 无轮换机制，丢失密钥须用户重新提供 key。
2. **端点白名单退役与预设制**：表、admin 页/REST、CRUD/运行时双层校验、fetch origin 复验、DNS 私网拒绝与逃生开关整链删除。40042 保留防复用；90002 仍是通用字段校验码，旧放行语义退役。六预设 MiniMax/Anthropic/OpenAI/DeepSeek/Kimi/智谱锁定协议与地址，无自由 baseURL，从输入构造上消除任意地址 SSRF 面。预设变更随版本评审，有意牺牲自建 vLLM；文件路径与审批规则的名单不受影响。
3. **judge 端点归属链**：部署级 RUNNER_JUDGE_* 配置退役。本人显式 judge 指派 → 用户默认链 primary → 平台默认；悬挂引用直接回平台并告警。温度固定 0，端点故障或无有效判定 fail-closed 升级人工，不放行；token 留审批审计面，不入 llm_usage_records。
4. **插件 V2 提前**：amend #752 §5，仅提前 per-user 插件 LLM 指派，一般 per-user 配置仍留 V2。manifest llm 声明自动入指派 UI，judge 是保留键；owner+plugin 指派与版本 bump 同事务。核心构造 per-plugin ctx.llm，凭证不交插件。会话/teammate/插件/judge 共用 run 启动快照，变更下一 run 生效，悬挂引用回平台并告警。
5. **AUTOFIGURE_SVG_MODEL 退役路径**：保留兼容 pin，设值启动告警，优先于用户指派再默认链；pin/显式目标失败报错不降级。部署方先清除 pin 改用模型配置页插件 LLM 指派，物理删除留独立兼容退役版本（#884 未删除）。生图与 fal key 仍由平台提供。
6. **试连滥用接受面**：登录用户可做不入库、无日志、1-token 级、10s 超时、错误净化的试连。V1 无专用限流，重复请求仍可能消耗用户或平台额度，接受此风险；超时与最小输出不构成配额防护，后续限流独立评估。

v15→v16 按域名归一旧端点，未知域名丢弃并告警，旧行 cipher 统一 NULL。升级先备份 SQLite 与加密根，降级需恢复数据库备份。默认链按端点创建序取各自首模型、平台垫底，/model 下一轮生效语义不变；用量按 providerId（含 platform）分账。

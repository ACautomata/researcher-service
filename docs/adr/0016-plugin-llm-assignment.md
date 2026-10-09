# ADR 0016: 插件 LLM 指派——per-user 配置项从 V2 提前（#883）

日期：2026-10-09 ｜ 状态：已接受 ｜ 关联：#880（model provider 重构）、#881（T1 预设制）、#883（T3 本票）、752 §5（插件系统配置面）、#744 §6（figure LLM 回退链）

## 背景

插件系统规格（752 §5）把 per-user 插件配置列为 V2（「随第二个需要它的插件启动」）。
#880 的产品叙事把它提前：每个声明 LLM 需求的插件——含审批判定器（judge）——都应可被
用户单独指派端点与模型，缺省跟随默认链；否则插件所需模型只能靠部署方 env 钉死，
用户对自己工作流的模型零自主权。

## 决策

1. **manifest `llm` 声明位（V2 提前的载体）**：`PluginManifest.llm = { description,
   defaultModel? }`，纯目录元数据（声明即入指派 UI）；未声明插件的指派写侧拒绝。
   运行时解析行为不进 manifest——封装在核心 ctx.llm 解析器。
2. **指派存储 = plugin_llm_assignments（#881 T1 建表备用，本票启用）**：复合主键
   ownerId+pluginId；pluginId 含保留键 `'judge'`（审批判定器指派行；撞键插件目录
   启动 fail-fast）；providerId NULL = 跟随默认链 / `'platform'` = 钉平台 / 其余 ∈
   用户端点集；modelId 须属该端点模型集（平台侧取值域 = platformModelIds env 派生）。
3. **热生效沿用既有版本机制**：指派 mutation 与 config_meta version bump 同事务——
   run 启动快照载入指派集，下一 run 生效；在飞 run 持旧快照不受影响（与端点 CRUD
   同一语义，无新机制）。
4. **ctx.llm 变 per-plugin 解析器**：优先级 = env pin（AUTOFIGURE_SVG_MODEL，标废弃、
   设值启动告警）> 用户指派 > 默认链。指派 = 单目标语义（调用失败明确报错不降级——
   不静默换模型，降级出产 = 产物非指派模型）；悬挂回落平台默认 + 告警。工具名→插件 id
   经运行时目录派生（toolOwnerByName），agent 自动调用与命令 {execute} 直达两路穿线。
   凭证永不下发插件。
5. **env pin 退役路径**：AUTOFIGURE_SVG_MODEL 键保持生效（兼容面），manifest 标
   `deprecated: true`——设值启动告警引导用户改走指派；物理删除随 judge 执行面票收口。

## 后果

- 插件作者只需在 manifest 声明 `llm`，无需改前端即入指派 UI（#880 story 18）。
- 指派校验在写侧一次做完（端点 ∈ 用户端点集 ∪ 平台、模型属端点集），运行时只处理
  悬挂回落——存量悬挂行是配置变更后的常态数据，快照载入不拒载。
- 试连端点滥用面、judge 执行面消费指派行、env pin 物理删除：均留待后票（#880 时序）。

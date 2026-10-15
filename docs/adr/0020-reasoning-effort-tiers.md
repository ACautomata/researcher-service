# ADR 0020: 推理强度统一三档——公共子集词汇与 per-model 映射（#925 图 B2 #932 · B4 #934）

日期：2026-10-15 ｜ 状态：已接受（决策定稿，施工未开）｜ 关联：#925、#931、#932、#934、[ADR 0019](0019-session-model-override.md)（覆盖存储形态与消费点）、[ADR 0017](0017-llm-endpoint-presets-byok.md)（presets.ts 预设单源、随版评审）

## 背景

B1 盘点（#931 Resolution）：六家 2026 模型线全有 effort 语义但形态不一——中国系收敛 `reasoning_effort` 三档 low/high/max，Anthropic `output_config.effort` 五档，OpenAI `reasoning_effort` 模型相关七值；本仓六预设仅 anthropic / gpt-5.1 / deepseek-v4-flash 三家原生可调，MiniMax-M3 / GLM-4.6 仅 thinking 开关，kimi-k2 无通道。统一滑块需要一个不随 provider 漂移的档位词汇与翻译层，否则每接一家模型就要重造一套 UI 档位。

## 决策

1. **统一三档规范词汇「简洁 / 标准 / 深思」，存储词汇 `effort: 'low'|'high'|'max'`**（`preferredModelJson.effort`，注入层按映射表翻译）。拒绝统一五档/连续档——对三档 provider 是假精度；拒绝 per-model 自造档位名——规范词汇唯一，翻译只在注入层发生。

2. **per-model 映射表落 presets.ts 元数据（单一来源），能力三值 `native | thinking-only | none`**：deepseek-v4-flash 1:1 直传；anthropic / OpenAI 就近映射（Anthropic effort 五档 / OpenAI reasoning effort 七值）；MiniMax-M3 / GLM-4.6 thinking-only 降两档（简洁=思考关、标准/深思=思考开）；kimi-k2 = none（无通道）。能力与映射注记经 `GET /api/v1/models/available` 服务端下发（ADR 0019 接口面），前端零映射表副本。BYOK 第三方模型无逐模型元数据，**默认 native**——effort 注入走 `modelKwargs`（`ChatOpenAI.isReasoningModel` 前缀门只认 o*/gpt-5*/gpt-6*，挡第三方兼容模型的一级通道——B1 硬坑①），调用报错由用户回退滑块自愈；默认 none 会把多数 openai 兼容推理模型的特性埋没，已否决。

3. **写入规则（「选模型即带档」）**：effort 须随模型覆盖写入——菜单选中模型即写当前滑块值（滑块会话内初值 = 标准；切模型不改滑块值，落库按能力裁剪：none → omit effort）；能力 none 的模型带 effort 写侧拒（zod super-refine 按 presets 能力表，90002）——UI 置灰本就产不出，写侧校验是双保险。schema 保留 `effort?` 可选仅为兼容存量行，新写入恒带档，不新增第四视觉态（「未设定」态已否决——进度底色语义失基准、测试面翻倍）。

4. **四态可视与注入通道**：MiniMax/GLM 注记（「标准 · 深思＝开」）、kimi 置灰 + tooltip、anthropic/OpenAI 就近映射注记、deepseek 1:1 注记的 UI 呈现规格与 composer C 形态归 #934 交接规格（#933 原型定稿为实物基准）；注入通道改造以 #931 Resolution + 代码重建清单为准。外部事实（#931）：`ChatOpenAI.reasoningEffort` 已标 deprecated；设 `reasoning` 对象会切 Responses API 面（第三方兼容面不可用）；`ChatAnthropic` 原生 `outputConfig` 一级字段且支持 per-call 覆盖。

## 后果

- 六预设全部有确定档位语义；映射单点在 presets.ts，随端点预设同版评审（ADR 0017「加预设 = 改代码发版」精神）。
- 默认链（零覆盖）不接 effort 通道——默认态滑块置灰，呈现与 kimi 同形、tooltip 区分（ADR 0019）。
- 「标准」与各家缺省档实务等同（Anthropic/OpenAI 缺省 ≈ medium、thinking-only 缺省 = 思考开），无 effort 旧行显示「标准」不失真；运行层对无 effort 行保持零注入，行为与今日逐字节等价。

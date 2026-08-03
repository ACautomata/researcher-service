# DeepSeek-V4-Flash 真实 API（SVG 重建 stage 4 适配调研）

> Wayfinder **#350** 产出 · 父 map **#347**（AutoFigure-Edit 整合）。
>
> 调研 DeepSeek-V4-Flash 模型的**真实 API**：存在性/标识、能力（JSON 输出 / SVG / 上下文 / 图像输入）、计费/速率/延迟、与现 SVG 重建模型（gemini-3.1-pro-preview / gpt-5.5）的适配成本。
>
> **查证日期：2026-08-03**。一手来源以官方 `api-docs.deepseek.com`、HuggingFace 模型卡、NVIDIA NIM 模型卡为准；第三方来源一律在行内标注。

---

## 0. TL;DR（结论先行）

| 问题 | 结论 | 来源 |
|------|------|------|
| 存在？ | **是**。V4 于 2026-04-24 上线，`deepseek-v4-flash` 是官方两个 API 模型之一；2026-07-31 发布正式版 **V4-Flash-0731**（public beta） | [更新日志](https://api-docs.deepseek.com/updates/) |
| 确切 model id | `deepseek-v4-flash`（唯一 id，自动指向最新版本）；无 `-0731` 后缀 id | [首页](https://api-docs.deepseek.com/) |
| endpoint / auth | OpenAI 格式 `https://api.deepseek.com`（`POST /chat/completions`）；Anthropic 格式 `https://api.deepseek.com/anthropic`（`POST /v1/messages`）；`Authorization: Bearer <key>` | [首页](https://api-docs.deepseek.com/)、[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api) |
| SDK | 无官方品牌 SDK；官方样例用 **OpenAI SDK**（`pip install openai`）+ `base_url` 覆盖；Anthropic SDK 亦可（`ANTHROPIC_BASE_URL`） | [Python 样例](https://api-docs.deepseek.com/api_samples/chat_python/) |
| 结构化/JSON 输出 | 支持 `response_format={"type":"json_object"}`（须在 prompt 里写 "json"）；另有 tool-calling `strict` 模式（Beta，走 `/beta` base_url）做 schema 校验 | [API 参考](https://api-docs.deepseek.com/api/create-chat-completion)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) |
| 直接产 SVG（XML） | **可行**——纯文本模型，任意文本/XML 均可直接生成；**勿用 json_object 包 SVG**（会强制 JSON）。max output 384K tokens，SVG 无长度顾虑 | [定价页](https://api-docs.deepseek.com/quick_start/pricing) |
| 上下文窗口 | **输入 1M tokens，max output 384K tokens**（两档模型相同） | [定价页](https://api-docs.deepseek.com/quick_start/pricing) |
| 图像输入 | **不支持**。`content` 仅字符串；Anthropic 面 `image` block 不支持；Responses API 面 `input_image` 被占位文本替换 | [API 参考](https://api-docs.deepseek.com/api/create-chat-completion)、[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)、[Responses API](https://api-docs.deepseek.com/guides/responses_api) |
| flash vs pro | flash 284B/13B 激活、`$0.14/$0.28`/M、并发 2500；pro 1.6T/49B、`$0.435/$0.87`/M、并发 500。flash 是低成本/高吞吐档 | [定价页](https://api-docs.deepseek.com/quick_start/pricing)、[HF 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) |
| 计费/速率 | 见 §3。官方只公布**并发数**限额（无 RPM/TPM）；peak/off-peak 2x 计费即将上线 | [定价页](https://api-docs.deepseek.com/quick_start/pricing)、[速率限制](https://api-docs.deepseek.com/quick_start/rate_limit) |
| 延迟 | 官方无一手延迟数字；flash 定位高吞吐档，需实测 | §3.3 |
| **stage 4 最大障碍** | **不能看图**。若 SVG 重建必须"看"SAM 分割结果图，`deepseek-v4-flash` 单模型顶不了，需配视觉模型转文字或改传文本化 mask | §2.4 |

---

## 1. 存在性与标识

### 1.1 是否存在：是（两个时间点的官方事实）

- **2026-04-24**（DeepSeek-V4 上线）：官方更新日志写明"The DeepSeek API now supports V4-Pro and V4-Flash, available via both the OpenAI ChatCompletions interface and the Anthropic interface."。[[更新日志](https://api-docs.deepseek.com/updates/)]
- **2026-07-31**（V4-Flash 正式版）："The official release of the DeepSeek-V4-Flash API is now in public beta."；该版本即 **DeepSeek-V4-Flash-0731**，"keeps the same model architecture and size as DeepSeek-V4-Flash-Preview, and was only re-post-trained"（仅重后训练，架构/规模同 Preview）。[[更新日志](https://api-docs.deepseek.com/updates/)]

### 1.2 确切 model id（`model` 字段）

- 官方当前只列两个 id：`deepseek-v4-flash`、`deepseek-v4-pro`。[[首页](https://api-docs.deepseek.com/)]、[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]
- `deepseek-v4-flash` 是**唯一且恒久**的 id，调用方无需写版本后缀："The `deepseek-v4-flash` model has been updated to DeepSeek-V4-Flash-0731. The calling method remains unchanged — simply use `deepseek-v4-flash` to access the latest version."[[首页](https://api-docs.deepseek.com/)]
- API 参考的 `model` 字段枚举值即 `deepseek-v4-flash` / `deepseek-v4-pro`。[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]

### 1.3 endpoint / auth

| 项 | 值 | 来源 |
|----|----|------|
| base_url（OpenAI 格式） | `https://api.deepseek.com` | [首页](https://api-docs.deepseek.com/) |
| base_url（Anthropic 格式） | `https://api.deepseek.com/anthropic` | [首页](https://api-docs.deepseek.com/)、[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api) |
| 聊天端点 | `POST /chat/completions`（OpenAI 面）；`POST /v1/messages`（Anthropic 面） | [首页](https://api-docs.deepseek.com/)、[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api) |
| auth | `Authorization: Bearer ${DEEPSEEK_API_KEY}`（curl 示例）；key 在 `platform.deepseek.com/api_keys` 申请 | [首页](https://api-docs.deepseek.com/) |
| 可选 `/v1` 前缀 | `https://api.deepseek.com` 与 `https://api.deepseek.com/v1` 等价（OpenAI SDK 兼容层） | [SDK 兼容指南（二手）](https://deepseekai.guide/api/deepseek-api-sdk/) |

### 1.4 SDK / 客户端支持

- **无官方品牌 SDK 包**。官方 Python 样例即 OpenAI SDK："Please install OpenAI SDK first: `pip3 install openai`"，然后 `OpenAI(api_key=…, base_url="https://api.deepseek.com")`。[[chat_python 样例](https://api-docs.deepseek.com/api_samples/chat_python/)]
- OpenAI 兼容面：官方 OpenAI SDK（Python/Node）、LangChain/LlamaIndex/Vercel AI SDK 等 OpenAI 兼容客户端改 `base_url` + key 即可。[[SDK 兼容指南（二手）](https://deepseekai.guide/api/deepseek-api-sdk/)]
- Anthropic 兼容面：官方 `anthropic` SDK，设 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_API_KEY`，直接 `client.messages.create(model="deepseek-v4-flash"|"deepseek-v4-pro")`。[[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)]
- Claude Code 可接入（官方专门文档），本仓库若走 OpenClaw/Claude Code 链路可复用该接口。[[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)]

### 1.5 legacy 名字（deepseek-chat / deepseek-reasoner）已停用

- 官方变更日志（2026-04-24）："The two legacy API model names, `deepseek-chat` and `deepseek-reasoner`, will be discontinued in three months (2026-07-24). During the current period, these two model names point to the non-thinking mode and thinking mode of `deepseek-v4-flash`, respectively."[[更新日志](https://api-docs.deepseek.com/updates/)]
- **截至查证日（2026-08-03）停用期已过**，定价页也只列 `deepseek-v4-flash` / `deepseek-v4-pro` 两个 id——旧 id 不应再用于新代码。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]

### 1.6 公开渠道

- **开源权重**：`deepseek-ai/DeepSeek-V4-Flash`（284B 总 / 13B 激活，MoE，上下文 1M，FP4+FP8 混合精度；另有 `-Base` 预训练版）。[[HF 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)]
- **OpenRouter**：`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-flash-0731`、`~deepseek/deepseek-v4-flash-latest` 均在列（context 1M，第三方托管价低于官方价，见 §3.1）。[[OpenRouter API](https://openrouter.ai/api/v1/models)]
- **NVIDIA NIM**：`deepseek-ai/deepseek-v4-flash`（284B/13B，输入类型 Text）。[[NIM 模型卡](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash)]

---

## 2. 能力

### 2.1 结构化 / JSON 输出

- **JSON Mode**：`response_format={"type":"json_object"}`（默认 `"text"`）。官方约束：prompt 中必须含 "json" 字样（system 或 user 消息），并给 JSON 示例引导；`max_tokens` 要留足防截断。返回在 `choices[0].message.content` 字符串里，自行 `json.loads`。[[JSON 输出指南](https://api-docs.deepseek.com/guides/json_mode)]、[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]
- **已知限制**：官方明示"The API may occasionally return empty content"（偶发空内容，官方在优化中）——生产须做空响应重试。[[JSON 输出指南](https://api-docs.deepseek.com/guides/json_mode)]
- **无 OpenAI `json_schema` 模式**：`response_format.type` 枚举只有 `text` / `json_object`。[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]
- **tool-calling `strict`（Beta，近似 OpenAI Structured Outputs）**：`base_url="https://api.deepseek.com/beta"`，所有函数须 `"strict": true`，服务端校验 JSON Schema（支持 object/string/number/integer/boolean/array/enum/anyOf + `$ref`；object 属性必须全部 required + `additionalProperties:false`；string 不支持 minLength/maxLength 等）。[[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)]
- **Responses API 面**（仅 flash，见 §4）：`text.format` 全支持（即 OpenAI 格式的 `text` 输出配置）。[[Responses API](https://api-docs.deepseek.com/guides/responses_api)]

### 2.2 直接产出 SVG（XML）

- 模型是**纯文本 LLM**（MoE language model），输出即文本流，`content` 是普通字符串——**直接生成 SVG/XML 文本天然可行**，无内容类型限制。[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]、[[HF 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)]
- **注意**：不要把 SVG 输出挂 `json_object` 模式——该模式强制输出合法 JSON；要 JSON 包 SVG 需让模型把 SVG 字符串作为 JSON 字段值（"json" 字样 + 示例）。纯 SVG 输出用默认 `text` 模式即可。
- **输出长度**：max output **384K tokens**，SVG 装配输出量级毫无压力。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]
- **FIM（fill-in-middle）补全（Beta）**：两档模型均为"Non-thinking mode only"（仅非思考模式可用），对代码/模板类补全有用但 SVG 重建不太需要。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]

### 2.3 上下文窗口

- **输入上下文 1M tokens，max output 384K tokens**（flash/pro 相同）。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)、[HF 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)]
- 注意 max_tokens 上限是 **384K**，不是 1M——输出侧有独立上限。

### 2.4 图像输入（vision）——**关键负结论：不支持**

这是 stage 4（可能要"看" SAM 分割结果图）**最大的适配障碍**。四条一手/强证据：

1. **Chat Completions API 参考**：所有角色的 `content` 字段定义为 `string`（"Text content (string)"），**无 content-parts 数组、无 `image_url`**；消息 schema 里没有任何多模态内容块。[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]
2. **Anthropic 兼容面**：明确把 `image`、`document` 列为**不支持**的 content 类型（不支持的列表含 `image`, `document`, `search_result`, `redacted_thinking`, `code_execution_tool_result`, `mcp_tool_use`…）。[[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)]
3. **Responses API 面**："Image and file inputs are not supported (`input_image` parts do not cause an error, but are replaced with a placeholder text)"——即传入 `input_image` 不会报错但会被替换成占位文本。[[Responses API](https://api-docs.deepseek.com/guides/responses_api)]
4. **NIM 模型卡**：`Input Types: Text`。[[NIM 模型卡](https://api-docs.deepseek.com/nim/reference/deepseek-ai-deepseek-v4-flash)]

第三方**实测**佐证（二手来源，但直接打官方 API）：2026-06 有人用 OpenAI 格式发 `image_url` content part，被请求解析层直接拒绝：`Failed to deserialize the JSON body into the target type: messages[0]: unknown variant 'image_url', expected 'text'`——即 schema 层根本没有图像入口，聚合商目录里所有 DeepSeek 模型（含 v4-pro/v4-flash）modalities 均为 `text`。[[Joche Ojeda 实测博客](https://www.jocheojeda.com/2026/06/24/deepseek-v4-vision-thinking-with-visual-primitives/)]

> **推论**：DeepSeek 存在一个基于 V4-Flash backbone + 自研 vision encoder 的**研究模型**（能出 bbox/point，box 归一化为 0–999 整数）[[同上博客](https://www.jocheojeda.com/2026/06/24/deepseek-v4-vision-thinking-with-visual-primitives/)]，但它**不是** API 里的 `deepseek-v4-flash`。stage 4 想"看"分割图，要么：
> (a) 加一个视觉模型做图文转述（分割图 → 文字描述/坐标），把文本喂给 V4-Flash；
> (b) 把 SAM 输出**文本化**再喂入（如多边形坐标 JSON / ASCII mask），不经图像通道；
> (c) stage 4 主体保留原视觉模型（gemini-3.1-pro-preview / gpt-5.5 支持图像输入），V4-Flash 仅做可文字化子任务。

### 2.5 "flash" vs "base v4"（实为 flash vs pro）

- API 面没有叫 "base v4" 的模型；"Base" 只在 HuggingFace 指**未对齐预训练权重**（`DeepSeek-V4-Flash-Base` / `DeepSeek-V4-Pro-Base`），不是 API 模型。[[HF 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)]
- API 两个档位：

| | **deepseek-v4-flash** | **deepseek-v4-pro** |
|---|---|---|
| 参数量（总/激活） | 284B / 13B | 1.6T / 49B |
| 输入单价 /M（cache miss） | $0.14 | $0.435 |
| 输出单价 /M | $0.28 | $0.87 |
| 并发上限 | 2500 | 500 |
| thinking effort 映射 | low→low, high→high, xhigh→high, max→max | low→high, high→high, xhigh→max, max→max（early Aug 2026 后更新） |
| 状态 | 正式版 0731 public beta；**Responses API 仅 flash 支持** | 官方"release will follow soon"（仍是 preview） |
| 定位 | 高吞吐、低成本、agent/chat 默认档 | 旗舰档 |

来源：[[HF 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)]、[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]、[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]、[[更新日志](https://api-docs.deepseek.com/updates/)]

- **0731 相对 Preview**：同架构同规模，仅重后训练；主打 agent 能力，"benchmark results far exceeding V4-Pro-Preview"（Terminal Bench 2.1: 82.7、DeepSWE: 54.4、DSBench-FullStack: 68.7 等，官方注：跑在 DeepSeek Harness minimal mode，max effort、topp=0.95、temperature=1.0）。**只升了 V4-Flash API**，V4-Pro API 与 APP/WEB 模型未动。[[更新日志](https://api-docs.deepseek.com/updates/)]、[[TechNode（二手）](https://technode.com/2026/07/31/deepseek-puts-v4-flash-api-into-public-beta/)]

### 2.6 thinking 模式（默认开！延迟/成本关键）

- **默认启用**，默认 effort `high`："Thinking mode is enabled by default, with the default effort being `high`."[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]
- 开关（OpenAI 格式）：`{"thinking": {"type": "enabled"|"disabled"}}`；OpenAI SDK 要放 `extra_body={"thinking": {...}}`；effort 用 `reasoning_effort`（low/high/max，`medium`/`xhigh` 映射到 high）。[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]、[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]
- Anthropic 格式：`{"reasoning": {"effort": "none|low|high|max"}}`，`none` 即关 thinking（`budget_tokens` 被忽略）。[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]、[[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)]
- **thinking 模式下 `temperature`/`top_p`/`presence_penalty`/`frequency_penalty` 全部无效**（"will not trigger an error but will also have no effect"）；非 thinking 模式才生效。[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]
- 思维链通过 `reasoning_content` 字段随 `content` 平级返回；**多轮带 tool call 时 `reasoning_content` 必须原样回传**，否则 400。[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]
- 计费：usage 里有 `completion_tokens_details.reasoning_tokens`——reasoning token 计入 completion tokens（按输出价计费，这是对 schema 的推断，官方未单列 reasoning 价）。[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]
- **对 stage 4 的含义**：SVG 重建这类确定性生成，强烈建议 `thinking: disabled`（省延迟、省 reasoning token、且能让 temperature 生效），除非要利用推理提升复杂装配质量。

---

## 3. 计费、速率、延迟

### 3.1 单价（官方定价页，2026-08-03 查）

| Model | Input cache hit /M | Input cache miss /M | Output /M | Context | Max Output |
|---|---|---|---|---|---|
| `deepseek-v4-flash` | $0.0028 | $0.14 | $0.28 | 1M | 384K |
| `deepseek-v4-pro` | $0.003625 | $0.435 | $0.87 | 1M | 384K |

来源：[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]

- **上下文缓存**：命中价约 miss 价 1/50（flash $0.0028 vs $0.14），自动启用（Responses API 面自动管理缓存，chat 面看 `prompt_cache_hit_tokens`）。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]、[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]
- **即将上线 peak/off-peak 计费**：高峰时段（**北京时 9:00–12:00 与 14:00–18:00 每日**）价格 **2x**，"applicable to all billing items"；生效日待官方公告。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]
- **第三方托管价**（OpenRouter，供参考）：`deepseek/deepseek-v4-flash-0731` prompt $0.09/M、completion $0.18/M（约官方价 37% off，第三方补贴，非官方价）。[[OpenRouter API](https://openrouter.ai/api/v1/models)]

### 3.2 速率限制（官方无 RPM/TPM，只有并发）

- 官方速率限制页**不设 RPM/TPM**，以**账户级并发**计：`deepseek-v4-flash` 2500 并发、`deepseek-v4-pro` 500 并发。[[速率限制](https://api-docs.deepseek.com/quick_start/rate_limit)]、[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]
- 超限返回 **HTTP 429**；加配额可申请 capacity expansion（不加价）。[[速率限制](https://api-docs.deepseek.com/quick_start/rate_limit)]
- 标准账户所有 `user_id` 合并算并发；提额账户额外有每 `user_id` 上限（flash 2500 / pro 500）。[[速率限制](https://api-docs.deepseek.com/quick_start/rate_limit)]
- 连接保活：非流式等待期发空行，流式发 `: keep-alive` SSE 注释；**10 分钟未开始推理服务端断连**。[[速率限制](https://api-docs.deepseek.com/quick_start/rate_limit)]

### 3.3 延迟

- **官方未发布一手延迟数字**（无 SLA/TTFT 承诺页）。能确定的定位性事实：flash 是高吞吐/低成本档（并发 2500、13B 激活），0731 主打 agent 时延优化；具体每请求延迟需在本仓库环境实测。
- OpenRouter 的该模型 `top_provider.latency/throughput` 字段为空（未公布百分位）。[[OpenRouter API](https://openrouter.ai/api/v1/models)]
- 间接信号：官方称 0731 "Significantly enhanced agent capabilities"、为 agent 场景优化[[更新日志](https://api-docs.deepseek.com/updates/)]；第三方报道称 V4-Flash 主打更快工具调用[[Techgenyz（二手）](https://techgenyz.com/deepseek-v4-flash-api/)]。均非可引用的延迟数据。

### 3.4 免费额度

- 官方定价页未列"永久免费层"；只有计费顺序说明"granted balance is used before topped-up balance"（**赠送余额**先于充值余额消耗）。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]
- 账户余额为 0 时调用返回 HTTP 402（二手教程记载，非官方文档原句）。[[DeepSeek Python 集成（二手）](https://deepseekai.guide/tutorials/deepseek-python-integration/)]
- 结论：**没有公开的免费 API 层**；赠额属于注册/活动性质，需以 `platform.deepseek.com` 实际账户为准（未从一手来源确认赠额数额）。

---

## 4. 与现模型（gemini-3.1-pro-preview / gpt-5.5）的适配成本

> 说明：本仓库现役 gemini-3.1-pro-preview / gpt-5.5 的 API 细节本文档**未逐一考证**（不在本票一手来源范围），以下"差异"以 **DeepSeek 侧已确认契约** 为准 + 对两类模型的**常识性对比**（明确标注）。迁移时务必对现模型侧也做一次契约核对。

### 4.1 直接替换的硬门槛

| 能力 | 现模型（Gemini/GPT 常识） | `deepseek-v4-flash` | 影响 |
|---|---|---|---|
| **图像输入** | Gemini/GPT 均支持 | **不支持（§2.4）** | **硬门槛**。stage 4 若要"看"SAM 分割图，不可单模型平替 |
| 系统角色（system prompt） | 支持 | 支持（OpenAI 面 `system` role；Anthropic 面 `system`；Responses 面 `instructions`/`developer`→system） | 无成本 |
| 结构化输出 | Gemini `responseSchema`；GPT `json_schema` | 仅 `json_object`（prompt 约束）或 tool `strict`（Beta schema 校验，`/beta` base_url） | 中成本：schema 校验要换接口面（tool strict 或自校验） |
| thinking/reasoning | Gemini/GPT 各有思考模式 | 默认开、可关（§2.6） | 低成本：关掉即可 |
| 模型 id | 各自 id | `deepseek-v4-flash` | 无成本 |

### 4.2 具体迁移映射（DeepSeek 侧契约 → 建议用法）

1. **调用入口**：把 base_url/key 换成 DeepSeek（§1.3），SDK 复用 OpenAI/Anthropic 客户端（§1.4）。若现有链路是 Anthropic Messages 格式，直接 `ANTHROPIC_BASE_URL` 指向 `https://api.deepseek.com/anthropic`——注意 `image`/`document` content block 会被拒（§2.4），`cache_control`、`top_k`、`budget_tokens` 等字段被忽略。[[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)]
2. **JSON 输出**：`response_format={"type":"json_object"}` + prompt 含 "json" + 给示例；**替换 Gemini 的 `responseSchema` / GPT 的 `json_schema`**——DeepSeek 无 `json_schema` 枚举，若需 schema 级校验改走 tool-calling `strict` 模式（`/beta` base_url，schema 约束见 §2.1）。[[JSON 指南](https://api-docs.deepseek.com/guides/json_mode)]、[[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)]
3. **SVG 输出**：**保持默认 `text` 模式**直接要 XML（可要求 fenced code block 或裸 XML），不要用 json_object；若流水线下游要 JSON 信封，让模型产出 `{"svg": "<svg…>"}` 再 `json.loads`。max output 384K 足够。[[API 参考](https://api-docs.deepseek.com/api/create-chat-completion)]、[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]
4. **延迟**：SVG 重建任务**显式关 thinking**——`extra_body={"thinking":{"type":"disabled"}}`（OpenAI SDK）或 `reasoning: {"effort":"none"}`（Anthropic 面）；同时 temperature 才恢复生效（`<=2`，默认 1）。[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]、[[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)]
5. **tool 多轮**：DeepSeek 多轮带 tool 时必须回传 `reasoning_content`，否则 400（§2.6）——与 OpenAI/Gemini 的多轮惯例不同，**容易踩坑**。[[Thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode)]
6. **id 别名**：别用 `deepseek-chat`/`deepseek-reasoner`（已停用，§1.5）；如依赖 OpenAI Responses API 管线，**当前只有 flash 支持**（pro 约 2026-08 上旬跟进）。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]
7. **超时/重试**：官方 JSON 模式有"偶发空 content"已知问题（§2.1）；推理 10 分钟未开始会断连（§3.2）——建议空响应重试 + 合理超时。[[JSON 指南](https://api-docs.deepseek.com/guides/json_mode)]、[[速率限制](https://api-docs.deepseek.com/quick_start/rate_limit)]
8. **成本**：flash 输入 $0.14/M、输出 $0.28/M，低于旗舰级模型通常单价；叠加 cache hit $0.0028/M（§3.1）。**但 peak 时段 2x 计费即将上线**，高峰批量任务成本翻倍，需纳入预算模型。[[定价页](https://api-docs.deepseek.com/quick_start/pricing)]

### 4.3 本仓库（OpenClaw 面板）接入建议

- **stage 4 纯文本/JSON 子任务**：可直接切 `deepseek-v4-flash`，成本优势明显（flash 是 v4 官方两档中的低成本档）。
- **stage 4 需要"看"分割图**：**不能**只换模型。方案 (a) 前置一个支持图像输入的模型（现役 gemini/gpt）把 SAM 结果转成文字/坐标描述，V4-Flash 只做 SVG 装配；(b) 将 mask 文本化（多边形坐标 JSON / ASCII art）直接入 prompt；(c) 混合：视觉理解留原模型，仅把装配子阶段迁到 V4-Flash。
- **Anthropic 接口可复用 OpenClaw/Claude Code 链路**：官方支持把 DeepSeek 作为 Claude Code 后端（§1.4），`claude-haiku`/`claude-sonnet` 前缀自动映射到 flash、`claude-opus` 映射到 pro——若 OpenClaw 内部走 Anthropic Messages，改 env 即可让内层 agent 用 flash。[[Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api)]

---

## 5. 未证实 / 无法从一手来源确认

1. **延迟数字**：官方无任何一手 TTFT/吞吐承诺；无法给出"典型延迟"。仅能确认 flash 是高吞吐档（§3.3）。**需实测。**
2. **免费额度**：官方只提"granted balance"优先消耗顺序，**未确认**当前是否有新用户赠额及数额（§3.4）。
3. **reasoning token 计费单价**：`reasoning_tokens` 计入 completion tokens 是**对 usage schema 的推断**；官方文档未单独说明思维链定价（§2.6）。
4. **现役模型对比细节**：gemini-3.1-pro-preview / gpt-5.5 的 API 细节未逐一考证，§4 中对其描述是常识性对比，**迁移前需对现模型侧单独核契约**。
5. **peak/off-peak 计费生效日**：官方说"subject to the official announcement"，尚未定生效日期（§3.1）。
6. **V4-Pro 正式版时间**：官方只说 "release will follow soon" / Responses API 支持 "in early August 2026"，无精确日期（§2.5）。

---

## 附：一手来源清单（查证日期 2026-08-03）

- [DeepSeek API Docs — Your First API Call](https://api-docs.deepseek.com/)（base_url / model / auth / thinking 示例）
- [DeepSeek API Docs — Update Log](https://api-docs.deepseek.com/updates/)（2026-07-31 V4-Flash-0731、2026-04-24 V4、legacy 停用）
- [DeepSeek API Docs — Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)（单价 / 1M / 384K / 并发 / peak-off-peak / Responses API 支持面）
- [DeepSeek API Docs — Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit)（并发 / 429 / 10 分钟断连）
- [DeepSeek API Docs — Create Chat Completion 参考](https://api-docs.deepseek.com/api/create-chat-completion)（content 仅 string / response_format / thinking / tools / reasoning_content / usage）
- [DeepSeek API Docs — Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)（默认开 / effort 映射 / 不支持参数 / reasoning_content 回传）
- [DeepSeek API Docs — Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)（tools 格式 / strict Beta）
- [DeepSeek API Docs — JSON Output](https://api-docs.deepseek.com/guides/json_mode)（json_object / "json" 字样 / 偶发空内容）
- [DeepSeek API Docs — Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)（`/anthropic` base_url / claude 前缀映射 / `image` 不支持）
- [DeepSeek API Docs — Responses API](https://api-docs.deepseek.com/guides/responses_api)（仅 flash / stateless / `input_image` 占位替换）
- [DeepSeek API Docs — chat_python 样例](https://api-docs.deepseek.com/api_samples/chat_python/)（OpenAI SDK 用法）
- [HuggingFace — deepseek-ai/DeepSeek-V4-Flash 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)（284B/13B / 1M / 无 Jinja template）
- [NVIDIA NIM — deepseek-ai/deepseek-v4-flash](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash)（Input Types: Text）

第三方来源（已在正文标注）：[OpenRouter API](https://openrouter.ai/api/v1/models)、[TechNode](https://technode.com/2026/07/31/deepseek-puts-v4-flash-api-into-public-beta/)、[Techgenyz](https://techgenyz.com/deepseek-v4-flash-api/)、[Joche Ojeda 实测（image_url 被拒）](https://www.jocheojeda.com/2026/06/24/deepseek-v4-vision-thinking-with-visual-primitives/)、[deepseekai.guide](https://deepseekai.guide/api/deepseek-api-sdk/)。

# MiniMax image-01 × TokenPlan：图片生成 API 契约调研（wayfinder #349）

---

> 目标：查清「MiniMax image-01 图片生成模型经 TokenPlan 渠道调用」的真实 API 契约，为 AutoFigure-Edit 流水线（科研方法文本 → 示意图 → SAM3 分割 → SVG 模板 → 装配）把**生图阶段**从 Google Gemini（现 `gemini-3.1-flash-image-preview`）替换为 MiniMax image-01(TokenPlan) 提供依据。用户已确认 image-01 + TokenPlan 是其接入渠道，本调研只查调用机制。
>
> 信源：全部为 primary source——MiniMax 官方文档中心（platform.minimax.io 国际 / platform.minimaxi.com 中国）、MiniMax 官方 GitHub / npm SDK、Google Gemini API 官方文档。二手转述（minimax-ai.chat、302.ai、amux.ai 等）仅作旁证并明确标注，不作为契约依据。
>
> 调研日期：2026-08-03。

---

## 结论速览（一句话）

**TokenPlan 不是第三方聚合代理平台，而是 MiniMax 官方的月度订阅计费 tier**：用独立 **Subscription Key**（前缀 `sk-cp-…`）经**与 pay-as-you-go 完全相同的 REST endpoint**（国际 `api.minimax.io` / 中国 `api.minimaxi.com`）调用 `POST /v1/image_generation`，按 pay-as-you-go 目录价（image-01 = 国际 $0.0035/张）从订阅 included quota 扣减；image-01 支持文生图与「character 参考图」图生图，单次 1–9 张，输出 url（24h 过期）或 base64。替换 Gemini 的关键适配点：协议形态从「chat 式 generateContent」换成「专用图片生成 REST」、参数/输出解析重写、并注意 **`gemini-3.1-flash-image-preview` 官方已于 2026-06-25 弃用关闭**（GA 替代为 `gemini-3.1-flash-image`）。

---

## 1. TokenPlan 是什么

### 1.1 定位：官方订阅 tier，不是聚合代理

MiniMax 官方把计费拆成两大体系（`/docs/pricing/overview`）：

| 计费体系 | Key 类型 | 计费方式 | 定位 |
|---|---|---|---|
| **API 按量计费（Pay-as-you-go）** | 标准 API Key（Open Platform 钱包余额） | 按实际用量/token/调用计费 | 面向企业、生产 |
| **Token Plan 订阅** | **Subscription Key**（前缀 `sk-cp-…`） | 月度订阅、套餐内 included quota | 面向个人开发者、Agent/Coding 工具、日常多模态 |

官方原文（`/docs/token-plan/intro`）：

> "MiniMax is one of the few AI labs that develops frontier models across the full spectrum of modalities… The Token Plan extends upon our former Coding Plan by providing included Token Plan usage beyond language models."
> "The Subscription Key is not interchangeable with pay-as-you-go API Keys."

**关键澄清**：网络上有「TokenPlan 是第三方 API 聚合平台」的说法——这是误读。MiniMax 官方文档中 Token Plan 是**第一方订阅套餐**；第三方聚合网关（如 302.ai、amux.ai、Fal、Replicate）各自包装 image-01 是另一回事，与本渠道无关。

### 1.2 分区与入口

| 区域 | 订阅/控制台 | API Base URL | TokenPlan 订阅页 |
|---|---|---|---|
| **国际** | platform.minimax.io | `https://api.minimax.io` | https://platform.minimax.io/subscribe/token-plan |
| **中国大陆** | platform.minimaxi.com | `https://api.minimaxi.com` | https://platform.minimaxi.com/subscribe/token-plan |

官方 `mmx-cli` 文档（`/docs/token-plan/minimax-cli`）：服务区域取决于购买平台——中国平台买 `cn` 区、海外平台买 `global` 区；API Key 前缀 `sk-…`，CLI 可自动探测区域（探测失败 401 时手动 `mmx config set --key region --value global|cn`）。

### 1.3 套餐档位（官方定价页）

国际（`/docs/guides/pricing-token-plan`）：

| 档位 | 价格 | 适合场景 | 配额窗口 |
|---|---|---|---|
| Plus | $20 /月 | 个人项目与原型 | 5 小时滚动 + 周窗口 |
| Max | $50 /月 | 日常编程 Agent + 多模态 | 5 小时滚动 + 周窗口 |
| Ultra | $120 /月 | 重度 Agent 工作流 | 5 小时滚动 + 周窗口 |

中国（platform.minimaxi.com `/docs/guides/pricing-token-plan`）：Plus ¥49/月、Max ¥119/月、Ultra ¥469/月；积分包按 **1,000 积分 = ¥7**（国际为 1,000 积分 = $1）。

- 模型覆盖：M3 / M2.7 / **图像（image-01）** / 语音 / 音乐，**共享同一 included quota**（`/docs/token-plan/faq`：「Model usage covered by Token Plan shares one included Token Plan quota」）。少量特殊模型（MiniMax H3、音色设计、快速复刻）不在覆盖内。
- 配额窗口：5 小时滚动窗口 + 周窗口；未用额度**不结转**（`/docs/token-plan/intro`）。
- 超额处理：先扣套餐额度，超出部分由已购 Credits（积分）自动抵扣；都无则需升级/换 pay-as-you-go/等窗口重置（`/docs/token-plan/intro`）。
- 官方明确 TokenPlan 定位是个人交互式开发用途，**生产建议 pay-as-you-go**（`/docs/token-plan/faq`）。

### 1.4 经 TokenPlan 调用的机制：endpoint 同构、仅换 Key

官方口径（`/docs/token-plan/intro`、`/docs/token-plan/faq`）：

> "For API endpoints that have pay-as-you-go pricing, usage deducts from the included Token Plan quota **according to the corresponding endpoint pricing**."

即：**TokenPlan 不提供独立 endpoint**。调用方式 = 用 Subscription Key 走与 pay-as-you-go 相同的官方 REST endpoint（见 §2）。官方集成文档（`/docs/token-plan/other-tools`）里给各 Agent 工具的配置一律是：

- OpenAI-compatible：Base URL `https://api.minimax.io/v1`，API Key = **Subscription Key**
- Anthropic-compatible：Base URL `https://api.minimax.io/anthropic`，API Key = Subscription Key

附加工具：
- **官方 CLI**：`npm install -g mmx-cli`（GitHub: MiniMax-AI/cli）；`mmx auth login --api-key sk-…`；`mmx quota` 查 TokenPlan 余额（`/docs/token-plan/minimax-cli`）。
- **剩余配额 REST**：`GET https://www.minimax.io/v1/token_plan/remains`，`Authorization: Bearer <Subscription Key>`（`/docs/token-plan/faq`）。

> ⚠ 中国区对应的剩余配额 endpoint 域名官方未在抓取到的文档中给出（FAQ 示例为国际 `www.minimax.io`）。中国区用法以控制台 usage bar 为准，需实测。

---

## 2. image-01 请求/响应 schema（官方直连 = TokenPlan 同构）

中国区权威 schema：`https://platform.minimaxi.com/docs/api-reference/image-generation-t2i`（OpenAPI 3.1 内嵌）。国际区同构：`https://platform.minimax.io/docs/api-reference/image-generation-t2i`（仅个别字段差异，见 §2.3）。

### 2.1 请求

```
POST https://api.minimaxi.com/v1/image_generation        # 中国；国际用 https://api.minimax.io/v1/image_generation
Content-Type: application/json
Authorization: Bearer <API Key | Subscription Key>       # TokenPlan 用 Subscription Key
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | `image-01` 或 `image-01-live` |
| `prompt` | string | 是 | 图像文本描述，**最长 1500 字符** |
| `aspect_ratio` | string | 否 | 见下方宽高比表；默认 `1:1` |
| `width` / `height` | int | 否 | 像素宽/高，**仅 image-01 生效**；须同时设置，范围 [512, 2048]，且为 **8 的倍数**；与 `aspect_ratio` 同时给时 `aspect_ratio` 优先 |
| `response_format` | enum | 否 | `url`（默认）或 `base64`；**url 有效期 24 小时** |
| `n` | int | 否 | 单次生成图片数，[1, 9]，默认 1 |
| `seed` | int64 | 否 | 随机种子；相同 seed+参数可复现。缺省时 n 张图各自随机种子 |
| `prompt_optimizer` | bool | 否 | prompt 自动优化，默认 `false` |
| `aigc_watermark` | bool | 否 | 是否加水印，默认 `false`（**仅中国区 schema 有**） |
| `style` | object | 否 | 画风 `{style_type, style_weight}`，**仅 image-01-live 生效**；style_type ∈ 漫画/元气/中世纪/水彩，style_weight ∈ (0,1] 默认 0.8 |
| `subject_reference` | array | 否 | **图生图/参考图**：`[{type: "character", image_file: "…"}]`，仅支持 `character`（人像），单参考图；`image_file` 支持公开 URL 或 base64 Data URL（`data:image/jpeg;base64,…`）；JPG/JPEG/PNG，<10MB |

`aspect_ratio` 预设（中国区/国际区一致）：

| 值 | 分辨率 | 值 | 分辨率 |
|---|---|---|---|
| `1:1` | 1024x1024 | `2:3` | 832x1248 |
| `16:9` | 1280x720 | `3:4` | 864x1152 |
| `4:3` | 1152x864 | `9:16` | 720x1280 |
| `3:2` | 1248x832 | `21:9` | 1344x576（仅 image-01） |

> 一次调用多图：`n` ∈ [1,9]，同步返回。

### 2.2 响应

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.image_urls[]` | array<string> | `response_format=url` 时返回图片 URL 数组 |
| `data.image_base64[]` | array<string> | `response_format=base64` 时返回 Base64 图片数组 |
| `metadata.success_count` | int | 成功生成张数 |
| `metadata.failed_count` | int | **被内容安全检查拦截**未返回的张数 |
| `id` | string | 生成任务 trace ID |
| `base_resp.status_code` / `status_msg` | int/string | 业务状态码，见下 |

`base_resp.status_code` 关键取值（官方 errorcode 页 + OpenAPI）：

| code | 含义 |
|---|---|
| 0 | 成功 |
| 1002 | 触发限流，请稍后重试 |
| 1004 | 账号鉴权失败（API-Key 不对） |
| 1008 | 账号余额不足 |
| 1026 | 图片描述涉及敏感内容 |
| 2013 | 传入参数异常 |
| 2049 | 无效 API Key |

### 2.3 中国区 vs 国际区 schema 差异

| 差异项 | 中国区（api.minimaxi.com） | 国际区（api.minimax.io） |
|---|---|---|
| `aigc_watermark` | ✅ 有（默认 false） | schema 未列出 |
| `model` 枚举 | `image-01`、`image-01-live` | t2i 页枚举仅 `image-01`；i2i 页含 `image-01-live` |
| 官方价格币种 | 人民币（按量价见 §3） | 美元 |

两区 endpoint 路径、字段名、响应结构一致。

### 2.4 官方 SDK

npm 官方包 `minimax-api`（https://www.npmjs.com/package/minimax-api）：`image.generateFromText({model:'image-01', prompt, aspect_ratio, n})` / `image.generateFromImage({model:'image-01', prompt, subject_reference:[…]})`；`createClient(apiKey, {baseURL:'https://api.minimaxi.com', timeout:60000})`。适用于直连；TokenPlan 渠道同样可用（把 key 换成 Subscription Key，baseURL 按区域选）。

> 注意：MiniMax 官方 **image 生成没有 OpenAI-compatible `images/generations` 兼容层**——OpenAI 兼容仅覆盖 Chat Completions（`/docs/api-reference/text-openai-api`）。第三方网关（如 amux.ai 文档所述）自行把 image-01 包装成 OpenAI `images` 形状，非官方能力，不作为本项目契约依据。

---

## 3. 计费 / 速率 / 延迟

### 3.1 计费模型

- **按张计费**（非 token）。国际官方 pay-as-you-go 目录价（`https://platform.minimax.io/docs/guides/pricing-paygo`）：**image-01 = $0.0035 / 张**。请求 `n=3` 即 3 张计费。
- **经 TokenPlan**：按 pay-as-you-go 目录价折算为 included quota 扣减（官方 FAQ 明确「usage deducts from the included Token Plan quota according to the corresponding endpoint pricing」）。即 TokenPlan 下每张 image-01 ≈ 扣 $0.0035 等值配额（国际），与套餐价格无关。
- 中国区按量价：本次抓取中 `platform.minimaxi.com/docs/guides/pricing-paygo` 页未完整返回 image 小节，**人民币单价未确认**，需在控制台定价页核实。
- 第三方参考（**非官方，仅作量级旁证**）：Fal / Replicate 上 image-01 约 $0.01/张；302.ai 标 0.01 PTC/次。官方直连最低。

### 3.2 速率限制

- 官方 rate-limits 页（`https://platform.minimax.io/docs/guides/rate-limits`）：**Image Generation / image-01 = 10 RPM**。
- TokenPlan 附加限制（`/docs/token-plan/faq`「What are the limits of the Token Plan?」）：请求可能被限流（RPM/TPM），超限时**约 1 分钟内重置**，**高峰期会收紧**（动态调整）。
- 限流错误码：业务码 `1002`。

### 3.3 典型延迟

- **官方未公开 image-01 的延迟 SLA**。文生图扩散模型通常同步返回、数秒~十几秒量级，但属推断，**需实测**。项目可按同步调用处理（MiniMax 该接口无任务轮询，一次 HTTP 返回成图；`id` 仅作 trace）。

---

## 4. 与 Gemini 图片生成的差异（迁移适配）

### 4.1 现状：项目在用的 Gemini 模型已弃用

官方 changelog（`https://ai.google.dev/gemini-api/docs/changelog`）：

> "Deprecation announcement: The `gemini-3.1-flash-image-preview` and `gemini-3-pro-image-preview` models are **deprecated and will be shut down on June 25, 2026**."
> "Released `gemini-3.1-flash-image` (Nano Banana 2) and `gemini-3-pro-image` (Nano Banana Pro), the generally available (GA) visual models."

即项目现用的 `gemini-3.1-flash-image-preview` 已于 **2026-06-25 关闭**（GA 替代 `gemini-3.1-flash-image`）。当前日期 2026-08-03——这很可能是本次替换生图阶段的直接动因之一；迁移前应先确认现流水线是否已因模型下线而报错。

### 4.2 Gemini 官方请求形状（generateContent，作对比）

`https://ai.google.dev/gemini-api/docs/generate-content/image-generation`：

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent
x-goog-api-key: $GEMINI_API_KEY
{
  "contents": [{"parts": [{"text": "Create a picture of …"}]}],
  "generationConfig": {
    "response_modalities": ["TEXT", "IMAGE"],        # 必须同时含 IMAGE
    "imageConfig": {"aspectRatio": "16:9"}           # 新式；旧式用 imageModes
  }
}
```

- 参考图输入：`contents[].parts[].inline_data = {mime_type, data(base64)}`（或 File API `file_data`）；Gemini 3 支持**最多 14 张参考图**做编辑/一致性。
- 输出：`candidates[0].content.parts[]` 中 `inline_data`（base64 + mime_type）或 text；分辨率 1K / 2K / 4K。
- 计费：`gemini-3.1-flash-image-preview` 官方 $0.25 / text 输入、$0.067 / image 输出（`https://ai.google.dev/gemini-api/docs/generate-content/gemini-3`）。⚠ 这是**按输出图计费但价格比 MiniMax 高一个数量级**（Gemini 每张输出图 $0.067 vs MiniMax $0.0035）。

### 4.3 差异对照表

| 维度 | Gemini（现） | MiniMax image-01（目标） |
|---|---|---|
| 协议形态 | chat 式 `generateContent`（文本/图/视频混合模态、多轮对话式编辑） | 专用图片生成 REST `POST /v1/image_generation`（单一请求，无多轮编辑） |
| 鉴权 | `x-goog-api-key` header / Bearer | `Authorization: Bearer <Key>` |
| prompt 位置 | `contents[].parts[].text` | 顶层 `prompt`（≤1500 字符） |
| 输出 | `candidates[0].content.parts[].inline_data`（base64，可夹带 text part） | `data.image_base64[]` 或 `data.image_urls[]`（url 24h 过期） |
| 宽高比/尺寸 | `generationConfig.imageConfig.aspectRatio`；1K/2K/4K | `aspect_ratio` 8 预设（最高 1344x576）或 `width/height`（≤2048，8 倍数） |
| 一次多图 | 多 part / 多 candidate | `n` ∈ [1,9] |
| 参考图 | 任意数量、任意内容，通用编辑 | `subject_reference` 仅 `character`（人像身份保持），**非通用图编辑** |
| 文本渲染 | 官方主打 infographic/diagram/文字渲染 | 官方未宣传文字渲染能力 |
| 成本量级 | 输出图 $0.067/张（preview 定价） | $0.0035/张（国际 pay-as-you-go；TokenPlan 按此扣减） |
| 速率 | 按 tier RPD/RPM | 官方 10 RPM（image-01） |

### 4.4 需适配层（AutoFigure-Edit 落地）

1. **客户端替换**：新增 MiniMax 图片生成 client（请求 `POST /v1/image_generation` + `Authorization: Bearer <Subscription Key>`），替代 Gemini `generateContent` 调用。参数映射：Gemini `prompt` → MiniMax 顶层 `prompt`；Gemini `imageConfig.aspectRatio` → MiniMax `aspect_ratio`；删除 `response_modalities`（image-01 恒输出图）。
2. **输出解析**：Gemini 的 `parts[].inline_data` 遍历 → MiniMax 取 `data.image_base64[]`（建议 `response_format=base64`，避免 url 24h 过期需立即下载）。一次请求 `n` 张按序落盘。
3. **模型名**：MiniMax 用 `image-01`（不要用 `image-01-live`——live 带风格滤镜且 21:9 不支持）。
4. **错误处理**：映射 `base_resp.status_code`（1002 限流重试、1004/2049 鉴权、1008 配额/余额、1026 敏感内容）；`metadata.failed_count>0` 表示部分图被内容安全拦截（不报错，需自行判别）。
5. **配额监控**：TokenPlan 5h 滚动 + 周窗口，用 `/v1/token_plan/remains` 或控制台 usage bar；10 RPM 限流需退避重试。
6. **参考图注意**：image-01 的 `subject_reference` 仅支持 `character`（人像）。AutoFigure-Edit 若打算把图生图用于「方法图 → 示意草图」需先实测 image-01 对非人像参考图的行为（官方仅承诺人像），否则应保持纯文生图 + SAM3 分割的下游不变。
7. **区域**：先确认用户 TokenPlan 是国际（minimax.io）还是中国（minimaxi.com）区——决定 base URL、Subscription Key 签发地、价格表。

---

## 来源

**MiniMax 官方（primary）**
- TokenPlan 总览：https://platform.minimax.io/docs/token-plan/intro
- TokenPlan 定价：https://platform.minimax.io/docs/guides/pricing-token-plan
- TokenPlan FAQ：https://platform.minimax.io/docs/token-plan/faq
- TokenPlan 订阅页（国际）：https://platform.minimax.io/subscribe/token-plan
- TokenPlan 订阅页（中国）：https://platform.minimaxi.com/subscribe/token-plan
- TokenPlan 集成/Agent 工具配置：https://platform.minimax.io/docs/token-plan/other-tools
- mmx-cli 指南：https://platform.minimax.io/docs/token-plan/minimax-cli
- 定价总览：https://platform.minimax.io/docs/pricing/overview
- 按量计费（国际）：https://platform.minimax.io/docs/guides/pricing-paygo
- 按量计费（中国）：https://platform.minimaxi.com/docs/guides/pricing-paygo
- 文生图 API（中国区，OpenAPI 3.1）：https://platform.minimaxi.com/docs/api-reference/image-generation-t2i
- 文生图 API（国际区）：https://platform.minimax.io/docs/api-reference/image-generation-t2i
- 图生图 API（国际区）：https://platform.minimax.io/docs/api-reference/image-generation-i2i
- 图片生成指南：https://platform.minimax.io/docs/guides/image-generation
- 图片生成模型总览：https://platform.minimax.io/docs/api-reference/api-overview
- 速率限制：https://platform.minimax.io/docs/guides/rate-limits
- OpenAI SDK 兼容（Chat Completions 仅）：https://platform.minimax.io/docs/api-reference/text-openai-api
- 官方 SDK npm：https://www.npmjs.com/package/minimax-api
- 官方 CLI GitHub：https://github.com/MiniMax-AI/cli

**Google Gemini API（官方，用于对比）**
- Nano Banana 图片生成：https://ai.google.dev/gemini-api/docs/generate-content/image-generation
- Gemini 3 Developer Guide（generateContent，含 preview 模型定价）：https://ai.google.dev/gemini-api/docs/generate-content/gemini-3
- Changelog（preview 模型 2026-06-25 弃用公告）：https://ai.google.dev/gemini-api/docs/changelog
- generateContent 参考：https://ai.google.dev/gemini-api/api/generate-content

**二手旁证（非契约依据，仅标注）**
- minimax-ai.chat 对 image-01 定价/限速的转述：https://minimax-ai.chat/models/minimax-image-01/
- amux.ai 第三方 OpenAI 兼容包装（证实官方无 images 兼容层）：https://www.amux.ai/docs/amux-api/image/minimax-image-01
- 302.ai 第三方价格（0.01 PTC/次）：https://doc-en.302.ai/270134792e0

---

## 结论（对 AutoFigure-Edit 的落地要点 + 待确认项）

### 落地要点

1. **TokenPlan = 官方订阅**：用 Subscription Key（`sk-cp-…`）作为 `Authorization: Bearer` 凭证，**走官方 endpoint** `POST https://api.minimaxi.com/v1/image_generation`（或国际 `api.minimax.io`），无独立 TokenPlan endpoint、无需第三方网关。
2. **请求最小集**：`{model: "image-01", prompt, aspect_ratio, response_format, n}`；`response_format` 建议 `base64`（url 24h 过期，需立即下载）。
3. **输出解析**：`data.image_base64[]` / `data.image_urls[]`；注意 `metadata.failed_count`（内容安全拦截不报错）与 `base_resp.status_code` 错误码（1002 限流重试、1008 余额/配额不足）。
4. **适配层**：新增 MiniMax client 替代 Gemini `generateContent`——prompt 顶层化、aspect_ratio 映射、response_modalities 移除、输出按 `n` 张落盘；错误码映射 + 10 RPM 退避重试。
5. **成本优势明显**：国际官方 $0.0035/图 vs 项目现 Gemini preview 定价 $0.067/输出图；且 **`gemini-3.1-flash-image-preview` 已弃用关闭（2026-06-25）**，迁移是必要动作。
6. **监控配额**：TokenPlan 5h 滚动 + 周窗口、超额走 Credits；用 `/v1/token_plan/remains`（国际）或控制台 usage bar。

### 待确认项

1. **区域**：用户 TokenPlan 是国际（minimax.io）还是中国（minimaxi.com）区？决定 base URL、Key、价格表（未确认前按两区并列实现，运行时选）。
2. **中国区 image-01 按量单价**：`platform.minimaxi.com/docs/guides/pricing-paygo` 本次未抓全 image 小节，人民币单价未确认（国际 $0.0035/张可作量级参考）。
3. **image-01 经 TokenPlan 的扣减行为**：官方口径「按 pay-as-you-go 目录价扣减」应成立，但实际以用户控制台 usage bar 为准，需实测一张后核对。
4. **典型生成延迟**：官方未公开，需实测（同步调用，预期数秒~十几秒）。
5. **非人像参考图**：image-01 的 `subject_reference` 官方仅支持 `character`（人像）；AutoFigure-Edit 若需图生图式参考，需实测非人像输入行为（否则纯文生图）。
6. **中国区 TokenPlan 剩余配额 endpoint**：官方 FAQ 只给了国际 `www.minimax.io/v1/token_plan/remains`，中国区对应域名未确认。
7. **文字渲染质量**：科研示意图常含标签/标题文字，image-01 官方未宣传文字渲染能力（Gemini 3 主打此点）——需用真实科研方法 prompt 实测示意图质量与文字清晰度，再决定是否需要 prompt 策略（如「no text / minimal labels」或把文字留给下游 SVG 装配）。

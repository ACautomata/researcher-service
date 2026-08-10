# #568 规格:history 归一化增强(附件元数据 / sender / 相邻 text 合并 / reply)

> 判定依据:`#558`(维度2 渲染翻译,官方 `message-normalizer.ts` 663 行 vs 我们 `translateHistoryMessage` ~30 行)。
> 官方源:`openclaw/openclaw main` 的 `ui/src/lib/chat/message-normalizer.ts`(本规格行号区间来自 2026-08-10 抓取)。
> 档位:**C 档**——官方 `message-normalizer` 依赖主仓共享层(`../../../../src/`×4:`attachment-normalize`/`sender-identity`/`inline-directives`/`strip-inbound-metadata`),**不可 npm 移植,只抄思路自写**。范围按面板需要裁剪。
> 目标:产出 history 归一化增强的实现规格(范围裁剪 / 各字段改造点 / 与 #565 thinking 票边界 / 验收),交 `#556` 收口。**本票只规划,不写实现代码。**

---

## 0. 最终范围(先定调,全文围绕它)

**四块子能力,只有「附件元数据」是真增强;其余三块一块已等价、两块裁剪。**

| 子能力 | 判定 | 一句话 |
|--------|------|--------|
| **附件元数据**(durationMs/sizeBytes/width/height + document 型 + label + url 形态) | ✅ **做** | 唯一真增强:发送侧 echo 数据已在 wire 上却被提取层丢弃 |
| **相邻 text 合并** | ⏭️ **跳过**(已等价) | 官方逐块 `join('\n')` 与我们 `join('')` 对面板单 assistant 消息语义等价 |
| **sender 标签** | ❌ **裁剪** | 面板单容器单 agent,无多来源消息,全 repo 无消费场景 |
| **reply 目标** | ❌ **裁剪** | 依赖内联指令解析(共享层 C 档),面板无 reply 交互,证据不足 |

**优先级**(票内已定):附件元数据 > sender 标签 > reply。本规格把资源集中在附件元数据,sender/reply 给出裁剪的实证理由。

---

## 1. 官方做法 vs 我们现状(逐块对照)

### 1.1 附件归一化(官方 `message-normalizer.ts:230-564`)

官方附件有**三条来源路径**,字段全集远超我们:

```
(a) item.attachment 规整对象(:230-280)   —— kind/url/label + mimeType/isVoiceNote/
    artifactId/playback/sizeBytes/durationMs/width/height,全条件透传(有才带上)
(b) item.url 裸 audio/video(:345-476)   —— coerceManagedMediaContentBlock,从 item.url 读,
    label 回退 fileName→label→"Audio"/"Video"
(c) item.source base64/url(:479-564)    —— coerceAudioContentBlock,source.type=base64→dataURL
    / source.type=url→直用 url
```

**字段全集**:`kind(image|audio|video|document) / url / label / mimeType / isVoiceNote / artifactId / playback(native|transcode) / sizeBytes / durationMs / width / height`。

**我们**(`eventTranslate.ts:87-110` `extractMessageAttachments` + `:117-134` `attachmentToMediaBlock`):
- 只认 `b.content`(裸 base64)的 `image/audio/video` **三型**;
- 只提取 `type/mimeType/src/fileName` 四字段;
- **不识别** `document` 型、`item.attachment`/`item.url` 形态、`sizeBytes/durationMs/width/height/label/artifactId/playback/isVoiceNote`。

### 1.2 sender 身份(官方 `:620-670`)

官方从 `m.__openclaw` 元数据读 `senderId/senderName/senderUsername/senderProfileAvatarUrl`,回退 `m.senderLabel`(经 `splitOpaqueIdLabel` 剥离不透明 id 后缀)。**这是 control-ui 多来源(IM/多 agent)场景的身份呈现**。

**我们**:面板单容器单 `main` agent,history 消息 role 只有 `user/assistant` 两类(`historyRole` 归一 operator/user/human→user、其余→assistant)。全 repo `grep senderLabel/__openclaw/senderId` **零命中**——无任何消费场景。

### 1.3 相邻 text 合并(官方 `:420-435`)

官方 `mergeAdjacentTextItems`:相邻 text 块 `join('\n')` 合并,末尾滤掉空白 text 块。

**我们**(`extractMessageText:55-67`):已对所有 `type==='text'` 块 `.join('')` 拼接——**本质就是跨块合并**。差异仅在分隔符(`\n` vs 无)与空白过滤,对面板单 assistant 消息的连续正文无可见差别。

### 1.4 reply 目标(官方 `:520-545, 600-615`)

官方 `parseInlineDirectives`(依赖共享层)从文本内联指令解析 `replyToExplicitId/replyToCurrent`,产 `replyTarget{kind:id|current}`。面板无 reply 交互入口,全 repo 零命中。

---

## 2. 数据可行性(增强有没有数据可显示?)

这是「附件元数据是不是空增强」的实证地基。**两条附件数据路分别判定:**

### 2.1 发送侧 echo 路 —— ✅ 数据已在 wire 上,增强有真实数据

```
fileToRawAttachment(attachments.ts:123)  → 填 sizeBytes=file.size(图片压缩路径另产 width/height)
buildAttachments(attachments.ts:204)     → 原样透传 type/mimeType/fileName/content/
                                            sizeBytes/durationMs/width/height(:224-233)
gatewayChat.send(gatewayChat.ts:580)     → attachments 非空时携带进 chat.send
```

**结论:采集层已捕获、校验层已透传全部 4 个元数据。** 但 `attachmentToMediaBlock`(`eventTranslate.ts:117`)只提取 `type/mimeType/src/fileName`——**元数据在提取时被丢弃**。发送 echo 增强是「把已有数据接进 MediaBlock」,**零数据不确定性,立即可做**。

### 2.2 history 路 —— ⚠️ 网关 display-normalized 是否回填元数据,本会话无法实测

history 附件块实测形状(repo 固化校准,`eventTranslate.test.ts:382-459`):`{type:image|audio|video, mimeType, content:纯base64}`——**走 `b.content` 裸 base64,无 `url/label/attachment` 子对象**。

网关 display-normalized(上游 `attachment-normalize.ts`)**是否**在 history 附件块上回填 `sizeBytes/durationMs/width/height/label`?**本会话无法实测**(无真容器;worktree 沙箱断网,`npm install` 失败、无法起 dev server 配对产消息)。

**对策(0 信任条件透传,天然容错):** 增强采用「有才带上、缺则不带」的条件透传——网关回填则显示,不回填则与现状一致(不渲染元数据),**无负向风险**。同时把「实测 history 附件块真实字段」列为实施期首个验证项(见 §6)。

---

## 3. 范围裁剪判定(sender / reply / 相邻 text)

### 3.1 sender 标签 —— ❌ 裁剪

- **无场景**:面板单容器单 agent,history 里只有 user/assistant 两个角色,不存在 control-ui 的「多来源 IM 消息需要标注身份」问题。
- **无数据**:全 repo `grep senderLabel/__openclaw` 零命中,`HistoryMessageDTO` 未声明、网关 display-normalized 对面板单 agent 是否下发 `__openclaw.senderId` 属未知且无意义。
- **结论**:不引入。若未来面板接入多 agent/sub-agent 消息(见 map `#569` 外来 run),sender 标签随那一票重估——**现在做是无的放矢**。

### 3.2 reply 目标 —— ❌ 裁剪

- **依赖共享层**:官方 reply 解析靠 `parseInlineDirectives`(主仓 `src/`,C 档),需自写内联指令解析器,成本高。
- **无交互无证据**:面板 composer 无 reply 入口,全 repo 零命中;网关是否对面板下发内联 reply 指令未知。
- **结论**:不引入。属「为多 agent/全功能 control-ui 设计」之列,与 map Out of scope 的 steer/queue/canvas 同类。

### 3.3 相邻 text 合并 —— ⏭️ 跳过(已等价)

官方 `join('\n')` vs 我们 `join('')`:对单条 assistant 消息的连续正文,渲染层 `MarkdownRenderer` 收到的都是拼接后的整段文本。唯一理论差异是块间少一个换行,但官方 history 的相邻 text 块本就源于同一段正文的切片,`\n` 是否「更正确」对面板无实证支撑。**维持现状,零改动**;不为对齐而对齐。

---

## 4. 附件元数据增强 —— 各字段改造点(本票核心)

> 改动全部落在「**`MediaBlock` 投影 + 两个提取纯函数 + 一个渲染分支**」,全部是既有 0 信任条件透传模式的延续,无新增抽象。

### 4.1 `MediaBlock` 接口扩展(`eventTranslate.ts:75-80`)

```ts
export interface MediaBlock {
  type: 'image' | 'audio' | 'video' | 'document'   // + document
  mimeType: string
  src: string            // 纯 base64 或完整 url(见 4.4 双形态)
  fileName?: string
  label?: string         // 新增:展示名(优先于 fileName,回退见 4.4)
  sizeBytes?: number     // 新增,条件透传(number 且 >= 0)
  durationMs?: number    // 新增,条件透传(number 且 >= 0)
  width?: number         // 新增,条件透传(number 且 > 0,仅 image/video 有意义)
  height?: number        // 新增,同上
}
```

- **`document` 型**:`ChatMessageItem.vue:63-90` 现在是 image/audio/video 三个 `v-if/v-else-if`,`document` 会落到分支外**静默不渲染** → 必须新增第 4 分支(下载链接卡:`label/fileName + sizeBytes`)。
- **宽度/高度语义**:官方仅 `video`(及 image)带 width/height;audio 不带。条件透传,不为无意义字段造数。

### 4.2 `extractMessageAttachments`(history/流式路,`eventTranslate.ts:87-110`)

在现有 `b.content` 裸 base64 提取之上,**对每个块加条件透传** + **新增两条来源**:

1. **同形状条件透传**(在现有 `b.content` 块上):
   ```ts
   ...(typeof b.sizeBytes === 'number' && b.sizeBytes >= 0 ? { sizeBytes: b.sizeBytes } : {}),
   ...(typeof b.durationMs === 'number' && b.durationMs >= 0 ? { durationMs: b.durationMs } : {}),
   ...(typeof b.width === 'number' && b.width > 0 ? { width: b.width } : {}),
   ...(typeof b.height === 'number' && b.height > 0 ? { height: b.height } : {}),
   ...(typeof b.label === 'string' && b.label ? { label: b.label } : {}),
   ```
   —— 与官方「有才带上」完全一致;网关不回填则现状不变(见 §2.2)。
2. **新增 `document` 型**:`MEDIA_TYPES` 由 `['image','audio','video']` 扩为含 `'document'`;`b.content` 或 `b.url` 形态皆可(见 4.4)。
3. **新增 `item.attachment` / `item.url` 来源**(官方 `(a)(b)` 路):当块是 `{type:'attachment', attachment:{...}}` 或 `{type:audio|video|document, url}` 时,从对应子对象提取。**防御**:此形态是否出现于面板 history 未实测,条件透传保证「无此形态则零影响」。

### 4.3 `attachmentToMediaBlock`(发送 echo 路,`eventTranslate.ts:117-134`)

`Attachment`(`attachments.ts:14`)已声明 `sizeBytes/durationMs/width/height`,`buildAttachments` 已透传——本函数**补提取即可**,与 4.2 共用同一组条件透传判定(避免两路 drift,与现有「mimeType 主段派生 type / string content 门」共用逻辑的姿势一致):

```ts
...(typeof a.sizeBytes === 'number' && a.sizeBytes >= 0 ? { sizeBytes: a.sizeBytes } : {}),
...(typeof a.durationMs === 'number' && a.durationMs >= 0 ? { durationMs: a.durationMs } : {}),
...(typeof a.width === 'number' && a.width > 0 ? { width: a.width } : {}),
...(typeof a.height === 'number' && a.height > 0 ? { height: a.height } : {}),
```

—— **这是本票唯一「数据已确证、零不确定性」的增强点**(§2.1)。

### 4.4 url 形态附件的 `src` 双形态(防御,与 `mediaSrc` 兼容)

`mediaSrc`(`ChatMessageItem.vue:30`)现在:`m.src.startsWith('data:')` 原样返回,否则拼 `data:<mime>;base64,`。**对真 url(http/…)会拼错**。

- **`MediaBlock.src` 语义扩为「纯 base64 或完整 url」**:base64 块照现状存裸 base64;url 形态块(4.2 来源 3)`src` 直存完整 url。
- **`mediaSrc` 补一分支**:`/^https?:\/\//i.test(m.src)` → 原样返回(不进 base64 拼接)。
- **下载型 `document`**:url 形态下 `<a :href="m.src" download>`;base64 形态下 dataURL 作 href(注意大体型 base64 document 的 dataURL 体积——`MAX_ATTACHMENT_BYTES` 已有上限兜底)。

### 4.5 `translateHistoryMessage`(history 组装,`useChatConnection.ts:894-913`)

**零新增逻辑**。它已调用 `extractMessageAttachments(m)`(`:902`)填 `media`——4.2 扩展后,history 附件自动带上元数据,本函数**一行不改**。

### 4.6 流式路(`translateDelta:213` / `translateFinal:249`)

同 4.5——两路都复用 `extractMessageAttachments`,扩展后流式 replace/final 快照的附件自动带元数据。**本规格不新增流式分支**(附件提取本就双路径复用同一实现,与 `#459-T3` 的「单一实现」约束一致)。

---

## 5. 与 #565 thinking 票的边界(硬约束)

**本票绝不碰 `thinking` 字段。**

- `translateHistoryMessage` 的 `thinking: ''`(`useChatConnection.ts:907`)是 **`#565` 的 history 路改造点**,本票保持原样。
- 本票 `extractMessageAttachments` 只认 image/audio/video/document 附件块,**继续跳过 `thinking` 块**(`eventTranslate.test.ts:416` 已有「非 media 块→空数组」用例守着这条线)。
- 两票都触 `eventTranslate.ts` 与 `useChatConnection.ts`(`#556` 已标注文件冲突),但**改动点正交**:#565 动「text/thinking 块 → thinking 字段」,本票动「附件块 → MediaBlock 元数据」。实施顺序与冲突合并策略归 `#556` 统一收口,本票不越界。

---

## 6. 验收(对现有 ~9000 行行为测试的影响)

### 6.1 首个验证项(实施期第 0 步,先于一切改动)

**实测网关 history 附件块真实字段**:起一个真容器 + 配对会话,发一条带图片/音视频附件的消息,`chat.history` 拉回原始 JSON,确认 `content[]` 附件块是「裸 base64 四字段」还是「官方规整对象(含 url/label/sizeBytes/durationMs/width/height)」。**同一次实测顺带核对 `document` 型与 `item.attachment`/`item.url` 形态是否真出现**——它们超出 `#558` 的 image/audio/video 三型枚举,若实测不见,则 §4.2 来源 3 与 §4.4 收窄为纯防御(可不实现),只保留同形状条件透传 + 发送 echo。
- 若**有元数据** → §4.2 条件透传直接生效,截图断言元数据上屏。
- 若**裸 base64** → §4.2 条件透传零影响(现状),增强价值落在发送 echo 路(§4.3)+ document/url 形态防御;history 元数据随上游版本演进自然获得。
- 本会话因沙箱断网无法执行,**此验证项随实施票/环境可用时先行**。

### 6.2 不回归

- `eventTranslate.test.ts` 现有附件用例(`:382-459`):四字段形状不变(新字段全可选),**应全绿**。
- `extractMessageText` 多态用例(`:357-377`):本票不动文本提取,全绿。
- `attachmentToMediaBlock` 共用逻辑:发送 echo 现有用例全绿。

### 6.3 新增用例(实施期)

- `extractMessageAttachments`:块带 `sizeBytes/durationMs/width/height/label` → 条件透传进 MediaBlock;缺省/非法值(负数、非 number)→ 不带。`document` 型块 → `type:'document'`。`item.attachment`/`item.url` 形态 → 提取。
- `attachmentToMediaBlock`:`Attachment` 带 4 元数据 → 透传。
- `ChatMessageItem`:`document` 块 → 渲染下载卡;url 形态 src → `mediaSrc` 原样返回不拼 base64。
- **截图/断言验收**:发送 echo 一条带 sizeBytes 的图片,断言气泡内显示尺寸/体积;document 附件断言出现下载链接。

---

## 7. 删除清单 / 触及文件汇总

**触及(改动)**:
- `frontend/src/chat/eventTranslate.ts` — `MediaBlock`(扩字段)+ `extractMessageAttachments`(条件透传 + document + attachment/url 来源)+ `attachmentToMediaBlock`(透传 4 元数据)。**与 #565 共触文件**。
- `frontend/src/components/chat/ChatMessageItem.vue` — 新增 `document` 分支 + `mediaSrc` 的 url 分支。
- `frontend/src/chat/attachments.ts` — 仅当采集层需在非压缩路径也产 `width/height/durationMs` 时补(可选;当前 sizeBytes 已够,音视频 durationMs 属增强可选)。

**触及(零改动,自动受益)**:
- `useChatConnection.ts` `translateHistoryMessage`(:902 复用 `extractMessageAttachments`)。
- 流式 `translateDelta`/`translateFinal`(同复用)。

**不做(裁剪)**:
- sender 标签(`__openclaw`/`senderLabel` 解析)——无场景无数据。
- reply 目标(`parseInlineDirectives`)——C 档高成本无交互。
- 相邻 text 合并分隔符对齐——已语义等价,不为对齐而对齐。
- 官方 `message-normalizer` 的 canvas 预览 / 语音便签 / 元数据剥离(`stripInboundMetadata`)——map Out of scope 已含 canvas;语音便签(isVoiceNote)、元数据剥离面板精简场景用不上。

---

## 8. 一句话交接

**把「发送侧已有却被丢弃的附件元数据」接进 `MediaBlock`(零不确定性、立即可做),history 路用 0 信任条件透传兜底(网关回填即显示、不回填则现状),并补 `document` 型与 url 形态的渲染分支;sender/reply/text 合并经实证判定裁剪或已等价。thinking 字段归 #565,本票不碰。**

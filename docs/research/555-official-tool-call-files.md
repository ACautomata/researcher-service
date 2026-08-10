# 官方 control-ui 工具调用渲染三文件研究（#555）

**研究问题**：官方 control-ui（Lit + Vite）的三个「纯 TS」工具调用渲染翻译文件，能否直接抄进我们的 Vue3 面板？逐项核实其导出符号、view-model 输入/输出形状、import 依赖（是否真 0 共享层）、分类/多 harness 兼容/basename/diff/聚合逻辑，并给出移植注意。

**来源**（仓库 `openclaw/openclaw`，默认分支 `main`，经 `gh api repos/.../contents` 全量抓取）：

| 文件 | raw URL |
|---|---|
| `tool-call-view.ts` | https://raw.githubusercontent.com/openclaw/openclaw/main/ui/src/lib/chat/tool-call-view.ts |
| `tool-call-diff.ts` | https://raw.githubusercontent.com/openclaw/openclaw/main/ui/src/lib/chat/tool-call-diff.ts |
| `tool-call-grouping.ts` | https://raw.githubusercontent.com/openclaw/openclaw/main/ui/src/lib/chat/tool-call-grouping.ts |

- blob sha（`tool-call-view.ts`，contents API 返回）：`36070f3bb17f205ae39ba359a1851e4083e22eb9`
- 最近触及 commit：`79f3474836be71b8c5c7e5bb50b9ecab5981a595`（2026-07-31，"fix(ui): preserve chat stream ownership and accessible rendering (#116929)"）
- 抓取日期：2026-08-10（今日）

---

## 一号结论（最重要）：并非「0 共享层依赖」

预期「三个文件都是 0 共享层依赖、纯 TS」**部分错误**。逐项核实如下：

| 文件 | 是否 0 依赖 | 实际 import |
|---|---|---|
| `tool-call-diff.ts` | **是（真 0 import）** | 无任何 import 语句 |
| `tool-call-view.ts` | 否 | `@openclaw/normalization-core/record-coerce`（npm/workspace 包）+ 同目录 `./tool-call-diff.ts` + 同目录 `./tool-call-patch.ts` |
| `tool-call-grouping.ts` | 否 | `../../i18n/index.ts`（UI i18n 模块）+ 同目录 `./tool-call-view.ts` |

关键事实：

- **没有任何一个文件 import `../../../../src/`**（openclaw 主仓共享层）。已对三文件逐一 grep `../../../../src/`、`tool-display`、`tool-cards`，命中数均为 0。所以「主仓 src 共享层」这一档确实干净。
- **但 `tool-call-view.ts` 与 `tool-call-grouping.ts` 都有真实外部依赖**，只是不是 `../../../../src/`：
  - `@openclaw/normalization-core/record-coerce` 是 monorepo 内 `packages/normalization-core` 包（非 npm 公开包，是 workspace 依赖）。
  - `../../i18n/index.ts` 是 UI 的状态式 i18n 管理器。
- 三文件都**没有**引用 `@openclaw/gateway-client` 或任何其他 npm 运行时包。

**结论修正**：「0 共享层依赖」应精确表述为「0 `../../../../src/` 主仓共享层依赖」。`tool-call-diff.ts` 唯一真 0 依赖；另两个文件各带一个需处理的依赖（record-coerce / i18n），但两者都极易替代（见「移植注意」）。

---

## 导出符号与依赖

### 1. `tool-call-view.ts`

**完整 import**：

```ts
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  buildWriteDiffLines, computeLineDiff, countTextLines, diffStat,
  joinDiffSections, MAX_DIFF_RENDER_LINES, parseDiffDetailsString,
  type DiffLine, type DiffStat,
} from "./tool-call-diff.ts";
import { parsePatchView } from "./tool-call-patch.ts";
```

**导出符号**：

```ts
export type ToolCallKind = "command" | "read" | "edit" | "write" | "search" | "fetch" | "generic";

export type ToolCallView = {
  kind: ToolCallKind;
  command?: string;        // command 行的完整命令文本（折叠时只显首行）
  target?: string;         // 文件 basename 或主目标，行内加粗
  targetDetail?: string;   // 淡显次级细节（目录、查询范围、URL host…）
  diff?: DiffLine[];       // edit/write 的内联 diff 行
  stat?: DiffStat;         // { added, removed }
};

export function resolveToolCallTargetPaths(name: string, args?: unknown): string[];
export function resolveToolCallKind(name: string, args?: unknown): ToolCallKind;
export function resolveToolCallView(source: ToolCallViewSource): ToolCallView;
export function unwrapShellWrapperCommand(command: string): string;
```

（`ToolCallViewSource` 为文件内 `type`，未 export——见「view-model 输入形状」。）

### 2. `tool-call-diff.ts`

**完整 import**：**无**（0 import，真自包含）。

**导出符号**：

```ts
export type DiffLineKind = "add" | "del" | "ctx" | "file" | "skip";
export type DiffLine = {
  kind: DiffLineKind;
  lineNo?: number;   // 1-based；add/ctx 用新文件行号，del 用旧文件行号
  text: string;
};
export type DiffStat = { added: number; removed: number };

export const MAX_DIFF_RENDER_LINES = 400;   // （另有内部 MAX_DIFF_INPUT_LINES = 600）

export function diffStat(lines: readonly DiffLine[]): DiffStat;
export function parseDiffDetailsString(diff: string): DiffLine[] | null;
export function computeLineDiff(oldText: string, newText: string): DiffLine[];
export function buildWriteDiffLines(content: string, maxLines = 80): DiffLine[];
export function countTextLines(content: string): number;
export function joinDiffSections(
  sections: ReadonlyArray<DiffLine[]>,
  options?: { truncated?: boolean; maxLines?: number },
): DiffLine[];
```

### 3. `tool-call-grouping.ts`

**完整 import**：

```ts
import { t } from "../../i18n/index.ts";
import {
  resolveToolCallKind, resolveToolCallTargetPaths, type ToolCallKind,
} from "./tool-call-view.ts";
```

**导出符号**：

```ts
export function summarizeToolGroup(cards: readonly ToolGroupSummaryInput[]): string;
```

（`ToolGroupSummaryInput`、`GroupCounts` 均为文件内 `type`，未 export。）

### 依赖判定（逐项）

| 依赖项 | view | diff | grouping | 性质 |
|---|---|---|---|---|
| `../../../../src/`（主仓共享层） | ✗ | ✗ | ✗ | 三文件均无，干净 |
| `@openclaw/normalization-core/record-coerce` | ✓ | ✗ | ✗ | monorepo workspace 包（`packages/normalization-core`） |
| `@openclaw/normalization-core`（其他子路径） | ✗ | ✗ | ✗ | — |
| 其他 npm 包 | ✗ | ✗ | ✗ | 无 |
| `../../i18n/index.ts` | ✗ | ✗ | ✓ | UI 状态式 i18n |
| `./tool-call-diff.ts` | ✓ | — | ✗ | 同目录 sibling |
| `./tool-call-patch.ts` | ✓ | ✗ | ✗ | 同目录 sibling |
| `./tool-call-view.ts` | — | ✗ | ✓ | 同目录 sibling |
| `tool-display.ts` / `tool-cards.ts` / `tool-display.json` | ✗ | ✗ | ✗ | 三目标文件均不依赖 |

**传递依赖**：抄 view 必须连带 `tool-call-diff.ts`（0 依赖，白送）+ `tool-call-patch.ts`；而 `tool-call-patch.ts` 自己也 import `@openclaw/normalization-core/record-coerce` + `./tool-call-diff.ts`。所以 record-coerce 这一依赖会经 view → patch 两条路传入。

---

## view-model 输入形状

### `resolveToolCallView(source)` 的入参 `ToolCallViewSource`

```ts
type ToolCallViewSource = {
  name: string;      // 工具名（任意大小写/空白，内部 normalize 为小写）
  args?: unknown;    // 工具参数对象；经 asRecord 强制为 Record<string,unknown>，非对象则 null
  details?: unknown; // 结果侧细节对象（live 行先只有 args，后补 details，如 edit 的 diff）
};
```

逐字段：
- **`name: string`** — 工具名。内部 `normalizeKey` = `trim().toLowerCase()`。
- **`args?: unknown`** — 调用参数。函数内 `asRecord(args)` 归一；非对象按 `null` 处理。具体读取的参数字段见「分类/兼容逻辑」。
- **`details?: unknown`** — 结果/回执细节。**关键**：edit/write 的权威 diff 优先从 `details.diff`（预生成字符串）读；`details.changed === false` 表示 write 无变更；`details.created === true` 影响 write 的 stat 是否权威。

> 注意：入参**不是** `command`/`path`/`state`/`result` 平铺字段，而是 `name + args + details` 三元组；所有 `command`/`file_path`/`path` 等都从 `args` 内取。

### `summarizeToolGroup(cards)` 的入参 `ToolGroupSummaryInput`

```ts
type ToolGroupSummaryInput = {
  name: string;    // 工具名
  args?: unknown;  // 工具参数（用于分类 + 提取去重路径）
  isError?: boolean; // 该调用是否失败（计入 failed 数）
};
```

### diff 文件：纯函数，无「view-model」概念

- `computeLineDiff(oldText: string, newText: string)` — 两段纯文本。
- `parseDiffDetailsString(diff: string)` — 预生成 diff 字符串（`+457 text` / `-455 text` / ` 456 text` / `...` 格式）。
- `buildWriteDiffLines(content: string, maxLines?)` — 写入文件全文。
- `joinDiffSections(sections, options?)` — 多段 `DiffLine[]` 拼接。

---

## 输出形状

### `resolveToolCallView` → `ToolCallView`（结构化 view-model 对象，非字符串）

UI 按 `kind` 消费：
- `command` → 渲染 `command`（首行折叠）。
- `read` / `edit` / `write` / `search` / `fetch` → 渲染 `target`（加粗 basename / pattern / url）+ `targetDetail`（淡显目录/范围）。
- `edit` / `write` → 额外渲染 `diff: DiffLine[]` + `stat: {added, removed}`。
- 任何分类解析失败 → 退化为 `{ kind: "generic" }`（无 target/diff）。

`DiffLine.kind` 五值：`add`/`del`/`ctx`（上下文行）/`file`（多文件 patch 的分隔标题行，text 如 `Update foo.ts`）/`skip`（截断省略标记，text 恒 `""`）。

> view 内部用 `WeakMap` 做缓存（cache key = args 对象，且记录 details/name 以在 details 后到时失效）。**Vue3 平移注意**：这是依赖 args 对象引用身份的优化，可选，不影响正确性。

### `summarizeToolGroup` → `string`（折叠组标签，纯文案）

返回已本地化、首字母大写、`, ` 拼接的摘要串，如 `Ran 13 commands, read 6 files, edited 9 files, created a file`；有失败时追加 ` · {count} failed`。

---

## 分类 / 兼容 / diff / 聚合 逻辑细节

### A. `tool-call-view.ts`：工具分类逻辑（`resolveToolCallKind`）

先 `normalizeKey(name) = trim().toLowerCase()`，再按以下顺序判定（前面的优先）：

1. **text-editor 工具**（`str_replace_editor` / `str_replace_based_edit_tool`）→ 看 `args.command`（亦小写）：
   - `view` → read；`str_replace`/`insert`/`undo_edit` → edit；`create` → write；其他/缺失 → generic。
2. **command**：`bash` `exec` `shell` `run_command` `run_terminal_cmd`。
3. **read**：`read` `read_file` `readfile` `notebookread` `notebook_read`。
4. **edit**：`edit` `edit_file` `multiedit` `multi_edit` `notebookedit` `notebook_edit`；**以及 patch 工具** `apply_patch` `applypatch` `patch` → 也归 edit。
5. **write**：`write` `write_file` `create_file`。
6. **search**：`grep` `find` `glob` `ls` `list` `codebase_search`。
7. **fetch**：`web_fetch` `webfetch` `fetch`。
8. **arg-shape 兜底**：以上都不中，若 `args` 是对象、有 string 型 `command` 字段、且 `Object.keys(args).length <= 3` → command（兼容 harness 专属命令工具）。
9. 否则 → generic。

工具名表全部是 `Set<string>`，匹配前已小写化。

### B. 多 harness 参数拼写兼容

**路径字段**（`resolvePathArg`，按序取第一个非空 string）：
```
path → file_path → filePath → file → filepath → filename → notebook_path
```
（即 Claude 的 `file_path` 与 Codex 的 `path` 都在变体表里，连同 camelCase `filePath` 等。）

**edit 的 old/new 文本对**（`readEditPairs`）：
- 多 edit：`args.edits[]`（数组），每项按序取
  - old：`oldText ?? old_string ?? oldString ?? old_str`
  - new：`newText ?? new_string ?? newString ?? new_str`
- 单 edit：直接在 `args` 上取同名四个变体。
- 上限：`MAX_LOCAL_DIFF_PAIRS = 8` 对、`MAX_LOCAL_DIFF_INPUT_CHARS = 120_000` 字符，超出标记 truncated。

**text-editor 命令字**：`command`（值域 `view`/`str_replace`/`create`/`insert`/`undo_edit`）。

**search 的查询**：`pattern ?? query ?? glob`；路径仍走 `resolvePathArg` 兜底 `args.path`。

**write 的内容**：text-editor `create` 用 `file_text`，其余 write 用 `content`。

**fetch**：`url`。

**command**：`command`（再经 `unwrapShellWrapperCommand` 剥 `sh -lc '...'`/`bash -c "..."` 外壳，正则 `^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]+)\1\s*$`，仅显示用）。

### C. 路径 basename 逻辑（`splitPathForDisplay`）

- 取路径字段：`resolvePathArg`（上表）。
- basename：`path.replace(/\\/g,"/").replace(/\/+$/,"")`（反斜杠归一 + 去尾斜杠），取最后一个 `/` 之后为 `base`，之前为 `dir`。
- 边界：若无 `/` 或 `/` 在首位（`slash <= 0`），返回 `{ base: normalized || path }`（无 dir）。
- 输出：`target = base`（加粗），`targetDetail = dir`（淡显）。patch 的 move 行若两文件同目录则 `targetDetail` 显共同目录、`target` 显 `base1 → base2`。

### D. `tool-call-diff.ts`：diff 逻辑

**两个数据源**（view 中优先 details，缺则本地算）：
1. **预生成 diff 字符串解析**（`parseDiffDetailsString`）：解析 edit 工具的 `generateDiffString` 输出——行格式 `+457 text`（add）、`-455 text`（del）、` 456 text`（ctx，前导空格）、`...` / `...(truncated)...`（skip）。逐行正则 `^([+\- ])\s*(\d+) ?(.*)$`；任一非空行不匹配则整体返回 `null`（让调用方回退原始文本）。超 `MAX_DIFF_RENDER_LINES` 截断补 skip。仅当含至少一个 add/del 才返回。
2. **本地行 diff**（`computeLineDiff(oldText, newText)`）：**经典 LCS（最长公共子序列）动态规划表**，纯手写、**无第三方 diff 库**。输入各限 `MAX_DIFF_INPUT_LINES = 600` 行（保二次方成本可控）。先 `splitDiffLines`（`\r\n`/`\r`→`\n`；空串=0 行；去尾空元素），回溯时相等→ctx、否则按 lcs 表取向→del/add，尾部余行全补 del/add。最后 `compactLineDiff` 把超 `MAX_DIFF_RENDER_LINES` 的长 diff 折叠：保留每个变更行 ±3 行上下文，间隔处插 `skip`。

**输出**：`DiffLine[]`（带 `kind` + 可选 `lineNo` + `text`），非 `+/-` 前缀裸字符串数组——前缀信息编码在 `kind` 里。

**辅助**：
- `buildWriteDiffLines(content, maxLines=80)`：全新写入文件的全 add 预览，`lineNo` 从 1 编号，超限补 skip。
- `diffStat(lines)`：数 add/del 得 `{added, removed}`。
- `joinDiffSections(sections, {truncated, maxLines})`：multi-edit 多段 diff 用 skip 分隔拼接，超 maxLines 截断。
- `countTextLines(content)`：行数。

### E. `tool-call-view.ts` 的 edit/write diff 组装

- **edit**：`details.diff` 优先（`readDetailsDiff`，含从 `diffText.matchAll(/^([+-])\s*\d+/gm)` 重算 stat）；否则本地 `resolveEditDiff`（读 edits 对 → 每对 `computeLineDiff` → `joinDiffSections`）；text-editor `insert` 用 `resolveInsertionDiff`（`computeLineDiff("", insert_text)`，故意不给 stat 因不知上下文）；`undo_edit` 只用 `details.diff`。patch 工具走 `resolvePatchView`（见 F）。
- **write**：`details.diff` 权威优先 → `details.changed === false` 则无 diff → 否则取内容（`create` 用 `file_text`、其余用 `content`）→ `buildWriteDiffLines`；stat 仅当 `details.created === true` 或无 details 时才给 `{added: countTextLines(content), removed: 0}`。

### F. `tool-call-patch.ts`（view 的连带 sibling）：patch 解析

`parsePatchView(args)` 返回 `{ paths, lines, stat, move? } | null`。三路输入：
1. **结构化**：`args.changes[]`（每项 `{ path, kind: "add"|"delete"|{type,move_path?}, diff?, stat?, diffTruncated? }`）。
2. **Codex apply_patch 文本**：`args.patch ?? input ?? diff`，命中 `*** Begin Patch` / `*** Update/Add/Delete File:` → `parseCodexPatch`（支持 `*** Move to:`）。
3. **unified diff 文本**：否则 `parseUnifiedPatch`（支持 `diff --git a/x b/y`、`---`/`+++`、`@@ -a,b +c,d @@` 头、`/dev/null` 表 add/delete）。

行内 `@@` hunk 头解析出行号，`+`/`-`/` ` 前缀决定 add/del/ctx；多文件时插 `kind:"file"` 标题行（`Add/Delete/Update <path>` 或 `Move <from> → <to>`）。stat 用精确 `stat` 字段或逐行累计。view 把多路径渲染为 `target: "N files"`，move 渲染为 `base1 → base2`。

### G. `tool-call-grouping.ts`：聚合逻辑

**输入**：一串 `ToolGroupSummaryInput[]`（`{name, args?, isError?}`）。

**「连续同类」如何判定**：**本文件不做连续性判定/分组切分**——它假设调用方已把「一段连续工具调用」作为数组传入，只负责对这一整段**计数聚合**。按 `resolveToolCallKind(name, args)` 分类计数；read/edit/write 用 `resolveToolCallTargetPaths` 收集路径到 `Set` 去重（`fileCount = paths.size>0 ? paths.size : calls`，即同文件多次操作按 1 个文件计）。

**摘要文案生成**：
- 顺序固定：commands → reads → edits → writes → searches → fetches → others，各段 `t(oneOrManyKey, {count})`。
- others：≤2 种工具名时 `used {names}` / `used {names} ×{count}`，否则 `used {count} tools`。
- 全空：`Ran a tool call` / `Ran {count} tool calls`。
- 拼接 `segments.join(", ")`，首字母 `toUpperCase`；`failed>0` 时追加 ` · {count} failed`。

**英文文案表**（`ui/src/i18n/locales/en.ts` 的 `toolCards.group`，key 前缀 `chat.toolCards.group.`）：
```
commandsOne "ran a command"        commandsMany "ran {count} commands"
readsOne    "read a file"          readsMany    "read {count} files"
editsOne    "edited a file"        editsMany    "edited {count} files"
writesOne   "created a file"       writesMany   "created {count} files"
searchesOne "ran a search"         searchesMany "ran {count} searches"
fetchesOne  "fetched a page"       fetchesMany  "fetched {count} pages"
namedTool   "used {names}"         namedToolRepeated "used {names} ×{count}"
otherOne    "used a tool"          otherMany    "used {count} tools"
emptyOne    "Ran a tool call"      emptyMany    "Ran {count} tool calls"
failedOne/Many "{count} failed"
```
注意首段首词用大写（`Ran`/`Read`…由首字母大写化保证），后续段保持小写——文案表里全部小写存储，靠 `capitalize` 抬首字母。

---

## 移植注意

1. **三文件互相 import 关系**：`grouping → view → {diff, patch}`，`patch → diff`。`diff` 是叶子（0 依赖）。**要抄 view 必须连 `tool-call-diff.ts` + `tool-call-patch.ts` 一起抄**（patch 不可省，view 的 patch 工具分类依赖它）；抄 grouping 必须连 view（进而 diff+patch）。即：**整套最小抄写集 = 4 个文件（view + diff + patch + grouping）**，不是 3 个。`tool-call-patch.ts` 是与 view 同复杂度的大文件（Codex + unified + structured 三路 patch 解析）。

2. **`@openclaw/normalization-core/record-coerce` 极易内联**：view 与 patch 只用了其中 `asNullableRecord`（别名 `asRecord`）。该函数实现仅一行有效逻辑：
   ```ts
   const asRecord = (v: unknown): Record<string, unknown> | null =>
     (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : null;
   ```
   建议在我们侧写个本地 util 替换，**不必引入该 workspace 包**。tool-cards.ts 还用 `truncateUtf16Safe`（`utf16-slice` 子路径），但那不是三目标文件的依赖。

3. **`tool-call-grouping.ts` 的 `t()` 是最重依赖**：来自 `ui/src/i18n/index.ts` → `lib/translate.ts`，是个带 localStorage、`document` 副作用、异步加载语言包的状态式 `I18nManager`。签名 `t(key, params?: Record<string,string>)`。我们面板**无此 i18n 体系**，移植两条路：
   - (a) 写个薄 `t(key, params)` shim，内含上面那张英文文案表 + `{count}`/`{names}` 插值；或
   - (b) 直接把 `summarizeToolGroup` 改写为硬编码中文/英文文案。
   这是 grouping 移植的**主要工作量**，逻辑本身（计数 + 拼接）很简单。

4. **不需要抄 `tool-display.ts` / `tool-cards.ts` / `tool-display.json`**：三目标文件都不依赖它们。那两个文件确实重度耦合共享层（`../../../../src/agents/...`、`tool-display.json`、canvas-render、tool-content 等），是另一套体系（图标/verb/详情），与本套「分类 + 内联 diff + 聚合摘要」无关。若要图标/verb 需另行评估。

5. **Vue3 平移无障碍**：三文件全是纯 TS 数据转换，无 Lit/DOM/浏览器 API（view/diff/patch 完全无 DOM；grouping 的 DOM 副作用全在被它 import 的 i18n 里，替换掉 `t` 即净）。唯一「身份敏感」点是 view 的 `WeakMap` 缓存（依赖 args 对象引用），Vue3 的响应式 proxy 会改变对象引用身份——**建议直接删掉该缓存**（纯函数每次重算即可，成本可忽略），避免 proxy 下缓存失效逻辑出 bug。

6. **`.ts` 后缀 import**：官方用 `from "./tool-call-diff.ts"`（显式 `.ts` 扩展名，Deno/bundler 风格）。我们 Vite + vue-tsc 下需确认 `allowImportingTsExtensions` 或改写为无扩展名 import。

7. **view-model 对接**：我们的 chat 流水线（`eventTranslate.ts` / `chatStore.ts`）需为每个工具调用产出 `{ name, args, details }` 三元组喂给 `resolveToolCallView`、产出 `{ name, args, isError }[]` 喂给 `summarizeToolGroup`。注意 `details` 是**结果侧**对象（含 `diff`/`changed`/`created`），live 行先只有 args——我们的 normalizer 需区分「调用参数」与「结果细节」两个来源。

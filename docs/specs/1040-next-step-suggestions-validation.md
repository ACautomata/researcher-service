# #1040 草稿、快捷键与可访问性交互验收

2026-11-20。基线为 `origin/master` 的 `ab99e71`，已包含 #1037、#1038 和 #1039。

| 任务单验收项 | 证据 |
| --- | --- |
| 有效提示仅在空输入、可采用时显示 | `ChatView.test.ts` 通过会话投影与 SSE 更新验证晚到提示和忙碌门禁。原有来源校验继续由 `useChatSession.test.ts` 覆盖。Chrome 验证 239 px 宽的输入框可完整显示长提示，浅色与深色主题对比度分别约为 6.11:1 和 12.29:1。 |
| 未采用提示独立于草稿、历史和发送 | `ChatView.test.ts` 检查输入值为空、无草稿存储写入、空输入点击发送无请求，历史导航仅恢复真实消息。 |
| 真实输入、粘贴和恢复优先，清空后重显 | `ChatView.test.ts` 派发真实 DOM 输入、粘贴和历史快捷键事件，并由 localStorage 恢复已有草稿。 |
| 普通 Tab 采用并保留焦点和末尾光标 | `ChatComposerSuggestion.test.ts` 与 `ChatView.test.ts` 通过 textarea 的键盘事件验证焦点、光标、草稿持久化、再次编辑和单独发送。Chrome 验证采用后下一次 Tab 正常移出。 |
| 斜杠补全、合成和修饰键 | DOM 测试验证斜杠菜单 Tab 补全、合成期间 Tab 和 Enter 不触发应用操作，以及 Shift、Ctrl、Alt、Meta 组合键保留默认行为。 |
| 无提示时的焦点导航 | Chrome 原生按键验证 Tab 进入、移出输入框和 Shift+Tab 返回。 |
| 附件及历史操作门禁 | DOM 测试用文件选择事件添加附件，采用及编辑后预览保留且未上传。回退及派生在途时 Tab 不采用，发送按钮禁用，期间输入的草稿得到保留。 |
| 辅助技术区分提示与输入 | DOM 测试验证稳定的礼貌实时区域在提示到达后更新，且由输入框的 `aria-describedby` 引用。Chrome 无障碍树返回提示及 Tab 说明。 |

环境为 macOS 26.6.2、Node 25.2.1、npm 11.6.2、Vitest 4.1.10、jsdom 29.1.1 和 Chrome 156.0.8078.82。Chrome 使用本地临时组件页面及原生键盘事件。系统中文输入法与屏幕阅读器实机走查待 #1041。

- `cd frontend && npm test` 通过，82 个文件、980 项测试。
- `cd frontend && npm run build` 通过，包括 Vue 类型检查、Vite 构建和 admin 产物隔离检查。
- `git diff --check` 通过。

双轴审查发现并修复了历史操作测试的 mock 隔离问题和窄屏长提示截断问题。

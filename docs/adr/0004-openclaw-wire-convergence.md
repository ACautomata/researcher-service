# ADR 0004：收敛路径4 到单一 OpenClawWire 实现（修订 0002 的配对合并）

## 状态

已接受。修订 [0002-openclaw-anti-corruption-layer](./0002-openclaw-anti-corruption-layer.md) 的路径4 决策（配对+长连合并、`OpenClawWire` Port 形态）。0002 的四 Port ACL 架构不变；本 ADR 只改路径4 的实现收敛与配对边界。

## 背景

ADR 0002 为接触路径4（WS 协议 v4）设立 `OpenClawWire` Port，原意把"配对引导"与"配对后长连"合并为单一连接生命周期，并据此否决了"路径4 保持 `PairingHandshake` + `ChatWire` 两个 Port"的方案，给出两条理由：(a) 两 Port 复制 OpenClaw 实现结构而非 domain 结构；(b) 保留两套 `connect` 帧的认知债。

strangler 落地中途停滞：防腐层的 `OpenClawWireAdapter`（#102/#103 建成）**生产零实例化**——`chat/pool.py` 实际接线 `chat/chat_client.py` 的 `OpenClawChatClient`（活实现，承载 #152/#154/#214/#219/#220 的 dead/transmitted 硬化语义）。两套 ~700 行 WS 栈并行，镜像同一 recv-loop / dead/transmitted 判定 / 事件路由逻辑，异常族重复（adapter 靠函数内 import 引用 chat_client 的异常类型）。Port 与活实现双向漂移：Port 声明的 `pair()` 活实现根本没有；活实现的 `request_approval` / `GatewayPolicy` / 具名 session 方法 Port 没有。每次硬化都压在活实现上，停滞的 adapter 持续腐烂。路径2 (wiki) 与路径3 (health) 已完成 strangler，唯独路径4 分叉。

## 决定

1. **收敛路径4 到单一实现**：以活实现 `OpenClawChatClient` 为唯一 `OpenClawWire` 实现（承载硬化语义），迁入防腐层为 `OpenClawWireClient`；删 `OpenClawWireAdapter`（及 ~50 acceptance 测试）。`chat/chat_client.py` 保留**同对象 alias** `OpenClawChatClient = OpenClawWireClient`（strangler 零改名，273 个 chat 测试不动）。

2. **修订 0002 的配对合并**：从 `OpenClawWire` Port **移除 `pair()`**，Port 收窄为"配对后长连接"。配对仍由 `PairingHandshake` + `PairingService`（独立 seam）拥有。`OpenClawWire` 不再追求"未配对→配对中→稳态"单一生命周期。

3. **wire 知识单一来源收口**：活实现的 wire 类型定义（`GatewayPolicy` + 异常族 + `DEFAULT_*` 常量）迁入防腐层的 wire 常量模块（与既有 `ConnectFrameBuilder` / `SCOPES` / 事件族常量同处），原模块 identity-preserving re-export。

4. **Port 形态对齐活实现**：构造期持有连接身份 `(url, device_token, identity, scopes)`；`connect()` 无参（nonce 内部等 challenge 提取，藏于 seam 之后）；`close()` → `aclose()`；`send_message` 的 `on_event` keyword-only；具名 session 方法（`list_sessions`/`get_history`/`create_session`/`delete_session`）取代通用 `sessions_rpc`（`_rpc` 留私有，承载 ADR-0003 校准 wire 参数）。

5. **Port 最小契约 + 向下闭合同构**：Port 只声明 pool/consumers/views 依赖的方法；`request_approval`（仅集成测试用）/ `policy`（仅测试读）留 Impl，具体类依赖方。isomorph 守卫（inspect 签名）扩到 Port 每个方法，强制 Port/Fake/Impl **向下闭合**（Port 每个方法在三处签名同构），但允许 Impl 比 Port 富。

## 为什么

- **0002 的两个前提已不成立**：(a) "两套 connect 帧认知债"已被 `ConnectFrameBuilder`（wire 常量模块单一来源）偿清——`PairingHandshake._build_connect_frame` 与活 client 都委托它，与一 Port 还是两 Port 无关；(b) "合并"从未在存活代码里实现——活 client 早把配对（有状态：challenge→connect→approve→re-handshake→持久化 deviceToken，`PairingService` 拥）与长连（事件流，client 拥）分开，二者 shape 本质不同。合并只存在于被删的 adapter。
- **动机与 0002 一致**：可测性（Port 可注入 fake）+ 演进隔离（OpenClaw 升级改动锁防腐层内）。收敛不是推翻 ACL，而是完成停滞的路径4 strangler。
- **删 adapter 而非补齐其接线**：补齐意味着把活实现的 dead/transmitted 硬化语义反向移植到停滞 adapter，重做十轮 codex 的工作，且 adapter 的通用 `sessions_rpc` 丢弃了 views.py 实际依赖的 ADR-0003 校准 wire 参数。删 adapter 并以活实现为唯一实现，复杂度集中而非迁移——deletion test 通过。

## 考虑过但否决的方案

- **补齐 `OpenClawWireAdapter` 接线（让 pool 用 adapter）**：要把 #214/#219/#220 的硬化逻辑从活 client 反向移植到 adapter，重做多轮 codex 工作；adapter 的通用 `sessions_rpc` 丢弃 views.py 依赖的校准参数。ROI 为负。
- **保留 `pair()` 在 Port（按 0002 原意把配对并入）**：要求活 client 长出 `pair()`，违背"幸存实现承载硬化语义"；且配对的有状态多步流程（含 approve/re-handshake、Pairing 模型副作用）与长连事件流 shape 不同，强行合并退化为 god object（0002 否决单一 Facade 的同款理由）。
- **Port ≡ Fake ≡ Impl 严格相等同构（"三处同构"字面）**：会把 `request_approval`/`policy` 等非 seam 表面强塞进 Port，违背"interface 即最小 test surface"。改为向下闭合（Port ⊆ Fake/Impl），既保可替换性又保 Port 最小。
- **不迁 client，留在 chat app**：路径2/3 的 adapter 都在防腐层，路径4 留 chat 会使其成为结构异常点——正是催生本次分叉的 smell。

## 后果

- `OpenClawWire` Port 语义收窄为配对后长连接；CONTEXT.md 的 OpenClawWire 词条已据此更新。
- 跨 chat/防腐层的 import 经 strangler 迁移：先迁类型到 wire 常量模块 + identity alias（保绿），再 reshape Port，再删 adapter。三段式 PR：删重复 HealthProbe → 类型迁移 → 收敛，每段保绿。
- isomorph 守卫须**先于** Port reshape 扩到每个方法——`runtime_checkable` isinstance 只验方法存在不验签名，须 inspect 签名守卫防 Liskov 漂移（kw-only `on_event`、无参 `connect` 等）。
- 配对 handshake 作为独立 seam 保留；未来可单独立 `PairingHandshake` Port（本 ADR 范围外，deferred）。
- `OpenClawChatClient` alias 与原模块 re-export 的清理列为 deferred ticket（本 ADR 不强制）。
- 删 ~50 adapter acceptance 测试不丢覆盖：配对行为由 pairing_ws 测试覆盖，长连 wire 行为由活 client 测试（transmitted 分类的**超集**）覆盖。
- 本 ADR 与 [0002-openclaw-anti-corruption-layer](./0002-openclaw-anti-corruption-layer.md)、[0003-migrate-to-openclaw-official-browser-image](./0003-migrate-to-openclaw-official-browser-image.md) 相关：ADR-0003 校准的 wire 知识（事件族/字段路径/具名 session 方法）正是收敛后唯一实现须原样承载的，不得在迁移中丢失。

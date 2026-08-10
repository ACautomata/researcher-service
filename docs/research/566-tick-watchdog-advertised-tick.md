# #566 规格：tick 看门狗对齐网关 advertised `tickIntervalMs`（P2，连接层）

> 判定依据：`#558`（官方 `ui/src/api/gateway.ts:531-553` 用 hello `policy.tickIntervalMs` 作看门狗基准）。
> 权威语义来源：`@openclaw/gateway-client@2026.7.2-beta.6` 的 `resolveSafeTimeoutDelayMs`（官方主仓 `packages/gateway-client/src/timeouts.ts`）+ 官方 control-ui `startTickWatch` 真源码（本规格 §1 引用原文）。
> 目标：把 `gatewayChat.ts` 里**固定 60s 硬编码的沉默看门狗**改成**跟着网关 hello 承诺的 `policy.tickIntervalMs` 走**——基准随 advertised interval 变化，钳制防误杀。产出交 `#556` 收口。
> **本票是 task（定实现规格），不写代码。**

---

## 0. 最终边界（先定调，全文围绕它）

**只换「基准从哪来」，不动看门狗机制本身。**

- **变**：沉默阈值 = clamp 后的 `tickIntervalMs * 2`（跟着 hello 走），替换 `SILENCE_TIMEOUT_MS = 60_000` 硬编码。
- **不变**：
  - `#493` 后台看门狗（`document.hidden` 期间跳过判定 + `wasHidden` resume 重置基准，`gatewayChat.ts:487-499`）——**我们独有、官方没有的优势**，完整保留，与新基准正交叠加（§3）。
  - 巡检仍由 `watchdogTimer`（`setInterval`）驱动，`onActivity` 每次收帧刷新 `lastActivityAt`。
  - 超时动作仍 `closeSocket` 触发协议机重连自愈；**close code 保留 `1000`**（§4.2，语义等价、非本票范围）。
  - 隧道架构 / 配对编排 / 双预算 / give-up 计数（4402、`MAX_RECONNECT_FAILURES`、`STABLE_CONNECTION_MS`）——与看门狗基准无关，一律不碰。

**对齐官方的本质**：官方更对的只有一点——**跟着网关承诺走，不硬编码「假定 tick≤30s」**。我们把这条接上；其余官方看门狗与我们等价或我们更强（#493），不盲目照搬。

---

## 1. 官方做法（真源码，`ui/src/api/gateway.ts:531-553`）

```ts
private startTickWatch(hello: GatewayHelloOk): void {
  this.stopTickWatch();
  const advertisedTickIntervalMs = hello.policy?.tickIntervalMs;
  // 网关 policy 是远程输入；用共享 timer clamp，防超大 interval 环绕成资源耗尽热循环。
  const tickIntervalMs = resolveSafeTimeoutDelayMs(
    typeof advertisedTickIntervalMs === "number" &&
      Number.isFinite(advertisedTickIntervalMs) &&
      advertisedTickIntervalMs > 0
      ? advertisedTickIntervalMs
      : DEFAULT_GATEWAY_TICK_INTERVAL_MS,          // 缺失/无效回退 30_000
    { minMs: MIN_GATEWAY_TICK_WATCH_INTERVAL_MS }, // 地板 1_000
  );
  this.lastInboundActivityAtMs = Date.now();
  this.tickWatchTimer = setInterval(() => {
    const lastActivityAtMs = this.lastInboundActivityAtMs;
    // 真实网关心跳到达时保住长请求；只有沉默 socket 才进入共享重连生命周期。
    if (lastActivityAtMs !== null && Date.now() - lastActivityAtMs > tickIntervalMs * 2) {
      this.forceReconnect("tick timeout");
    }
  }, tickIntervalMs);
}
```

**语义要点**（官方常量：`DEFAULT_GATEWAY_TICK_INTERVAL_MS = 30_000`、`MIN_GATEWAY_TICK_WATCH_INTERVAL_MS = 1_000`，`ui/src/api/gateway.ts:210-211`）：

| 维度 | 官方 | 说明 |
|------|------|------|
| **基准来源** | hello `policy.tickIntervalMs`（可选链 `?.` + `typeof number && isFinite && >0` 守卫，缺失/无效回退 `DEFAULT=30s`） | 跟着网关承诺走 |
| **钳制** | `resolveSafeTimeoutDelayMs(value, { minMs: 1000 })` | **只钳下限**（见 §2 纠正） |
| **阈值** | `tickIntervalMs * 2` | 给一倍 tick 余量 |
| **重置信号** | `onActivity` 每次收到**任何**入站帧刷新 | 与我们一致 |
| **巡检周期** | `setInterval(…, tickIntervalMs)`（clamped 值本身） | fire 点天然 ≥ 2 周期 |
| **超时动作** | `forceReconnect("tick timeout")` = `closeSocket(4000, reason)` | 交协议机重连 |

---

## 2. `resolveSafeTimeoutDelayMs` 精确语义（SDK）——纠正 ticket 表述

```ts
// packages/gateway-client/src/timeouts.ts
export function resolveSafeTimeoutDelayMs(delayMs: number, opts?: { minMs?: number }): number {
  const rawMinMs = opts?.minMs ?? 1;
  const minMs = Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(0, Number.isFinite(rawMinMs) ? Math.floor(rawMinMs) : 1));
  const candidateMs = Number.isFinite(delayMs) ? Math.floor(delayMs) : minMs;
  return Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(minMs, candidateMs));
}
// MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647（2^31-1，Node 定时器不溢出上限）
```

**关键纠正**——ticket 待决点写「`resolveSafeTimeoutDelayMs` 钳制**上限**，替换 60s 硬编码」「恶意超大 interval 被钳制」。**这是错的**：

- 该 helper **只接受 `minMs`（地板）**，把值抬到 `max(minMs, floor(delayMs))`，再封顶 `2³¹-1`（约 24.8 天，防 Node `setTimeout` 溢出警告，**非业务上限**）。
- 官方 `startTickWatch` 传 `{ minMs: 1000 }`：**网关 advertise 一个极小/无效 tick 时，看门狗周期被抬到 ≥1s**，防止巡检热循环高频误杀；**它从不「钳制超大 interval」**——超大值只被钳到 2³¹-1，业务上等于不约束。
- 因此验收措辞应从「恶意超大 interval 被钳制」改为「**恶意超小/无效 interval 被钳到地板**（防热循环误杀）；缺失/非数回退 30s」（§5 已按此写）。

**SDK 导出确认**：`resolveSafeTimeoutDelayMs` 在 `./browser` 导出清单内（`browser.d.mts:20`，#558 维度4 A 档核实），`import { resolveSafeTimeoutDelayMs } from '@openclaw/gateway-client/browser'` 即用，**零新增依赖**（A 档）。

---

## 3. 与 #493 后台看门狗的叠加（保留不变，正交）

`#493` 是我们修过的生产 bug（Safari 后台/遮挡节流定时器并延迟 WS 帧投递，健康连接在 `document.hidden` 期间也累积 60s 沉默），**官方没有对应处理**——这是我们的优势，**不删**，只把基准换成 advertised tick。两者正交叠加，**判定顺序固定为「先 #493，后阈值」**：

```
watchdogTimer 每次 fire：
  1. [#493] if (document.hidden) { wasHidden = true; return }   // 后台期间不判沉默、不杀连接
  2. [#493] if (wasHidden) { wasHidden = false; lastActivityAt = now }  // resume 首个可见点重置基准
  3. [新基准] if (now - lastActivityAt >= tickIntervalMs * 2) closeSocket(...)  // 阈值换成动态基准
```

- **基准替换不影响跳过逻辑**：`document.hidden`/`wasHidden` 只看「页面是否后台化/刚 resume」，与阈值大小无关；阈值从 60s 固定换成 `tick*2` 动态，第 1、2 步原样保留。
- **resume 重置的基准**（第 2 步把 `lastActivityAt = now`）同样是新阈值的基准——后台陈旧 gap 不计入沉默，无论阈值是 60s 还是 `tick*2` 都成立。
- 语义变化仅一点：前台真黑洞的判死灵敏度从「固定 60s」变成「`2×` 网关承诺的 tick」。网关 tick 默认 30s 时 `2×=60s`，**与现状等价**；网关 advertise 更快 tick（如 10s）则 `2×=20s`，**判死更快、更贴合网关实际承诺**——这正是本票要的「跟着网关走」。

---

## 4. 实现规格

### 4.1 数据流 / 接线点

| 步骤 | 位置 | 改动 |
|------|------|------|
| **读 hello** | `onConnectHello(hello, context)`（`gatewayChat.ts:395`） | 新增：从 `hello.policy?.tickIntervalMs` 读 advertised tick，守卫 + clamp（§4.2），存入闭包变量 `tickIntervalMs`。**首连与每次自动重连 hello 都会触发**——每次重连都用最新承诺重算，天然覆盖「网关升级改 tick」。 |
| **clamped tick 状态** | `createGatewayChat` 闭包（`gatewayChat.ts:240` 旁，`lastActivityAt`/`watchdogTimer` 相邻处） | 新增 `let tickIntervalMs = DEFAULT_TICK_INTERVAL_MS`（默认 30s，未 hello 前的安全初值）。每次 `onConnectHello` 覆写。 |
| **巡检阈值** | `watchdogTimer` 回调（`gatewayChat.ts:501`） | `now - lastActivityAt >= tickIntervalMs * 2`（替换 `>= SILENCE_TIMEOUT_MS`）。 |
| **删硬编码** | `gatewayChat.ts:154` | 删 `SILENCE_TIMEOUT_MS`（其语义被 `tickIntervalMs*2` 取代）。`WATCHDOG_INTERVAL_MS` 处理见 §4.3。 |
| **import** | `gatewayChat.ts:8-15` | 在既有 `from '@openclaw/gateway-client/browser'` 块内**加 `resolveSafeTimeoutDelayMs`**（同 import 源，不新增依赖行）。 |

**`protocol.ts` 不需改**：它只是隧道 subprotocol 常量（`WS_CHAT_PROTOCOL`/`buildSubprotocols`），不含网关帧类型；hello/policy 类型由 SDK 的 `GatewayHelloOk`（`onConnectHello` 参数已携带）提供，复用即可，**无需补字段**。ticket 待决点「protocol.ts 是否已含该字段，缺则补」——已含于 SDK 类型，不落 `protocol.ts`。

### 4.2 钳制与回退（照官方语义）

```ts
const DEFAULT_TICK_INTERVAL_MS = 30_000      // 对齐官方 DEFAULT_GATEWAY_TICK_INTERVAL_MS
const MIN_TICK_WATCH_INTERVAL_MS = 1_000     // 对齐官方 MIN_GATEWAY_TICK_WATCH_INTERVAL_MS

// onConnectHello 内：
const advertised = hello.policy?.tickIntervalMs
tickIntervalMs = resolveSafeTimeoutDelayMs(
  typeof advertised === 'number' && Number.isFinite(advertised) && advertised > 0
    ? advertised
    : DEFAULT_TICK_INTERVAL_MS,
  { minMs: MIN_TICK_WATCH_INTERVAL_MS },
)
```

- **缺失/无效**（`undefined`/非数/非有限/`<=0`）→ 回退 30s（同官方 `DEFAULT`）。
- **过小**（如 advertise 50ms）→ 地板抬到 1000ms，防巡检热循环误杀。
- **正常**（如 15s/30s）→ 原值。
- 两常量写进 `gatewayChat.ts` 顶部常量区（对齐官方命名/数值，注释注明对齐来源）。

### 4.3 巡检周期：`WATCHDOG_INTERVAL_MS`（15s）保留 or 对齐官方

- **官方**：`setInterval(…, tickIntervalMs)`（周期=clamped tick），阈值=`tick*2`——fire 点天然 ≥2 个周期，用 `>`。
- **我们现状**：`setInterval(…, 15_000)` 固定周期，阈值 60s，用 `>=`（`gatewayChat.ts:500` 注释：fire 点 gap 恰为整 60s 也应触发，`>` 会让 60s 整被跳过）。
- **规格裁决**：**保留 15s 固定巡检周期，阈值用 `>=`**。理由：
  1. 我们的看门狗是「每连接 hello 后才 arm」的闭包 `setInterval`（`gatewayChat.ts:485`，arm 一次不随 hello 重建），改成官方「每 hello `startTickWatch` 停旧开新 + 周期=clamped tick」要动 timer 生命周期，**超出本票「只换基准」的边界**。
  2. 15s 固定周期对任意合理 tick（≥1s 地板）都够细：阈值 `tick*2 ≥ 2s`，15s 周期最坏误差 <15s，可接受；且 `#493` 的 resume 重置（`wasHidden`）已处理了「周期对齐导致边界跳过」的同类问题（`:500` 注释的 `>=` 正是为此）。
  3. 若 advertised tick 极端小（地板 1s → 阈值 2s），15s 周期仍能 2s 阈值在 15s 内命中——只是判死延迟到下一个 fire 点（≤15s），不致漏判（有 `>=`）。

  > **交 #556 的开放项**：是否对齐官方「周期=clamped tick + 每 hello 重启 timer + 用 `>`」。倾向不改（边界小、收益低、动 timer 生命周期），列此供收口复核。

### 4.4 触及文件清单

| 文件 | 改动 | 行号锚点 |
|------|------|---------|
| `frontend/src/chat/gatewayChat.ts` | import 加 `resolveSafeTimeoutDelayMs`；新增 2 常量；闭包加 `tickIntervalMs` 变量；`onConnectHello` 读 hello 字段 + clamp；`watchdogTimer` 阈值改 `>= tickIntervalMs*2`；删 `SILENCE_TIMEOUT_MS` | import `:8-15`；常量区 `:154` 旁；闭包 `:240` 旁；hello `:395`；巡检 `:501` |
| `frontend/src/chat/protocol.ts` | **不改**（hello/policy 类型复用 SDK `GatewayHelloOk`） | — |

---

## 5. 验收标准（交 #556 收口复核）

1. **基准随 advertised interval 变化**：mock `onConnectHello` 分别注入 `policy.tickIntervalMs = 10_000 / 30_000 / 60_000`，断言看门狗阈值随之 = `20_000 / 60_000 / 120_000`（替换原 60s 恒定）。
2. **恶意超小 interval 被钳到地板**：注入 `policy.tickIntervalMs = 50`（或 `1`），断言实际采用值 ≥ `1_000`（`MIN_TICK_WATCH_INTERVAL_MS`），看门狗周期/阈值不进入热循环。
3. **缺失/无效回退**：注入 `policy` 缺 `tickIntervalMs`、`tickIntervalMs = 'abc'`、`0`、`-5`、`NaN`、`Infinity`，断言一律回退 `30_000`。
4. **#493 不回归**（保留项）：
   - `document.hidden = true` 期间即使 gap 已超 `tick*2`，**不**触发 `closeSocket`；
   - resume（hidden→visible）首个可见巡检点把 `lastActivityAt` 重置为 now，不立即误杀健康连接；
   - 前台持续无帧超 `tick*2` → 触发 `closeSocket`（黑洞自愈路径不变）。
5. **重连覆盖**：第二次 `onConnectHello` 注入不同 `tickIntervalMs`，断言阈值用最新值（覆盖网关升级改 tick 场景）。
6. **typecheck/test**：`cd frontend && npm run test`（vitest 看门狗用例，含 #493 后台用例不回归）+ `npm run build`（vue-tsc）通过。

---

## 6. 明确不做（防范围蔓延）

- **不改 close code `1000`→`4000`**：官方 `forceReconnect` 用 `closeSocket(4000)`，但 `NO_RETRY_CLOSE_CODES`（`closeCodes.ts:22`）只含 4401/4403/4404，`1000` 与 `4000` 都走协议机指数退避重连，**语义等价**；改 code 属顺手改动，非本票范围，留给 `#567`（token 自愈/凭证决策）或独立评估。
- **不对齐官方巡检周期=tick / 每 hello 重启 timer**（见 §4.3 开放项）。
- **不碰** 4402 预算、give-up 计数、配对编排、隧道、渲染——与看门狗基准无关。
- **不引入** startup-unavailable 区分（4013+retryAfterMs，#558 D 档，helper 不在 beta.6）。

---

## 附：关键证据索引

**官方（openclaw/openclaw `main`）**
- `ui/src/api/gateway.ts:531-553`（`startTickWatch` 真源码，§1 引用）、`:210-211`（`DEFAULT_GATEWAY_TICK_INTERVAL_MS=30_000` / `MIN_GATEWAY_TICK_WATCH_INTERVAL_MS=1_000`）、`:541-542`（clamp 调用）
- `packages/gateway-client/src/timeouts.ts`（`resolveSafeTimeoutDelayMs` 定义，§2 引用；`MAX_SAFE_TIMEOUT_DELAY_MS=2_147_483_647`）

**我们（`frontend/`）**
- `frontend/src/chat/gatewayChat.ts:154-155`（`SILENCE_TIMEOUT_MS=60_000` / `WATCHDOG_INTERVAL_MS=15_000` 硬编码）、`:240-244`（`lastActivityAt`/`watchdogTimer`/`wasHidden` 闭包）、`:383-385`（`onActivity` 刷新）、`:395`（`onConnectHello` hello 捕获点）、`:487-499`（#493 后台跳过+resume 重置）、`:500-505`（阈值判定 + `>=` 注释 + `closeSocket(1000)`）
- `frontend/src/chat/closeCodes.ts:22-27`（`NO_RETRY_CLOSE_CODES`，close code 语义等价依据）
- `frontend/src/chat/protocol.ts`（仅隧道 subprotocol 常量，不含帧类型——佐证 §4.1「protocol.ts 不改」）

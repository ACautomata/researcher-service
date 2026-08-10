# token 自愈/凭证决策复用 SDK helper 实现规格（#567 / 子 ticket of #551）

> **任务**：把 `gatewayChat.ts` 手写的 token 自愈/凭证决策收敛为复用 SDK 已导出 helper（`shouldRetryGatewayWithDeviceToken` / `selectGatewayConnectAuth`），与官方一致。定**实现规格**（决策类，不写实现代码）。
>
> **结论速览**：
> - ✅ **对齐 `AUTH_TOKEN_MISMATCH` 官方机制**——新增 `shouldRetryGatewayWithDeviceToken` 接入 + `onConnectFailure` 接线（我们此前对非 `_DEVICE_` 的 `AUTH_TOKEN_MISMATCH` 处理是**错的**，官方有一套「重发旧 token 单次重试」机制我们没有）。
> - ⚠️ **`AUTH_DEVICE_TOKEN_MISMATCH` 不能换用 `shouldRetry`**——SDK 对该码**恒 false**（只豁免 `AUTH_TOKEN_MISMATCH`）。我们生产实锤的 bug 正是 `_DEVICE_` 变体，直接换 = 把已修 bug 改回去。保留现有 `recoverTokenMismatch`，仅按官方语义**收窄到仅 `_DEVICE_`**。
> - ✅ **凭证选择维持「打平不动」**（ticket 预判成立）——`selectGatewayConnectAuth` 已在官方 lifecycle `buildPlan` 内部被调，我们经 lifecycle 间接受益；`resolveGatewayConnectScopes` 的过滤子集（`storedDeviceTokenScopesAllowRead`）是 **D 档**（不在 beta.6），面板无 scope 升级需求，不引入。

---

## 一、SDK 事实（`@openclaw/gateway-client@2026.7.2-beta.6` 源码实测）

### 1.1 `shouldRetryGatewayWithDeviceToken`（`connect-auth`）

签名（`session-subscriptions-*.d.mts:56-64`）：

```ts
shouldRetryGatewayWithDeviceToken({
  retryBudgetUsed: boolean;
  currentDeviceToken?: string;
  explicitToken?: string;
  storedToken?: string;
  trustedEndpoint: boolean;
  canRetryWithDeviceTokenHint?: boolean;
  errorDetails?: unknown;
}): boolean
```

实现（`session-subscriptions-BV7MxYiL.mjs:97-101`）：

```js
function shouldRetryGatewayWithDeviceToken(params) {
  if (params.retryBudgetUsed || params.currentDeviceToken || !params.explicitToken || !params.storedToken || !params.trustedEndpoint) return false;
  const advice = readConnectErrorRecoveryAdvice(params.errorDetails);
  return params.canRetryWithDeviceTokenHint === true
      || advice.canRetryWithDeviceToken === true
      || advice.recommendedNextStep === "retry_with_device_token"
      || readConnectErrorDetailCode(params.errorDetails) === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
}
```

**关键语义**：
- **硬门**（任一不满足即 false）：`retryBudgetUsed`（预算已用）/ `currentDeviceToken`（本次已在用 deviceToken 重试）/ 无 `explicitToken`（无显式 bootstrap token）/ 无 `storedToken`（本地无持久化 deviceToken）/ 非 `trustedEndpoint`。
- **触发码**：网关 advice `canRetryWithDeviceToken`/`recommendedNextStep==="retry_with_device_token"`，或错误码 `=== AUTH_TOKEN_MISMATCH`。
- **`AUTH_DEVICE_TOKEN_MISMATCH` 不在触发集**——对 `_DEVICE_` 变体**恒 false**。这是本 ticket 最关键的事实约束。

### 1.2 `shouldPauseGatewayReconnect`（我们已用）

`NON_RECOVERABLE_AUTH_ERRORS` 集合（`:868-879`）含 `AUTH_DEVICE_TOKEN_MISMATCH`、**不含** `AUTH_TOKEN_MISMATCH`。`AUTH_TOKEN_MISMATCH` 单列（`:885`）：`return tokenMismatchIsTerminal === true && !deviceTokenRetryPending`——即官方允许通过把 `deviceTokenRetryPending` 置 true 让 `AUTH_TOKEN_MISMATCH` **可重试**。这正是 `shouldRetry` 的配套闸门。

### 1.3 `selectGatewayConnectAuth`（凭证选择）

实现（`:50-82`）含一条**「重发旧 token」通道**：`useRetryToken = pendingDeviceTokenRetry === true && !explicitDeviceToken && Boolean(authToken && storedToken && trustedDeviceTokenRetry)`，命中时输出 `authDeviceToken: storedToken`（把持久化的旧 deviceToken 作为 `auth.deviceToken` 字段重发，走网关「旧 token 换新 token」的 device-token-retry 通道）。`buildGatewayConnectAuth`（`:83-93`）把 selection 拍成 `ConnectParams["auth"]`。

### 1.4 官方 lifecycle `buildPlan` 内部（`:109-131`）

已自行调用 `selectGatewayConnectAuth`（喂入 `storedToken`/`storedScopes`/`pendingDeviceTokenRetry`/`trustedDeviceTokenRetry`）+ `resolveGatewayConnectScopes`。**我们经 lifecycle 间接受益，无需在 `gatewayChat` 直接 import `selectGatewayConnectAuth`/`buildGatewayConnectAuth`**——除非要把 `pendingDeviceTokenRetry` 传进 buildPlan（见 §三接入点 B）。

---

## 二、官方 `gateway.ts` 对照（决定语义来源）

官方 `ui/src/api/gateway.ts`（`openclaw/openclaw@main`）的完整 device-token 恢复编排：

| 步骤 | 回调 | 行为（证据） |
|------|------|------------|
| ① `handleConnectFailure`（= 我们的 `onConnectFailure`） | 连不上时 | **(a)** `shouldRetryGatewayWithDeviceToken({retryBudgetUsed: deviceTokenRetryBudgetUsed, currentDeviceToken: plan.selectedAuth.authDeviceToken, explicitToken: plan.explicitGatewayToken, storedToken: plan.selectedAuth.storedToken, trustedEndpoint: Boolean(plan.deviceIdentity) && isTrustedRetryEndpoint(url), errorDetails: err.details})` → true 则 `pendingDeviceTokenRetry = true; deviceTokenRetryBudgetUsed = true`。<br>**(b)** **独立分支**：`if (usedStoredDeviceToken && plan.deviceIdentity && code === AUTH_DEVICE_TOKEN_MISMATCH) → clearDeviceAuthToken(...)`（清持久化旧 token，**无预算、无重发**）。 |
| ② `buildConnectPlan` | 重建 plan | 若 `pendingDeviceTokenRetry` 且选出了 `authDeviceToken` → 清 `pendingDeviceTokenRetry`（一次性）。`selectConnectAuth` 传 `pendingDeviceTokenRetry`/`trustedDeviceTokenRetry: isTrustedRetryEndpoint(url)` → 触发 §1.3 重发通道。 |
| ③ `resolveClose` | 关连接决策 | `retry = code === AUTH_TOKEN_MISMATCH ? this.pendingDeviceTokenRetry : !isNonRecoverableConnectError(...)`。**`AUTH_TOKEN_MISMATCH` 的 retry 完全由 `pendingDeviceTokenRetry` 驱动**（即 ①(a) 的 `shouldRetry` 结果）。 |
| ④ `handleConnectHello` | 连上 | `pendingDeviceTokenRetry = false; deviceTokenRetryBudgetUsed = false`（**成功即清零，预算生命周期 = 每次成功连接重置**）。 |

**`isTrustedRetryEndpoint(url)`**（官方直连语境）：loopback / `::1` / `127.x` / 与页面同 host → true。**面板经隧道**，无直连 URL，语义映射为「面板连的是自己的容器网关」= **恒 true**（见 §三接入点 A 裁决）。

---

## 三、实现规格

### 范围裁决（对照 ticket 待决项）

| ticket 待决 | 裁决 | 理由 |
|------------|------|------|
| `shouldRetry` 接入点 | **新增 `onConnectFailure` 接线**（协议机 options，`gatewayChat.ts` 目前未接） | 官方语义要求 `shouldRetry` 在 connect 失败时（拿到 `plan`）判定并设 `pendingDeviceTokenRetry`，`resolveClose` 读它决策。我们 `resolveClose`/`onClose` 拿得到 `connectFailure.error` 但**拿不到 `plan`**，无法填 `shouldRetry` 的 `currentDeviceToken`/`storedToken` 入参 → 必须经 `onConnectFailure`（其 context 带 `plan`）。 |
| `retryBudgetUsed`/`pendingDeviceTokenRetry` 预算映射 | **新增独立单次预算 `deviceTokenRetryBudgetUsed`/`pendingDeviceTokenRetry`**（hello 成功清零），**不复用 `pairingAttempts`** | 二者是**不同机制**：`pairingAttempts` 防「approve 反复无效」死循环（多步、跨 PAIRING_REQUIRED/MISMATCH 编排）；`deviceTokenRetryBudgetUsed` 是官方「重发旧 token」单次闸。混用会语义错位。 |
| `selectGatewayConnectAuth`/`resolveGatewayConnectScopes` 是否一并收敛 | **不直接收敛**（ticket「默认仅 token 自愈」成立）。仅在为触发重发通道时，把 `pendingDeviceTokenRetry` 传给 `lifecycle.buildPlan` | 凭证选择已由 lifecycle 内部 `selectGatewayConnectAuth` 覆盖；`storedDeviceTokenScopesAllowRead` 过滤子集 D 档不可得且面板无 scope 升级需求。 |
| **保留不变** | 带外 approve 编排（`runAutoPairing`/控制面 `openclaw devices approve`，ADR 0006）、双预算（`consecutiveFailures`/`gatewayUnavailableCount`）、#493 后台看门狗、配对预算 `pairingAttempts` 语义、`recoverTokenMismatch` 的重配对闭环 | 面板隧道架构真实需求，官方没有也不需要。 |

### 触及文件
- `frontend/src/chat/gatewayChat.ts`（唯一）。**新增** `onConnectFailure` 接线 + 两个闭包标志；**改造** `resolveClose`/`onClose`/`buildConnectPlan` 三处；`recoverTokenMismatch` **收窄**。

### 接入点 A：`onConnectFailure`（新增）

协议机 options 增加（对齐官方 `handleConnectFailure`）：

```
onConnectFailure: (error, context) => {
  // 仅 GatewayProtocolRequestError 且有 plan 才判（与官方一致，0 信任）
  const plan = context.plan            // ConnectPlan = GatewayBrowserDeviceAuthPlan & {caps}
  // (a) AUTH_TOKEN_MISMATCH 单次重试判定（新增，官方机制）
  if (shouldRetryGatewayWithDeviceToken({
    retryBudgetUsed: deviceTokenRetryBudgetUsed,
    currentDeviceToken: plan.selectedAuth?.authDeviceToken,
    explicitToken: <本会话 bootstrap token>,        // 见「裁决：explicitToken 来源」
    storedToken: plan.selectedAuth?.storedToken,
    trustedEndpoint: true,                          // 面板走隧道连自己容器，恒 trusted（见下）
    errorDetails: error?.details,
  })) {
    pendingDeviceTokenRetry = true
    deviceTokenRetryBudgetUsed = true
  }
  // (b) 返回默认 connect 失败决策，让 resolveClose/onClose 走既有流程
  return { closeCode: <保留现状>, closeReason: <保留现状> }
}
```

**裁决：`explicitToken` 来源**——官方用 `plan.explicitGatewayToken`（其 ConnectPlan 自定义字段）。我们的 `ConnectPlan` 无此字段，但**语义 = 本会话 bootstrap token**：凭证选择处（现 `:265-272`）当 `stored === false` 时传了 `token: bootstrapToken`。故接入点 A 需让 `buildConnectPlan` 把「本次是否注入 bootstrap token」记上 plan（给 `ConnectPlan` 增一个内部字段，如 `explicitBootstrapToken?: string`），供 `onConnectFailure` 读。**不可直接读闭包 `bootstrapToken`**——它恒有值，会让 `shouldRetry` 的 `!explicitToken` 硬门失效（官方语义是「本次 connect 是否带了显式 token」）。

**裁决：`trustedEndpoint` 恒 true**——官方 `isTrustedRetryEndpoint` 判「直连 URL 是否 loopback/同 host」防「把持久化 token 发给不可信远端」。面板浏览器**不直连网关**，经控制面隧道（JWT 握手 + 归属门 + 原始帧透传，ADR 0006）连**自己的容器网关**，威胁模型等价官方 loopback。恒 true 不引入新风险（重发的 `auth.deviceToken` 仍只流向本容器网关）。

### 接入点 B：`buildConnectPlan`（微改）

现状 `:265-274` 凭证选择后：
- 若 `pendingDeviceTokenRetry === true`：把它传给 `lifecycle.buildPlan({..., pendingDeviceTokenRetry: true, trustedDeviceTokenRetry: true, ...})`，触发 §1.3 的 `authDeviceToken` 重发通道；随后 `pendingDeviceTokenRetry = false`（一次性，对齐官方 `buildConnectPlan` 末尾）。
- 记录 `explicitBootstrapToken` 到 plan（供接入点 A）。

> **注意**：`lifecycle.buildPlan` 的 `.d.mts` 签名已含 `pendingDeviceTokenRetry`/`trustedDeviceTokenRetry` 入参（`session-subscriptions-*.d.mts:121-122`），beta.6 直接可传，无需改 SDK。

### 接入点 C：`resolveClose` + `onClose`（改造）

**(i) `resolveClose`**（现 `:294-335`）`shouldPauseGatewayReconnect` 调用：
```
// 现状：deviceTokenRetryPending: false, tokenMismatchIsTerminal: true
// 改为：deviceTokenRetryPending: pendingDeviceTokenRetry, tokenMismatchIsTerminal: true
```
使 `AUTH_TOKEN_MISMATCH` 在 `pendingDeviceTokenRetry === true` 时 `shouldPause` 返 false → `retry: true`（协议机自动重连，重连时接入点 B 重发旧 token）。`AUTH_DEVICE_TOKEN_MISMATCH` 不受影响（在 NON_RECOVERABLE 集合，仍 `retry: false` → 落 onClose 自愈）。

**(ii) `onClose`**（现 `:336-379`）MISMATCH 分支**收窄**：
```
// 现状：detailCode === 'AUTH_DEVICE_TOKEN_MISMATCH' || detailCode === 'AUTH_TOKEN_MISMATCH' → recoverTokenMismatch
// 改为：仅 detailCode === 'AUTH_DEVICE_TOKEN_MISMATCH' → recoverTokenMismatch（重配对闭环，不变）
```
`AUTH_TOKEN_MISMATCH` 由此分支**移出**（已由 `resolveClose` 的重试通道 + `onConnectFailure` 处理）。**保留 `AUTH_TOKEN_MISMATCH` 的兜底**：当 `pendingDeviceTokenRetry === false`（无 storedToken / 预算已用 / 非首连）时，`shouldPause` 仍判它终端 → `retry:false` → onClose。此时需决定：**对 `AUTH_TOKEN_MISMATCH` 且 `pendingDeviceTokenRetry === false` 是否也走 `recoverTokenMismatch`？**——裁决见 §四风险 R2。

**(iii) `recoverTokenMismatch`**（现 `:462-472`）**逻辑不变**，仅触发条件收窄为仅 `_DEVICE_`。

### 新增闭包状态（`gatewayChat.ts`）

```ts
let pendingDeviceTokenRetry = false     // 官方 AUTH_TOKEN_MISMATCH 单次重发闸
let deviceTokenRetryBudgetUsed = false  // 单次预算（hello 成功清零）
```

**重置点**（对齐官方 `handleConnectHello`/`stop`）：
- `onConnectHello`（hello 成功）→ 两者清零。现状 `onConnectHello` 仅在「有 token + identity」时 acceptHello，**预算清零须无条件**（对齐官方，成功连接即重置，与 pairingAttempts 的 acceptHello-gated 清零**不同**——见 §四 R3）。
- `stop()` / `start()` → 清零（切容器/手动重连重置）。

---

## 四、风险与裁决

**R1（时序）**：`onConnectFailure` 在「connect request 发出后、网关 reject」时同步触发，早于 socket close → 早于 `resolveClose`/`onClose`。`pendingDeviceTokenRetry` 在 `resolveClose` 读之前已就绪，**无竞态**。`startGatewayConnectTimeout`（connect timeout）仅兜底「发出后无响应」，正常 MISMATCH reject 远早于此。**低风险**。

**R2（`AUTH_TOKEN_MISMATCH` 且 `pendingDeviceTokenRetry === false` 的兜底）**：场景=有 storedToken 但预算已用（重发过一次仍 MISMATCH），或无 storedToken。官方此时 `shouldPause` 判终端 → `retry:false` → 官方 UI 报「认证失败需手动」。**裁决：面板对 `AUTH_TOKEN_MISMATCH` 预算用尽后，落 `recoverTokenMismatch`（清 token → bootstrap → 重配对）而非官方「手动」**——理由：面板控制面可带外 approve，重配对是自动的，UX 优于官方手动；且与我们 `_DEVICE_` 路径收敛同一条自愈闭环。→ **故 onClose 的 MISMATCH 分支不能简单删掉 `AUTH_TOKEN_MISMATCH`，而是改为「`AUTH_TOKEN_MISMATCH` 且 `!pendingDeviceTokenRetry`（重试通道不可用/用尽）才落 `recoverTokenMismatch`」**。这是与 ticket「行为等价」预设的**第二处偏差**，须明示。

**R3（预算清零语义分歧）**：`pairingAttempts` 由 `onConnectHello` 在 `acceptHello` 成功（有 token + identity）后清零（防无限 approve，刻意 gated）；`deviceTokenRetryBudgetUsed` 官方在 hello 成功**无条件清零**。两者清零时机不同是**有意为之**（防的风险不同），实现时**不可合并**为同一处清零。

**R4（行为等价核查）**：现有测试（`gatewayChat.test.ts:903`）断言「`AUTH_TOKEN_MISMATCH` → `clearStoredToken` + `start()` 重连」。改造后该路径变为「`onConnectFailure` 设 `pendingDeviceTokenRetry` → `resolveClose` retry → 协议机自动重连（重发旧 token）」，**不再经 `clearStoredToken`/`recoverTokenMismatch`**（除非预算用尽走 R2 兜底）。→ **该测试用例需重写**（见 §五验收）。这是行为**变化点**，非纯等价重构，须在交接规格中标红。

---

## 五、验收标准

| # | 场景 | 期望 | 验证 |
|---|------|------|------|
| V1 | `AUTH_TOKEN_MISMATCH`，有 storedToken + bootstrap（首连后 token 失同步），预算未用 | `onConnectFailure` 置 `pendingDeviceTokenRetry`；`resolveClose` retry:true；重连 `buildConnectPlan` 传 `pendingDeviceTokenRetry` 给 lifecycle（重发旧 token），不再走 `recoverTokenMismatch`/`clearStoredToken` | 单测：mock 协议机触发 connectFailure(AUTH_TOKEN_MISMATCH)，断言 `shouldRetry` 生效、lifecycle.buildPlan 收到 `pendingDeviceTokenRetry:true`、**不**调 `clearStoredToken` |
| V2 | `AUTH_TOKEN_MISMATCH`，重发一次后仍 MISMATCH（预算用尽） | 第二次：`shouldRetry` 因 `retryBudgetUsed` 返 false → `shouldPause` 判终端 → onClose 落 `recoverTokenMismatch` 重配对（R2 兜底） | 单测：连发两次 AUTH_TOKEN_MISMATCH，第二次断言走 `clearStoredToken`+`start()` |
| V3 | `AUTH_DEVICE_TOKEN_MISMATCH`（生产 bug 回归） | 走 `recoverTokenMismatch`（清 token → bootstrap → PAIRING_REQUIRED → approve 闭环），**不经** `shouldRetry`；配对预算防死循环不回归 | 现有 `gatewayChat.test.ts:894-935` 用例**保持绿**（仅触发码收窄，`_DEVICE_` 用例不动） |
| V4 | hello 成功 | `pendingDeviceTokenRetry`/`deviceTokenRetryBudgetUsed` 清零；`pairingAttempts` 仍按 acceptHello-gated 清零（不合并） | 单测断言两处清零独立 |
| V5 | `AUTH_TOKEN_MISMATCH` 无 storedToken（从未配对，token 选 bootstrap 仍 MISMATCH） | `shouldRetry` 因 `!storedToken` 返 false → R2 兜底落 `recoverTokenMismatch` | 单测 |
| V6 | 凭证选择回归 | 首连传 `token`、重连 deviceToken（`hasStoredDeviceTokenFor` 判断）行为不变 | 现有 `gatewayChat.test.ts:178` 凭证选择用例保持绿 |

**防死循环不回归（ticket 硬要求）**：`AUTH_DEVICE_TOKEN_MISMATCH` 与 `AUTH_TOKEN_MISMATCH` 预算用尽后均收敛到 `recoverTokenMismatch`/`runAutoPairing`，二者共用 `pairingAttempts` 预算（MAX 3）→ 无限循环仍被 `pairingAttempts` 截断。`deviceTokenRetryBudgetUsed` 单次闸独立于配对预算，不削弱防死循环。

---

## 六、证据索引

**SDK（`frontend/node_modules/@openclaw/gateway-client@2026.7.2-beta.6`）**
- `dist/session-subscriptions-DrhzqL6v.d.mts:56-64`（`shouldRetry` 签名）、`:36-49`（`selectGatewayConnectAuth`/`buildGatewayConnectAuth`）、`:50-55`（`resolveGatewayConnectScopes`）、`:96-128`（`GatewayBrowserDeviceAuthPlan`/`lifecycle.buildPlan` 入参含 `pendingDeviceTokenRetry`）
- `dist/session-subscriptions-BV7MxYiL.mjs:97-101`（`shouldRetry` 实现，`_DEVICE_` 恒 false）、`:868-887`（`NON_RECOVERABLE_AUTH_ERRORS` + `shouldPause`）、`:50-93`（`selectGatewayConnectAuth` 重发通道）、`:109-131`（lifecycle buildPlan 内部）
- `dist/protocol-client-BfBHwA5H.d.mts:22-26`（`GatewayProtocolConnectContext` 带 `plan`）、`:39-45`（`GatewayProtocolConnectDecision`）、`:85`（`onConnectFailure` 回调）

**官方（`openclaw/openclaw@main` `ui/src/api/gateway.ts`）**
- `handleConnectFailure`（`shouldRetry` + `_DEVICE_` 独立 clear 分支）、`buildConnectPlan`（pendingDeviceTokenRetry 一次性 + selectConnectAuth 传参）、`resolveClose`（`AUTH_TOKEN_MISMATCH ? pendingDeviceTokenRetry : !isNonRecoverable`）、`handleConnectHello`（预算清零）、`isTrustedRetryEndpoint`、`stop()`（预算重置）

**我们（`frontend/src/chat/gatewayChat.ts`）**
- `:294-335`（`resolveClose` + `shouldPause` 调用）、`:336-379`（`onClose` 配对/MISMATCH 编排）、`:462-472`（`recoverTokenMismatch`）、`:265-274`（凭证选择 + buildConnectPlan）、`:230-232`（`pairingAttempts` 预算）、`:395-413`（`onConnectHello`）
- `gatewayChat.test.ts:879-963`（MISMATCH 自愈现有用例）、`:178`（凭证选择）

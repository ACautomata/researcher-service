# R40 — OpenClaw 设备配对协议（字节级，上游源码已证）

> 对应 issue **#40**（T04 设备配对服务）。spec §8.1 标注「待实测 device_id/签名串规范」，
> 本文件按上游 `openclaw/openclaw`（main）源码逐字节敲定，供 Django 端 `chat` 配对实现对齐。
>
> 事实来源（全部 **[上游源码]**，非二手）：
> - `packages/gateway-client/src/device-auth.ts` — `buildDeviceAuthPayloadV3`
> - `src/infra/device-identity.ts` — `deriveDeviceIdFromPublicKey` / `signDevicePayload` / `publicKeyRawBase64UrlFromPem`
> - `src/infra/ed25519-signature.ts` — 密钥 DER/PEM、base64url 编码、签名
> - `packages/gateway-client/src/client.ts` — connect 帧 `device` 字段装配、`hello-ok.auth` 处理

---

## 1. 设备身份（Ed25519）

- **密钥对**：Ed25519。公钥 SPKI DER、私钥 PKCS8 DER，PEM 编码存储。
- **原始公钥** = SPKI DER 剥掉 12 字节前缀后的 **32 字节** raw key。
- **`deviceId`** = `sha256(raw_public_key_32B).hexdigest()`（64 字符小写 hex）。
  （`deriveDeviceIdFromPublicKey`：`createHash("sha256").update(raw).digest("hex")`）
- **公钥线上格式** = raw 32 字节的 **base64url**（无 padding 风格，`publicKeyRawBase64UrlFromEd25519Pem`）。

## 2. 签名串 `buildDeviceAuthPayloadV3`

字段以 **`|`** 连接，顺序固定（11 段）：

```
v3 | deviceId | clientId | clientMode | role | scopes(逗号join) | signedAtMs | token | nonce | platform | deviceFamily
```

- `scopes` 多值用 **英文逗号** join（无空格）。
- `signedAtMs` = 毫秒时间戳的十进制字符串。
- `token` = bootstrap 用的 `GATEWAY_TOKEN`（连接级 `auth.token`）；无则空串。
- `platform` / `deviceFamily` 经 `normalizeDeviceMetadataForAuth`：trim 后大写转小写，空/非串 → `""`。
- 网关**逐字节比对**签名串——归一化必须客户端侧先做，否则验签失败。
- 旧版 `v2` 仅 9 段（无 platform/deviceFamily），网关仍接受；本实现用 v3。

## 3. connect 帧 `device` 字段（client.ts 装配）

```jsonc
"device": {
  "id": deviceId,                                  // = sha256 hex
  "publicKey": publicKeyRawBase64Url,              // 32B raw → base64url
  "signature": signEd25519Payload(privPem, v3payload),  // base64url
  "signedAt": signedAtMs,                          // 毫秒 int
  "nonce": nonce                                   // 来自 connect.challenge
}
```

签名 = 对 v3 payload 的 UTF-8 字节做 Ed25519（`crypto.sign(null, ...)`），输出 base64url。

## 4. 配对流程（spec §8.1 + 文档已证）

1. 连 `ws://127.0.0.1:<port>/`（根路径），等 `connect.challenge`（`payload.nonce` + `ts`）。
2. `connect.params` 带 `device`（上）+ `auth.token=<GATEWAY_TOKEN>`（bootstrap）+
   `role:"operator"` + `scopes:[operator.read,operator.write,operator.admin,operator.approvals]` +
   `caps:["tool-events"]`。
3. **未配对** → `PAIRING_REQUIRED`：`details.requestId`、`recommendedNextStep:"wait_then_retry"`、
   `retryable:true`、`pauseReconnect:false`。
4. 宿主运维 `openclaw devices approve <requestId>`（一次性）。**面板无 operator.admin，
   不能经网关代 approve——必须宿主 CLI。**
5. 重连 → `hello-ok.auth.deviceToken`（+ `auth.role` / `auth.scopes` 协商结果）。
   **持久化 deviceToken**，后续连接用 `auth.deviceToken`（替代 bootstrap token），
   网关复用该 token 已批准的 scope 集。

## 5. 对面板实现的约束

- 设备身份（私钥）**按容器持久化**在 Django DB（`chat.Pairing.private_key_pem`），deviceId 稳定。
- pairing 批准状态存于**容器自己的 home 卷**（`~/.openclaw/state`），删容器即重置（spec §5.4 连数据删）。
- 已 `paired` 且 `device_token` 非空 → 后续连接直接用 deviceToken，无需重复 challenge 配对签名。
- scopes 协商结果以 `hello-ok.auth.scopes` 为准持久化（验收：非空，含 operator.read/write/approvals）。

# 超星学生授权、刷新与用户隔离验收记录（#1008）

## 当前状态

2026-10-23：用户本人已在超星页面用学生账号完成登录与授权，平台设置页显示“已绑定”；生产状态接口返回 `configured=true`、`connected=true`、`expiresAt=2026-10-23T07:29:40.553Z`。平台侧授权事务、回调防护、刷新协调、绑定隔离与解绑行为已通过 API + 真实临时 SQLite 回归。平台无法从令牌解析账号角色，学生身份以用户本人确认为准，未记录账号标识。真实课程数据与 MCP 能力仍受 [#1009](chaoxing-mcp-verification.md) 上游初始化 403 阻塞。

本记录不含客户端密钥、授权码、access/refresh token、密码、账号标识或上游响应正文。

## 验收映射

| #1008 验收项 | 证据 | 结果 |
|---|---|---|
| 学生本人完成登录授权，返回平台显示已绑定 | 2026-10-23 用户本人学生账号授权；生产状态接口 `connected=true`；设置页显示“已绑定”；`test/chaoxing.test.ts` 回调闭环 | 通过（学生身份由用户本人确认） |
| 记录授权参数要求与 scope | `授权参数、拒绝与异常 state（#1008）` 首项断言授权 URL 与 state cookie；生产重新授权成功 | 通过（请求侧与生产回调） |
| 明确授权主体与教师/学生角色 | 用户本人确认绑定的是其学生账号；平台不解析角色、不记录 UID | 用户确认；平台无法独立证明角色 |
| 取消/拒绝授权 | 回调携带 `error=access_denied`：303 到失败页，不交换令牌，不建立绑定，state 消耗 | 通过 |
| 错误 state | 伪造 state 即使 cookie 匹配也失败，不建立绑定 | 通过 |
| 过期 state | 将授权事务置为过期后回调失败，事务删除，不建立绑定 | 通过 |
| 重放 state | 首次回调后再次使用同一 state 失败，令牌交换仅发生一次 | 通过 |
| 缺少同浏览器 cookie | 无 cookie 回调失败；其他平台用户的 cookie 不能完成发起者的 state | 通过 |
| 不绑定到其他平台用户 | 其他用户携带自己的 cookie 触发发起者 state 时失败，发起者随后仍可正常完成；双方状态互不串写 | 通过 |
| 两名平台用户绑定状态、凭证与访问隔离 | 双用户分别绑定后各用自己的 access token 查询；一方解绑/禁用不影响另一方 | 平台实现通过；第二名真实学生生产复验待补 |
| 禁用后停止数据访问 | 绑定后禁用用户，状态与学习接口均返回 10001；授权进行中禁用则回调失败 | 通过 |
| 解绑后停止数据访问 | 解绑后学习接口返回 90003；解绑同时清空会话课程范围 | 通过 |
| 旧在飞授权不能恢复绑定 | 解绑后晚到的回调失败，绑定保持断开 | 通过 |
| 旧在飞刷新不能恢复绑定 | 重新授权完成后，旧 generation 的刷新结果不覆盖新绑定 | 通过 |
| refresh/expiry 实际支持 | 过期前自动刷新；并发请求共用一次刷新；刷新成功后使用新令牌；生产 `expiresAt` 已记录 | 本地通过；真实续期观测见下节 |
| 刷新失败/失效引导 | 刷新抛错或远端 401 时清除本地绑定、返回重新绑定提示；重新授权后恢复访问 | 通过 |
| 远端 revoke 支持情况 | 平台未实现也未验证远端撤销协议；解绑只清除本地授权，设置页已明确提示 | 明确为本地解绑 |
| 脱敏验收记录 | 本文件 | 已形成 |
| API + 临时数据库回归与类型检查 | 专项 14 项、后端类型检查与全量测试见下节 | 通过 |

## 已验证的授权请求契约

来自 `server/src/chaoxing/service.ts` 与上述回归断言，均为**请求侧**事实，不等于超星已接受：

- 授权端点：`https://api.chaoxing.com/auth/oauth2/authorize`。
- 参数：`response_type=code`、配置的 `client_id`、登记的回调 `redirect_uri`、`scope=mooc:resource mooc:qbank`、一次性 `state`。
- `state`：32 字节随机值（base64url，43 字符），数据库只存 SHA-256；有效期 10 分钟；回调成功或失败尝试后即删除。
- 同浏览器校验：HttpOnly、SameSite=Lax、Secure（HTTPS 回调）、Path 限定在超星集成路由、Max-Age 600 秒的 `chaoxing_oauth` cookie 必须与回调 `state` 相等。
- PKCE：默认启用 S256，`code_challenge` 为 verifier 的 SHA-256；仅当部署明确配置 `CHAOXING_PKCE=false` 时关闭。
- 客户端认证：token 端点默认表单提交 `client_secret`，可配置为 HTTP Basic；浏览器 URL 不携带密钥。
- 回调不接收平台 JWT，也不信任回调中的用户 ID；绑定 owner 只取自服务端保存的授权事务。

## 刷新、过期与撤销的实际行为

- access token 距过期不足 30 秒且有 refresh token 时自动刷新；并发请求按 `ownerId + generation` 合并为一次刷新。
- 刷新响应未返回新 refresh token 时沿用旧值；刷新失败、响应不合法或调用返回 401 时清除本地令牌并要求重新绑定。
- 重新授权期间保留旧绑定，但通过 generation 隔离旧刷新/旧回调；成功后原子替换令牌。
- 平台没有远端 revoke 调用，也没有已验证的超星撤销协议。解绑只清本地绑定、待处理授权和会话课程范围；如需在超星侧撤销应用授权，用户须前往超星账号设置操作。

## 生产复验（2026-10-23）

- 先在已登录的生产账号设置页点击“重新授权”，真实超星会话直接完成授权并返回 `/settings?chaoxing=connected`，页面显示“超星授权成功”“已绑定”；证明生产环境的授权跳转、同浏览器 state cookie、回调交换与绑定持久化链路可工作。
- 随后用户本人在浏览器中退出教师会话、登录其学生账号并同意授权。学生授权后设置页仍显示“已绑定”，且已发布的新说明可见。
- 学生授权后 `GET /api/v1/integrations/chaoxing` 返回：`{ "configured": true, "connected": true, "expiresAt": "2026-10-23T07:29:40.553Z" }`（不含令牌）。`expiresAt` 与本次学生授权时间一致，早于此前教师重新授权的理论到期时间，支持绑定已被学生授权替换；账号身份最终以用户本人确认为准。
- 未读取或记录密码、授权码、access/refresh token、账号名、UID 或上游响应正文。平台不解析学生/教师角色，不能独立证明角色。
- 生产浏览器会话自动同意授权，未能在生产复验“取消/拒绝”分支；该分支由 API + 临时 SQLite 回归覆盖。真实 MCP 能力仍受 #1009 上游 403 阻塞，本票不以 MCP 数据为验收条件。

## CI/CD 与发布验证

- PR [#1017](https://github.com/ACautomata/researcher-service/pull/1017) 已合并，merge commit `ad499ed`。
- master CI [39911543412](https://github.com/ACautomata/researcher-service/actions/runs/39911543412) 成功；CD [39911925449](https://github.com/ACautomata/researcher-service/actions/runs/39911925449) 成功，四镜像构建、远端部署与健康门通过。
- 线上 `GET /api/health` 返回 `code=0`；生产 `SettingsView` 产物包含“解绑会立即停止本平台的课程数据访问并清除本地授权”“尚未提供已验证的远端撤销接口”“授权过期或失效后，可在此重新绑定”。

## 本地验证

```bash
cd server
npx vitest run test/chaoxing.test.ts   # 14 项通过（含 #1008 新增场景）
npx vitest run test/chaoxing*.test.ts  # 5 文件 47 项通过
npm run typecheck
npm test
npm run build

cd ../frontend
npm run test
npm run build
```

- 后端类型检查与构建通过；全量 1800 项通过、19 项跳过。4 个真实 Docker smoke 因本机无可用 Docker socket 失败，退役叙述扫描被本机忽略目录 `.zcode` 触发；两者均与本变更无关，fresh CI checkout 不受影响。
- 前端 78 文件 / 956 项通过，构建与 admin 产物隔离检查通过。

## 仍需外部完成

1. 生产真实续期观测：在 access token 到期前触发一次 `/capabilities` 或 `/courses`，确认绑定 `expiresAt` 前移；在此之前只宣称本地刷新回归通过。
2. 用第二名学生平台用户复验生产隔离；本地双用户回归只证明平台实现，不替代第二名真实学生账号验收。
3. 待 #1009 上游初始化成功后，复核真实课程数据与远端撤销能力；在此之前不宣称真实课程可用。

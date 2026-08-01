"""OpenClaw wire 域常量单一来源（防腐层集成包 / spec #97 / ADR 0002 / issue #98 / #229）。

#272 预重构（parent #271）：本文件由原 ``integration.openclaw.wire.py`` 模块**原样迁移**为
``wire/`` 子包 ``__init__.py``（包名无下划线，符合「包名禁下划线」约定，呼应 ``OpenClawWire``
Port；issue #271）——``from integration.openclaw.wire import ...`` 的 import 路径不变、
解析到同一模块对象、同对象语义（``is`` / isinstance / 异常 ``__cause__`` 链）完全保持。


收口 chat 三处（pairing_ws / chat_client / event_translate）重复的 wire 知识：协议版本、
connect 帧标识（client_id / mode / role / agent_id）、operator 权限 scopes/caps、配对必须 scope
集、事件族名（approval / tool）、hello-ok policy 解析值对象（GatewayPolicy）与握手前默认、
wire 异常族（ChatClientError 及其子类）。

#229：wire 异常族 / GatewayPolicy / 握手默认常量从 chat.chat_client 迁入本模块（结束防腐层
反向依赖 chat app 拿自己的异常类型）；chat.chat_client 做 **identity-preserving re-export**
（同对象，非拷贝），所有既有 import 与 except 子句零改动。

边界（ADR 0002）：
- 仅 wire 域常量在此收口。容器/编排域常量（GATEWAY_INTERNAL_PORT 等）单一来源仍在 containers app
  （#88-90 后续统一到 containers/constants.py），本包不重复定义。
- 标识符（runId / sessionKey / deviceToken 等）保留 OpenClaw 原生命名、集中管理、不翻译。
"""
from __future__ import annotations

import time
from dataclasses import dataclass

# 协议版本（spec §8.1 / r13 §5.4）
PROTOCOL = 4

# connect 帧固定标识（r13 §5.4 / r40 §3）：client/mode/role 用网关后端语义。
CLIENT_ID = 'gateway-client'
CLIENT_MODE = 'backend'
ROLE = 'operator'
AGENT_ID = 'main'

# spec §8.1：operator.read/write/admin/approvals 四 scope + tool-events cap。
SCOPES = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals']
CAPS = ['tool-events']

# 验收要求：协商 scopes 必须至少包含以下三者，否则聊天/审批调用会缺权失败。
REQUIRED_SCOPES = {'operator.read', 'operator.write', 'operator.approvals'}

# 事件族名（语义层归一用，r26 / spec §8.2）—— Translator 据此把 OpenClaw 原生事件族
# 归一为内部 approval / tool 语义。确切事件名/payload 待配对后实测校准（r26 §0/§3）。
# T06 权限审批（issue #42）：exec/plugin 两族共用同一翻译；连接级事件（不挂 chat runId，r26:88）；
# payload 字段参考 r26:64（官方文档）；取值链集中在 Translator._approval_card。
APPROVAL_REQUESTED_EVENTS = ('exec.approval.requested', 'plugin.approval.requested')
# resolved 为 exec+plugin 双族（issue #154 实测 ghcr 2026.6.34：网关 resolve 后广播
# exec.approval.resolved 非仅 plugin.approval.resolved）；他端 operator 连接 resolve 后网关广播，
# 译为 approvalResolved 帧让共享 client 的 peer 卡片收敛。payload schema 待配对后实测校准
# （r26:78-79 的 approval.resolve 是 client→gateway 方法参数，非本事件 payload），无 id 跳过（不伪造）。
APPROVAL_RESOLVED_EVENTS = ('plugin.approval.resolved', 'exec.approval.resolved')
# T08 工具执行（issue #44 / #153）：挂在 chat run 内（r26 §3），帧带 runId 走既有 runId 路由。
# 实测校准（ghcr 2026.6.34 / ADR 0003 / PR #152 深挖 #3）：工具事件是 event:"agent" +
# payload.stream:"tool" + data.phase:"start"/"update"/"result"，非独立 agent.tool.start/result。
# 字段在 data 子对象下：name/toolCallId/args（start）、partialResult（update）、
# result/isError/meta（result）。
TOOL_AGENT_EVENT = 'agent'
TOOL_STREAM = 'tool'


# ── Gateway hello-ok policy 默认值 + 解析值对象（#196 T1 / #213；#229 迁入防腐层单源）──
# Gateway 协议常量（https://docs.openclaw.ai/zh-CN/gateway/protocol 「客户端常量」节）。
# hello-ok 前的握手期默认（缺 policy 字段时回退）。
DEFAULT_TICK_INTERVAL_MS = 30_000  # 默认 tick 间隔（hello-ok 前）
DEFAULT_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024  # MAX_PAYLOAD_BYTES = 25 MB（26214400）


@dataclass(frozen=True)
class GatewayPolicy:
    """hello-ok ``payload.policy`` 的解析结果（不可变值对象，#196 T1 / #213）。

    网关在 hello-ok 公布实际生效的 ``policy.*``（HelloOkSchema 必填项），客户端应遵循这些值而非
    握手前默认。缺字段回退协议默认：``tickIntervalMs=30000``、``maxPayload=25MB``；``maxBufferedBytes``
    协议未指定握手前默认 → ``None``。``tick_interval_ms`` 驱动静默看门狗（2×tick）；
    ``max_payload_bytes`` 供 T5 发送侧预检；整体供 T3 重连计时复用。
    """
    tick_interval_ms: int
    max_payload_bytes: int
    max_buffered_bytes: int | None

    @classmethod
    def default(cls) -> GatewayPolicy:
        """握手前默认（未收到 hello-ok 时）。"""
        return cls(
            tick_interval_ms=DEFAULT_TICK_INTERVAL_MS,
            max_payload_bytes=DEFAULT_MAX_PAYLOAD_BYTES,
            max_buffered_bytes=None,
        )

    @classmethod
    def from_hello_ok(cls, payload: dict | None) -> GatewayPolicy:
        """从 hello-ok res 的 ``payload`` 解析 ``policy``；缺字段回退协议默认。"""
        policy = ((payload or {}).get('policy') or {})
        buffered = policy.get('maxBufferedBytes')
        return cls(
            tick_interval_ms=int(policy.get('tickIntervalMs', DEFAULT_TICK_INTERVAL_MS)),
            max_payload_bytes=int(policy.get('maxPayload', DEFAULT_MAX_PAYLOAD_BYTES)),
            max_buffered_bytes=int(buffered) if buffered is not None else None,
        )


# ── Wire 异常族（#229 迁入防腐层单源；chat.chat_client identity re-export）──


class ChatClientError(Exception):
    """对话客户端基础错误。"""


class ChatConnectError(ChatClientError):
    """长连接握手失败（connect res not ok / 网络）。"""


class ChatSendError(ChatClientError):
    """chat.send 被网关拒绝（ack not ok）或 ack 缺 runId。"""


class ChatSendTransmittedError(ChatSendError):
    """chat.send 帧可能已发出、但传输结果**未知**——ack 在连接死亡/超时前未到达，或
    send 刷帧中途 socket 关闭（codex #219 P1 / 八轮 P1）。

    区别于网关显式拒绝（ack ok:false，确定未起 run）：此时帧**可能**已 send，网关**可能**
    已起 run，只是 ack 丢失或字节已部分到达。runId 是连接级的（r13-ws-protocol §5.3，重连
    不可恢复进行中 run），若 consumer 拿同 idempotencyKey 盲重试，网关幂等去重返回同一
    runId，但该 run 的事件流绑在死连接上、不会到新 client 的 route——浏览器 pending 消息
    永久卡住。故 consumer 捕获本子类时**不重试**，直接发终态 error 帧解锁前端；只有确定
    未发出的失败（send 前已死 / 显式拒绝）才自愈重试。
    """


class ChatPayloadTooLargeError(ChatSendError):
    """#196 T5 / #216：发送侧帧大小预检超限——本地拒绝（未发出该帧、连接未断）。

    独立子类让 consumer 能把「消息过大」与其他 ChatSendError（网关 ack 拒绝 / ack timeout）区分开：
    前者透传明确文案「请分段发送」，后者仍走通用「发送失败」（spec 只要求把超限映射为可理解错误）。
    """


class ConnectFrameBuilder:
    """单一 connect 帧构造器——消除 pairing_ws._build_connect_frame 与
    chat_client._default_connect_frame 两套重复（issue #102 / spec #97）。

    两种模式：
    - pairing() — 配对握手帧（challenge/nonce/Ed25519 签名/device 块）
    - session() — 已配对长连接帧（deviceToken 直连，无 device 块）
    """

    @staticmethod
    def pairing(*, req_id: str, identity, token: str, nonce: str) -> dict:
        """构造配对握手 connect 帧（spec §8.1 step 2）。

        identity 为 DeviceIdentity（chat.device_crypto），调用端注入。
        """
        from chat.device_crypto import DeviceCrypto

        signed_at_ms = int(time.time() * 1000)
        payload = DeviceCrypto.build_auth_payload_v3(
            device_id=identity.device_id,
            client_id=CLIENT_ID,
            client_mode=CLIENT_MODE,
            role=ROLE,
            scopes=SCOPES,
            signed_at_ms=signed_at_ms,
            token=token,
            nonce=nonce,
            platform='linux',
            device_family='',
        )
        return {
            'type': 'req',
            'id': req_id,
            'method': 'connect',
            'params': {
                'minProtocol': PROTOCOL,
                'maxProtocol': PROTOCOL,
                'client': {
                    'id': CLIENT_ID,
                    'version': '1.0',
                    'platform': 'linux',
                    'mode': CLIENT_MODE,
                },
                'role': ROLE,
                'scopes': list(SCOPES),
                'caps': list(CAPS),
                'commands': [],
                'permissions': {},
                'auth': {'token': token or ''},
                'locale': 'zh-CN',
                'userAgent': 'openclaw-fleet-panel/1.0',
                'device': {
                    'id': identity.device_id,
                    'publicKey': identity.public_key_raw_base64url(),
                    'signature': identity.sign(payload),
                    'signedAt': signed_at_ms,
                    'nonce': nonce,
                },
            },
        }

    @staticmethod
    def session(*, req_id: str, identity, device_token: str, nonce: str, scopes) -> dict:
        """构造已配对长连接 connect 帧（spec §8.1 step 5 / issue #139）。

        与 pairing() 同构——复用 DeviceCrypto.build_auth_payload_v3 构造 Ed25519 device 签名块。
        区别：auth.token 用 device_token（非 gateway token）、scopes 用配对时网关批准并存储的 scopes
        （非全量 SCOPES 常量）。identity 为 DeviceIdentity（chat.device_crypto），调用端注入。
        """
        from chat.device_crypto import DeviceCrypto

        signed_at_ms = int(time.time() * 1000)
        payload = DeviceCrypto.build_auth_payload_v3(
            device_id=identity.device_id,
            client_id=CLIENT_ID,
            client_mode=CLIENT_MODE,
            role=ROLE,
            scopes=scopes,
            signed_at_ms=signed_at_ms,
            token=device_token,
            nonce=nonce,
            platform='linux',
            device_family='',
        )
        return {
            'type': 'req',
            'id': req_id,
            'method': 'connect',
            'params': {
                'minProtocol': PROTOCOL,
                'maxProtocol': PROTOCOL,
                'client': {
                    'id': CLIENT_ID,
                    'version': '1.0',
                    'platform': 'linux',
                    'mode': CLIENT_MODE,
                },
                'role': ROLE,
                'scopes': list(scopes),
                'caps': list(CAPS),
                'commands': [],
                'permissions': {},
                'auth': {'token': device_token},
                'locale': 'zh-CN',
                'userAgent': 'openclaw-fleet-panel/1.0',
                'device': {
                    'id': identity.device_id,
                    'publicKey': identity.public_key_raw_base64url(),
                    'signature': identity.sign(payload),
                    'signedAt': signed_at_ms,
                    'nonce': nonce,
                },
            },
        }

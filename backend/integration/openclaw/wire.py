"""OpenClaw wire 域常量单一来源（防腐层集成包 / spec #97 / ADR 0002 / issue #98）。

收口 chat 三处（pairing_ws / chat_client / event_translate）重复的 wire 知识：协议版本、
connect 帧标识（client_id / mode / role / agent_id）、operator 权限 scopes/caps、配对必须 scope
集、事件族名（approval / tool）。

边界（ADR 0002）：
- 仅 wire 域常量在此收口。容器/编排域常量（GATEWAY_INTERNAL_PORT 等）单一来源仍在 containers app
  （#88-90 后续统一到 containers/constants.py），本包不重复定义。
- 标识符（runId / sessionKey / deviceToken 等）保留 OpenClaw 原生命名、集中管理、不翻译。
"""
import time
import uuid

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
# payload 字段级 schema 官方未给全 → 取值链集中在 Translator._approval_card。
APPROVAL_REQUESTED_EVENTS = ('exec.approval.requested', 'plugin.approval.requested')
# resolved 仅 plugin 族有（r26:47-52，exec 族无对应）；他端 operator 连接 resolve 后网关广播，
# 译为 approvalResolved 帧让共享 client 的 peer 卡片收敛。payload schema 待实测，无 id 跳过（不伪造）。
APPROVAL_RESOLVED_EVENTS = ('plugin.approval.resolved',)
# T08 工具执行（issue #44）：挂在 chat run 内（r26 §3），帧带 runId 走既有 runId 路由。
TOOL_START_EVENTS = ('agent.tool.start',)
TOOL_END_EVENTS = ('agent.tool.result',)


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
    def session(*, req_id: str, device_token: str) -> dict:
        """构造已配对长连接 connect 帧（spec §8.1 step 5）。

        deviceToken 作 auth.token 直连，无需 device 签名块。
        """
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
                'auth': {'token': device_token},
            },
        }

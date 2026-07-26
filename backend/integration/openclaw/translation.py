"""OpenClaw 跨 app 翻译层（issue #105 / spec #97 / ADR 0002）。

三类翻译：
- 配对状态翻译：单一来源 dict 键名（PAIRING_FIELD_*） + build_pairing_status / build_pairing_status_default
- CLI 命令生成：format_device_approve_command（替代 views.py 硬编码 f-string）
- Approval 字段常量：APPROVAL_FIELD_{ID,KIND,DECISION}（替代 serializer 裸字面量）

边界（ADR 0002）：标识符（runId/sessionKey/deviceToken/deviceId）保留原样，仅收口语义类泄漏。
"""
from typing import Any

# ── 配对状态字段常量 ──────────────────────────────────────────────────

PAIRING_FIELD_STATUS = 'status'
PAIRING_FIELD_DEVICE_ID = 'device_id'
PAIRING_FIELD_SCOPES = 'scopes'
PAIRING_FIELD_PAIRING_REQUEST_ID = 'pairing_request_id'


# ── Approval 字段常量 ──────────────────────────────────────────────────

APPROVAL_FIELD_ID = 'id'
APPROVAL_FIELD_KIND = 'kind'
APPROVAL_FIELD_DECISION = 'decision'


# ── 配对状态翻译 ──────────────────────────────────────────────────────


def build_pairing_status_default() -> dict[str, Any]:
    """返回 unpaired 状态的默认 dict（status=unpaired + 空字段）。"""
    return {
        PAIRING_FIELD_STATUS: 'unpaired',
        PAIRING_FIELD_DEVICE_ID: '',
        PAIRING_FIELD_SCOPES: [],
        PAIRING_FIELD_PAIRING_REQUEST_ID: '',
    }


def build_pairing_status(pairing: Any) -> dict[str, Any]:
    """从 Pairing 模型构建配对状态 dict（对齐 PairingStatusSerializer 输出）。

    pairing 须提供 status / device_id / scopes_list() / pairing_request_id 属性。
    """
    return {
        PAIRING_FIELD_STATUS: pairing.status,
        PAIRING_FIELD_DEVICE_ID: pairing.device_id,
        PAIRING_FIELD_SCOPES: pairing.scopes_list(),
        PAIRING_FIELD_PAIRING_REQUEST_ID: pairing.pairing_request_id,
    }


# ── CLI 命令生成 ───────────────────────────────────────────────────────


def format_device_approve_command(request_id: str) -> str:
    """生成 openclaw devices approve <request_id> 命令字符串。"""
    return f'openclaw devices approve {request_id}'

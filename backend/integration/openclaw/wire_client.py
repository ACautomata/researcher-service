"""OpenClaw 长连接对话客户端——identity re-export 薄壳（#272 预重构 / parent #271）。

拆分后主体迁入 ``integration.openclaw.wire`` 子包（包名无下划线，符合「包名禁下划线」
约定，呼应 ``OpenClawWire`` Port；issue #271）。本模块退为薄壳做 **identity re-export**
（同对象，非拷贝）——``OpenClawWireClient`` / ``OnEvent`` / ``HISTORY_RUN_ID`` /
``_ConnectFrameBuilder`` / ``_AGENT_ID`` 的**原 import 路径完全不变**，strangler 零改名，
isomorph 守卫（``test_contract.py`` 对 ``wire_client._ConnectFrameBuilder`` / ``_AGENT_ID``
的 identity 断言）与全部既有测试零改动。

#273 拆分协作者后，门面主体仍在 ``wire.wire_client``（``OpenClawWireClient`` 退为门面，
组合 ``RecoveryCoordinator`` / ``ApprovalFanout``）；共享类型迁 ``wire.values``、
恢复协作者迁 ``wire.recovery``。薄壳按各自真实落点 re-export，import 路径不变。
"""
from integration.openclaw.wire import (
    AGENT_ID as _AGENT_ID,  # re-export：薄壳有意全量转发
)
from integration.openclaw.wire import (  # re-export：薄壳有意全量转发
    ConnectFrameBuilder as _ConnectFrameBuilder,
)
from integration.openclaw.wire.recovery import (  # re-export：薄壳有意全量转发
    RecoveryCoordinator,
)
from integration.openclaw.wire.values import (  # re-export：薄壳有意全量转发
    HISTORY_RUN_ID,
    OnEvent,
    RecoveredRun,
)
from integration.openclaw.wire.wire_client import (  # re-export：薄壳有意全量转发
    OpenClawWireClient,
)

__all__ = [
    'HISTORY_RUN_ID',
    '_AGENT_ID',
    'OnEvent',
    'OpenClawWireClient',
    'RecoveredRun',
    'RecoveryCoordinator',
    '_ConnectFrameBuilder',
]

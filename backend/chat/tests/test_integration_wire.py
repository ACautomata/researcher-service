"""chat wire schema 集成测试（issue #155/#156）：真实 ghcr 2026.6.34 镜像验证 wire 假设。

靠 docker daemon 自动探测门控（DockerDaemonProbe）+ 用例内 env skip（OPENCLAW_TEMPLATE_DIR/
LLM_API_KEY）双保险。T1（#156）：fixture 工厂 + chat.send 冒烟。

手动验证：
  export OPENCLAW_TEMPLATE_DIR=/path/to/researcher
  export OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.6.34-browser
  export LLM_API_KEY=sk-...
  uv run python -m pytest chat/tests/test_integration_wire.py -v

Colima virtiofs 只共享 $HOME，pytest 默认 tmp_path（/var/folders/… 在 $HOME 外）
bind-mount 退化为空目录 → 网关报 Missing config。用 --basetemp 覆盖到 $HOME 下：
  uv run python -m pytest chat/tests/test_integration_wire.py -v --basetemp=$HOME/.cache/pytest-wire
"""
import asyncio
import os
from pathlib import Path

import pytest

from containers.tests.integration_helpers import DockerDaemonProbe

pytestmark = pytest.mark.skipif(
    not DockerDaemonProbe.is_available(),
    reason='需 docker daemon（自动探测；Colima/Docker Desktop 本地 VM 均可）',
)

BASE_DIR = Path(__file__).resolve().parents[3]

_WIRE_TEMPLATE_JSON = str(BASE_DIR / 'deploy' / 'openclaw.json')

# ghcr 官方 browser 镜像（spec #155 / ADR 0003）：覆盖 #94 fork 默认
_WIRE_IMAGE = os.environ.get('OPENCLAW_IMAGE', 'ghcr.io/openclaw/openclaw:2026.6.34-browser')

# 网关冷启动就绪轮询（对齐 #94 smoke）
_GATEWAY_READINESS_TIMEOUT = 60.0
_GATEWAY_POLL_INTERVAL = 1.0

# 配对 approve 轮询独立超时（对齐 #94 smoke）
_PAIRING_APPROVAL_TIMEOUT = 60.0
_PAIRING_POLL_INTERVAL = 1.0


def _check_env_deps():
    """检查集成测试所需的环境依赖；缺任一则 skip。"""
    template_dir = os.environ.get('OPENCLAW_TEMPLATE_DIR')
    if not template_dir or not Path(template_dir).is_dir():
        pytest.skip('需 OPENCLAW_TEMPLATE_DIR 指向 researcher clone')
    if not os.environ.get('LLM_API_KEY'):
        pytest.skip('需 LLM_API_KEY')


class WireTestContext:
    """每测试独立的容器+配对上下文（fixture 工厂，#156）。

    起 ghcr 官方 browser 镜像容器 + Ed25519 配对，返回已配对的 OpenClawChatClient +
    Instance + Pairing。__exit__ 兜底删容器。
    """

    def __init__(self, orch, runtime, pairing_service, health_probe, name):
        self._orch = orch
        self._runtime = runtime
        self._pairing = pairing_service
        self._health_probe = health_probe
        self._name = name
        self._inst = None

    def __enter__(self):
        from chat.chat_client import OpenClawChatClient
        from chat.device_crypto import DeviceIdentity
        from chat.models import Pairing
        from containers.tests.integration_helpers import (
            ApprovalPairer,
            GatewayReadinessWaiter,
        )
        from integration.openclaw.translation import format_device_approve_command

        # 1. 创建容器
        self._inst = self._orch.create(self._name)

        try:
            # 2. 等网关 /health 就绪（冷启动 race）
            GatewayReadinessWaiter(
                self._health_probe,
                timeout=_GATEWAY_READINESS_TIMEOUT,
                interval=_GATEWAY_POLL_INTERVAL,
            ).wait(self._inst.port)

            # 3. Ed25519 配对：遇 PAIRING_REQUIRED 经容器内 approve，轮询至 paired
            def approve(request_id):
                cmd = format_device_approve_command(request_id).split()
                self._orch.exec_in_container(self._inst.name, cmd)

            pairing = ApprovalPairer(
                self._pairing,
                approve,
                timeout=_PAIRING_APPROVAL_TIMEOUT,
                interval=_PAIRING_POLL_INTERVAL,
            ).pair(self._inst)
            assert pairing.status == Pairing.STATUS_PAIRED
            assert pairing.device_token

            # 4. 构造已配对 client（Ed25519 签名路径：identity + scopes 从 Pairing 读取）
            identity = DeviceIdentity(
                device_id=pairing.device_id,
                public_key_pem=pairing.public_key_pem,
                private_key_pem=pairing.private_key_pem,
            )
            client = OpenClawChatClient(
                f'ws://127.0.0.1:{self._inst.port}/', pairing.device_token,
                identity=identity, scopes=pairing.scopes_list(),
            )

            return (client, self._inst, pairing)
        except BaseException:
            # __enter__ 失败时不调用 __exit__，须手动清理已创建容器（codex #164 P2）
            try:
                self._orch.delete(self._name)
            except Exception:  # pylint: disable=broad-exception-caught
                try:
                    self._runtime.stop(self._name)
                    self._runtime.remove(self._name)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
            self._inst = None
            raise

    def __exit__(self, *args):
        if self._inst is not None:
            try:
                self._orch.delete(self._name)
            except Exception:  # pylint: disable=broad-exception-caught
                try:
                    self._runtime.stop(self._name)
                    self._runtime.remove(self._name)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass


@pytest.mark.django_db
def test_send_message_ack_has_runId(tmp_path):
    """T1 冒烟（#156）：起容器+配对后 chat.send 收到 ack 含 runId。

    证明 fixture 可用：容器 running + 配对 STATUS_PAIRED + WS 连通 + ack 协议正确。
    """
    pytest.importorskip('docker')
    _check_env_deps()

    from chat.pairing import PairingService
    from containers.docker_runtime import DockerRuntime
    from containers.orchestrator import FleetConfig, InstanceOrchestrator
    from integration.openclaw.adapters import HttpHealthProbe

    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=Path(os.environ['OPENCLAW_TEMPLATE_DIR']),
        template_json=_WIRE_TEMPLATE_JSON,
        image=_WIRE_IMAGE,
        port_start=19000,
        port_end=19999,
        llm_api_key=os.environ['LLM_API_KEY'],
    )
    runtime = DockerRuntime()
    orch = InstanceOrchestrator(runtime=runtime, config=config)

    name = 'wire-smoke'
    with WireTestContext(
        orch=orch,
        runtime=runtime,
        pairing_service=PairingService(),
        health_probe=HttpHealthProbe(),
        name=name,
    ) as (client, inst, pairing):
        assert inst.name == name

        async def _send():
            await client.connect()
            try:
                events: list[dict] = []

                async def collect(event):
                    events.append(event)

                # ghcr 2026.6.34-browser 要求完整 agent:<agentId>:<key> 格式
                run_id = await client.send_message(
                    'agent:main:wire-smoke-session',
                    'Hello, just acknowledge this message.',
                    on_event=collect,
                )
                assert run_id
                assert isinstance(run_id, str)
                assert len(run_id) > 0
            finally:
                await client.aclose()

        asyncio.run(_send())

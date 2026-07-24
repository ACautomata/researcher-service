"""chat.pairing —— PairingService 配对状态机编排（issue #40 / spec §8.1）。

ensure_paired(instance) 驱动配对状态机：
- 已 paired 且 deviceToken 在 → 幂等复用，不重握手。
- 否则加载/创建设备身份，执行 WS 握手，三分支落库：
  hello-ok → 存 deviceToken+scopes，status=paired；
  PAIRING_REQUIRED → 存 requestId，status=pending（raise PairingRequired 供上层给重试路径）；
  其它错误 → status=error（raise PairingError）。

transport 注入（默认 websockets.connect），测试用 FakeTransport。
握手是 async（websockets）。桥接在**独立线程**跑握手协程（asyncio.run 于该线程）——
本项目跑 ASGI/Daphne：调用方可能是无循环的 sync view 线程，也可能是已有循环的
async view/consumer 线程。两种上下文下 asyncio.run/async_to_sync 都可能崩
（前者在无循环线程安全、后者在有循环线程崩）；独立线程跑协程对两者均安全。
"""
import asyncio
import json
import os
import threading

from django.db import transaction

from chat.device_crypto import DeviceCrypto, DeviceIdentity
from chat.models import Pairing
from chat.pairing_ws import PairingError, PairingHandshake, PairingRequired, PairingResult
from containers.models import Instance


class PairingService:
    """对单个容器实例执行/查询设备配对。"""

    def __init__(self, transport=None, ws_url_for=None) -> None:
        # transport 传给握手层；ws_url_for(instance) → ws://host:port/（可注入便于测试/部署）
        self._transport = transport
        self._ws_url_for = ws_url_for or self._default_ws_url

    @staticmethod
    def _default_ws_url(instance: Instance) -> str:
        # scheme/host 可经环境变量覆盖（codex R security：lan 绑定/生产可切 wss）。
        # 默认 ws://127.0.0.1（loopback，容器端口仅绑 loopback）；wss 由网关 tls.enabled 决定。
        scheme = os.environ.get('OPENCLAW_FLEET_WS_SCHEME', 'ws')
        host = os.environ.get('OPENCLAW_FLEET_WS_HOST', '127.0.0.1')
        return f'{scheme}://{host}:{instance.port}/'

    def _get_or_create(self, instance: Instance) -> Pairing:
        pairing, _ = Pairing.objects.get_or_create(instance=instance)
        return pairing

    def _load_or_create_identity(self, pairing: Pairing) -> DeviceIdentity:
        """已持久化身份则复用（deviceId 稳定），否则生成新身份并落库。"""
        if pairing.private_key_pem and pairing.public_key_pem and pairing.device_id:
            return DeviceIdentity(
                device_id=pairing.device_id,
                public_key_pem=pairing.public_key_pem,
                private_key_pem=pairing.private_key_pem,
            )
        identity = DeviceCrypto.generate_identity()
        pairing.device_id = identity.device_id
        pairing.public_key_pem = identity.public_key_pem
        pairing.private_key_pem = identity.private_key_pem
        return identity

    def get_status(self, instance: Instance) -> Pairing:
        """查询配对状态（无则返回 unpaired 占位行，不触发握手）。"""
        return self._get_or_create(instance)

    def _run_handshake(
        self, url: str, token: str, identity: DeviceIdentity
    ) -> PairingResult:
        """在独立线程跑握手协程（与调用方线程的事件循环隔离，任何上下文安全）。"""
        handshake = PairingHandshake(transport=self._transport)
        box: dict = {}

        def _target() -> None:
            try:
                box['result'] = asyncio.run(
                    handshake.pair(url=url, token=token, identity=identity)
                )
            except BaseException as e:  # 透传握手异常（含 PairingRequired/PairingError）
                box['error'] = e

        thread = threading.Thread(target=_target, daemon=True)
        thread.start()
        thread.join()
        if 'error' in box:
            raise box['error']
        return box['result']

    def ensure_paired(self, instance: Instance, force_repair: bool = False) -> Pairing:
        """触发/重试配对。paired 返回 Pairing；pending/error 抛对应异常（行已落库）。

        force_repair=True 时忽略本地已配对状态，重新握手（用于 deviceToken 被网关撤销/重置后恢复）。
        并发安全：用 select_for_update() 原子化「读取/创建设备身份」；握手本身不在锁内，避免长事务。
        """
        with transaction.atomic():
            pairing = (
                Pairing.objects
                .select_for_update()
                .select_related('instance')
                .filter(instance=instance)
                .first()
            )
            if pairing is None:
                pairing = Pairing.objects.create(instance=instance)

            if (
                not force_repair
                and pairing.status == Pairing.STATUS_PAIRED
                and pairing.device_token
            ):
                return pairing

            identity = self._load_or_create_identity(pairing)
            # 身份必须在本事务内落库：并发请求复用同一 deviceId，避免 approve 命令与真实 key 不一致
            pairing.save()

        # 握手在事务外执行：网络超时/异常不应回滚已持久化的身份或 pending/error 状态
        url = self._ws_url_for(instance)
        try:
            result = self._run_handshake(url, instance.token, identity)
        except PairingRequired as e:
            pairing.pairing_request_id = e.request_id
            pairing.status = Pairing.STATUS_PENDING
            pairing.save()
            raise
        except PairingError:
            pairing.status = Pairing.STATUS_ERROR
            pairing.save()
            raise

        pairing.device_token = result.device_token
        pairing.scopes_json = json.dumps(result.scopes)
        pairing.status = Pairing.STATUS_PAIRED
        pairing.save()
        return pairing


class PairingFleet:
    """PairingService 单例 service locator（view 层依赖；测试用 override 注入 fake）。

    对齐 containers.orchestrator.Fleet 模式：lazy 构造 + override/reset。
    """

    _service: PairingService | None = None

    @classmethod
    def get(cls) -> PairingService:
        if cls._service is None:
            cls._service = PairingService()
        return cls._service

    @classmethod
    def override(cls, service: PairingService) -> None:
        """测试注入替身。"""
        cls._service = service

    @classmethod
    def reset(cls) -> None:
        cls._service = None

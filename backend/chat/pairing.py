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
import random
import re
import threading
import time
from typing import ClassVar

from django.db import IntegrityError, OperationalError, transaction
from django.db.models import F

from chat.device_crypto import DeviceCrypto, DeviceIdentity
from chat.models import Pairing
from chat.pairing_ws import PairingError, PairingHandshake, PairingRequired, PairingResult
from containers.models import Instance

# 网关 requestId 合法字符：与 openclaw 上游一致，仅允许 URL-safe base64 / UUID / 横线 / 下划线
_REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9_.~\-]+$')


class PairingConcurrencyError(Exception):
    """并发场景下本尝试被更新版本覆盖，且原行已不存在（实例被删除）。"""


def _run_with_lock_retry(fn):
    """SQLite 共享缓存表锁（SQLITE_LOCKED，busy handler 不兜底该错误码）有界重试。

    issue #201 问题 3：单进程多线程并发 ensure_paired 时，两个连接的写事务/条件更新
    会撞「database table is locked」。fn 内操作须幂等（get_or_create/条件写/取号重入
    安全）；PostgreSQL 等多 worker 形态无此错误码，行为不变。
    退避带随机抖动：并发方若同步起步，等长退避会确定性互撞（livelock）。
    """
    for attempt in range(5):
        try:
            return fn()
        except OperationalError as e:
            if 'locked' not in str(e).lower() or attempt == 4:
                raise
            time.sleep(0.05 * (attempt + 1) + random.uniform(0, 0.05))
    return None  # pragma: no cover（循环必然 return/raise）


class PairingService:
    """对单个容器实例执行/查询设备配对。"""

    # 应用级每实例锁，补充 SQLite 下 select_for_update 无实际行锁的不足
    _instance_locks: ClassVar[dict[int, threading.Lock]] = {}
    _locks_mutex = threading.Lock()

    def __init__(self, transport=None, ws_url_for=None) -> None:
        # transport 传给握手层；ws_url_for(instance) → ws://host:port/（可注入便于测试/部署）
        self._transport = transport
        self._ws_url_for = ws_url_for or self._default_ws_url

    @classmethod
    def _lock_for(cls, instance_id: int) -> threading.Lock:
        with cls._locks_mutex:
            lock = cls._instance_locks.get(instance_id)
            if lock is None:
                lock = threading.Lock()
                cls._instance_locks[instance_id] = lock
            return lock

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
        """已持久化身份则复用（deviceId 稳定），否则生成新身份并仲裁落库。

        issue #201 问题 3：身份落库改「条件写入空身份字段」仲裁——仅当 DB 身份仍为空
        才写入本进程生成的身份；并发方（另一进程/worker）已先写入则以其为准重读，
        杜绝两进程各持不同私钥完成握手导致 deviceToken 与落库公钥永久错位。
        """
        if pairing.private_key_pem and pairing.public_key_pem and pairing.device_id:
            return DeviceIdentity(
                device_id=pairing.device_id,
                public_key_pem=pairing.public_key_pem,
                private_key_pem=pairing.private_key_pem,
            )
        identity = DeviceCrypto.generate_identity()
        # 仲裁条件只用明文列（device_id/public_key_pem）；private_key_pem 是密文列，
        # 等值过滤会经加密 prep 无法匹配，不可进 WHERE。
        written = (
            Pairing.objects
            .filter(pk=pairing.pk, device_id='', public_key_pem='')
            .update(
                device_id=identity.device_id,
                public_key_pem=identity.public_key_pem,
                private_key_pem=identity.private_key_pem,
            )
        )
        if written:
            pairing.device_id = identity.device_id
            pairing.public_key_pem = identity.public_key_pem
            pairing.private_key_pem = identity.private_key_pem
            return identity
        # 并发方已先写入身份：以 DB 已有身份为准（approve 命令与真实 key 保持一致）
        pairing.refresh_from_db(fields=['device_id', 'public_key_pem', 'private_key_pem'])
        return DeviceIdentity(
            device_id=pairing.device_id,
            public_key_pem=pairing.public_key_pem,
            private_key_pem=pairing.private_key_pem,
        )

    @staticmethod
    def _next_attempt_version(pairing: Pairing) -> int:
        """数据库层原子取号（issue #201 问题 3）：UPDATE ... SET v=v+1 后重读取值。

        杜绝原「读-改-写 save()」在 SQLite + 多进程下取到重号（双方同读 N 各 +1）。
        """
        Pairing.objects.filter(pk=pairing.pk).update(
            attempt_version=F('attempt_version') + 1,
        )
        pairing.refresh_from_db(fields=['attempt_version'])
        return pairing.attempt_version

    def get_status(self, instance: Instance) -> Pairing:
        """查询配对状态（无则返回 unpaired 占位行，不触发握手）。"""
        return self._get_or_create(instance)

    def _run_handshake(
        self, url: str, token: str, identity: DeviceIdentity,
    ) -> PairingResult:
        """在独立线程跑握手协程（与调用方线程的事件循环隔离，任何上下文安全）。"""
        handshake = PairingHandshake(transport=self._transport)
        box: dict = {}

        def _target() -> None:
            try:
                box['result'] = asyncio.run(
                    handshake.pair(url=url, token=token, identity=identity),
                )
            except BaseException as e:  # pylint: disable=broad-exception-caught
                box['error'] = e

        thread = threading.Thread(target=_target, daemon=True)
        thread.start()
        thread.join()
        if 'error' in box:
            raise box['error']
        return box['result']

    @staticmethod
    def _is_valid_request_id(request_id: str) -> bool:
        """requestId 必须非空且只含安全字符，避免注入宿主 shell 命令。"""
        return bool(request_id) and bool(_REQUEST_ID_RE.match(request_id))

    def ensure_paired(self, instance: Instance, force_repair: bool = False) -> Pairing:
        """触发/重试配对。paired 返回 Pairing；pending/error 抛对应异常（行已落库）。

        force_repair=True 时忽略本地已配对状态，重新握手（用于 deviceToken 被网关撤销/重置后恢复）。
        并发安全：应用级每实例锁 + select_for_update() 双重保护，确保「读取/创建设备身份」原子化；
        握手结果用 attempt_version 条件更新，防止并发/延迟响应覆盖更新状态。
        issue #201 问题 3：attempt_version 数据库原子取号 + 身份「条件写入空字段」仲裁；
        事务块与结果落库均经 _run_with_lock_retry 兜 SQLite 共享缓存表锁。
        """

        def _reserve_attempt():
            with self._lock_for(instance.pk), transaction.atomic():
                pairing = (
                    Pairing.objects
                    .select_for_update()
                    .select_related('instance')
                    .filter(instance=instance)
                    .first()
                )
                if pairing is None:
                    # issue #201 问题 3：create → get_or_create 并兜 IntegrityError 重读，
                    # 并发创建竞争不再裸抛 500。
                    try:
                        pairing, _ = Pairing.objects.get_or_create(instance=instance)
                    except IntegrityError:
                        pairing = Pairing.objects.get(instance=instance)

                if (
                    not force_repair
                    and pairing.status == Pairing.STATUS_PAIRED
                    and pairing.device_token
                ):
                    return pairing, None, None  # 幂等复用：identity=None 作 fast-path 信号

                # 身份必须在本事务内落库：并发请求复用同一 deviceId，避免 approve 命令与真实 key 不一致
                # （issue #201：落库方式改「条件写入空身份字段」仲裁，见 _load_or_create_identity）
                identity = self._load_or_create_identity(pairing)
                # issue #201 问题 3：attempt_version 改数据库层原子取号（不再读-改-写 save()）
                attempt_version = self._next_attempt_version(pairing)
                return pairing, identity, attempt_version

        pairing, identity, attempt_version = _run_with_lock_retry(_reserve_attempt)
        if identity is None:
            return pairing  # 已 paired 且 token 在 → 幂等复用，不重握手

        # 握手在事务外执行：网络超时/异常不应回滚已持久化的身份或 pending/error 状态
        url = self._ws_url_for(instance)
        try:
            result = self._run_handshake(url, instance.token, identity)
        except PairingRequired as e:
            if not self._is_valid_request_id(e.request_id):
                _run_with_lock_retry(lambda: self._apply_result(
                    pairing,
                    attempt_version=attempt_version,
                    status=Pairing.STATUS_ERROR,
                    pairing_request_id='',
                ))
                raise PairingError(f'invalid pairing requestId: {e.request_id!r}') from e
            _run_with_lock_retry(lambda e=e: self._apply_result(
                pairing,
                attempt_version=attempt_version,
                status=Pairing.STATUS_PENDING,
                pairing_request_id=e.request_id,
            ))
            raise
        except PairingError:
            _run_with_lock_retry(lambda: self._apply_result(
                pairing,
                attempt_version=attempt_version,
                status=Pairing.STATUS_ERROR,
            ))
            raise

        _run_with_lock_retry(lambda: self._apply_result(
            pairing,
            attempt_version=attempt_version,
            status=Pairing.STATUS_PAIRED,
            device_token=result.device_token,
            scopes_json=json.dumps(result.scopes),
        ))
        return pairing

    def _apply_result(
        self,
        pairing: Pairing,
        *,
        attempt_version: int,
        status: str,
        device_token: str | None = None,
        scopes_json: str | None = None,
        pairing_request_id: str | None = None,
    ) -> None:
        """条件落库：仅当 DB 行 attempt_version 仍是本尝试时写入，防止并发覆盖。

        使用 F() 表达式在数据库层原子更新，避免读取陈旧对象。
        """
        from django.db.models import F

        updates: dict = {'status': status}
        if device_token is not None:
            updates['device_token'] = device_token
        if scopes_json is not None:
            updates['scopes_json'] = scopes_json
        if pairing_request_id is not None:
            updates['pairing_request_id'] = pairing_request_id
        else:
            updates['pairing_request_id'] = ''

        updated = (
            Pairing.objects
            .filter(pk=pairing.pk, attempt_version=attempt_version)
            .update(**updates, attempt_version=F('attempt_version') + 1)
        )
        if updated == 0:
            # 本次尝试结果已被更新版本覆盖，或原行已被删除
            try:
                pairing.refresh_from_db()
            except Pairing.DoesNotExist:
                # 实例在握手期间被删除；向调用方表明目标已消失
                raise PairingConcurrencyError('pairing row deleted during handshake') from None
        else:
            # 同步内存对象，便于调用方立即读取
            for key, value in updates.items():
                setattr(pairing, key, value)
            pairing.attempt_version = attempt_version + 1


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

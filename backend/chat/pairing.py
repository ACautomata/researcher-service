"""chat.pairing —— PairingService 配对状态机编排（issue #40 / spec §8.1）。

ensure_paired(instance) 驱动配对状态机：
- 已 paired 且 deviceToken 在 → 幂等复用，不重握手。
- 否则加载/创建设备身份，执行 WS 握手，三分支落库：
  hello-ok → 存 deviceToken+scopes，status=paired；
  PAIRING_REQUIRED → 存 requestId，status=pending（raise PairingRequired 供上层给重试路径）；
  其它错误 → status=error（raise PairingError）。

自动 approve（面板默认开启）：握手得 PAIRING_REQUIRED(requestId) 时，若注入了 approver，
在容器内执行 ``openclaw devices approve <requestId>`` 后用同一 deviceId 身份重握手一次。
OpenClaw 的 operator scope 不在 WS 握手授予，须宿主显式 approve（spec §8.1）；面板作为受信
控制面代行 approve，使前端点「配对」一步到位（issue：配对「设备待批准」断裂）。

transport 注入（默认 websockets.connect），测试用 FakeTransport。
握手是 async（websockets）。桥接在**独立线程**跑握手协程（asyncio.run 于该线程）——
本项目跑 ASGI/Daphne：调用方可能是无循环的 sync view 线程，也可能是已有循环的
async view/consumer 线程。两种上下文下 asyncio.run/async_to_sync 都可能崩
（前者在无循环线程安全、后者在有循环线程崩）；独立线程跑协程对两者均安全。
"""
import asyncio
import json
import os
import re
import threading
from typing import ClassVar, Protocol

from django.db import transaction

from chat.device_crypto import DeviceCrypto, DeviceIdentity
from chat.models import Pairing
from chat.pairing_ws import PairingError, PairingHandshake, PairingRequired, PairingResult
from containers.models import Instance

# 网关 requestId 合法字符：与 openclaw 上游一致，仅允许 URL-safe base64 / UUID / 横线 / 下划线
_REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9_.~\-]+$')

# 容器内 gateway CLI：approve 一个 pending 配对请求（spec §8.1 宿主侧动作）。
# approver 在容器内（root）执行，gateway 据 requestId 批准该 deviceId 的 operator scope。
_OPENCLAW_APPROVE_CMD = ['openclaw', 'devices', 'approve']


class PairingApprover(Protocol):
    """在目标实例容器内批准一个 pending 配对请求（spec §8.1 approve 动作的抽象）。

    默认实现 ``ExecPairingApprover`` 经 containers runtime 的 exec_sync 执行 gateway CLI。
    抽象为 Protocol 使 PairingService 不直接依赖 containers 具体 runtime，便于测试注入 fake。
    """

    def approve(self, instance_name: str, request_id: str) -> None:
        """批准 ``request_id``；失败抛异常（PairingService 据此落 pending 不重握手）。"""


class ExecPairingApprover:
    """默认 approver：经 Fleet orchestrator 在容器内同步执行 ``openclaw devices approve``。

    用 exec_sync（等命令完成）而非 exec_in_container（fire-and-forget detach）——approve 须
    在重握手前真正落库到 gateway 设备表，否则重握手仍 PAIRING_REQUIRED。
    """

    def __init__(self, executor) -> None:
        # executor(instance_name, cmd)：委托 orchestrator.exec_sync（容器内 root 跑 CLI）。
        self._executor = executor

    def approve(self, instance_name: str, request_id: str) -> None:
        # codex P2 :2902641 review（chat/pairing.py:66）：DockerRuntime.exec_sync (2902641 +
        # Phase 2.1 改) 在 approve CLI 退出码非零（token 不匹配 / request ID 过期 / 网关断连）
        # 时抛 RuntimeError。仅让 RuntimeError 冒泡会让 PairingService 把它当未知失败、未走
        # STATUS_ERROR 路径，原始 actionable pending 仍留在库里但上层以为是「没配对」触发重握手
        # → 生成新 requestId → 替换原 actionable 请求 → 配对 churn 无限循环。
        # 在这里转译为 PairingError（与 spec §8.1 配对错误统一），让 PairingService 的
        # ``except PairingError`` 分支落 STATUS_ERROR，行不再 actionable。
        try:
            self._executor(instance_name, _OPENCLAW_APPROVE_CMD + [request_id])
        except RuntimeError as e:
            raise PairingError(
                f'openclaw devices approve failed in {instance_name}: {e}',
            ) from e


class PairingConcurrencyError(Exception):
    """并发场景下本尝试被更新版本覆盖，且原行已不存在（实例被删除）。"""


class PairingService:
    """对单个容器实例执行/查询设备配对。"""

    # 应用级每实例锁，补充 SQLite 下 select_for_update 无实际行锁的不足
    _instance_locks: ClassVar[dict[int, threading.Lock]] = {}
    _locks_mutex = threading.Lock()

    def __init__(self, transport=None, ws_url_for=None, approver: PairingApprover | None = None) -> None:
        # transport 传给握手层；ws_url_for(instance) → ws://host:port/（可注入便于测试/部署）
        self._transport = transport
        self._ws_url_for = ws_url_for or self._default_ws_url
        # 自动 approve：注入则在 PAIRING_REQUIRED 后 approve + 重握手；None 则保持原 pending 行为。
        self._approver = approver

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
        """
        with self._lock_for(instance.pk), transaction.atomic():
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
            pairing.attempt_version += 1
            attempt_version = pairing.attempt_version
            pairing.save()

        # 握手在事务外执行：网络超时/异常不应回滚已持久化的身份或 pending/error 状态
        url = self._ws_url_for(instance)
        try:
            result = self._run_handshake(url, instance.token, identity)
        except PairingRequired as e:
            if not self._is_valid_request_id(e.request_id):
                self._apply_result(
                    pairing,
                    attempt_version=attempt_version,
                    status=Pairing.STATUS_ERROR,
                    pairing_request_id='',
                )
                raise PairingError(f'invalid pairing requestId: {e.request_id!r}') from e
            # 自动 approve（面板默认开启）：受信控制面代行 spec §8.1 宿主 approve，
            # 使前端「配对」一步到位。approver 为 None 时保持原 pending 行为（不自动 approve）。
            result = self._approve_and_rehandshake(
                instance, pairing, identity, e.request_id, attempt_version,
            )
        except PairingError:
            self._apply_result(
                pairing,
                attempt_version=attempt_version,
                status=Pairing.STATUS_ERROR,
            )
            raise

        self._apply_result(
            pairing,
            attempt_version=attempt_version,
            status=Pairing.STATUS_PAIRED,
            device_token=result.device_token,
            scopes_json=json.dumps(result.scopes),
        )
        return pairing

    def _approve_and_rehandshake(
        self,
        instance: Instance,
        pairing: Pairing,
        identity: DeviceIdentity,
        request_id: str,
        attempt_version: int,
    ) -> PairingResult:
        """PAIRING_REQUIRED 后的自动 approve + 重握手。

        无 approver（或 approve 失败）→ 落 pending + raise PairingRequired（保留原行为）。
        approve 成功 → 用同一 deviceId 身份重握手一次：gateway 已批准该 deviceId 的 operator
        scope，重握手应 hello-ok 拿 deviceToken。重握手仍 PAIRING_REQUIRED（approve 未生效/竞态）
        或其它错误 → 落 pending/error + 抛对应异常。
        """
        # 无 approver：保持原行为——落 pending + raise PairingRequired（调用方 view 给重试路径）
        if self._approver is None:
            self._apply_result(
                pairing=pairing,
                attempt_version=attempt_version,
                status=Pairing.STATUS_PENDING,
                pairing_request_id=request_id,
            )
            raise PairingRequired(request_id)
        # approve 失败分两类（codex P2 :2902641 review + :f617d25 review）：
        # 1. PairingError（来自 ExecPairingApprover 把 exec_sync RuntimeError 转译；或
        #    future approver 实现抛 PairingError）→ 真正的 error，不降级 pending，落
        #    STATUS_ERROR 后 raise PairingError，让 API 返 502/admin 看到失败。
        #    保留 pending fallback 会让 admin 以为「设备待批准」可重试，但实际是
        #    CLI 永久失败（token 不匹配 / request ID 过期 / 网关断连）→ 配对 churn 无限循环。
        # 2. 其它异常（容器未起 / network / OSError 等 transient，admin 重新配对可恢复）
        #    → 保留原 pending fallback + raise PairingRequired 给 view 重试路径。
        try:
            self._approver.approve(instance.name, request_id)
        except PairingError:
            self._apply_result(
                pairing=pairing,
                attempt_version=attempt_version,
                status=Pairing.STATUS_ERROR,
                pairing_request_id=request_id,
            )
            raise
        except Exception as exc:  # pylint: disable=broad-exception-caught
            self._apply_result(
                pairing=pairing,
                attempt_version=attempt_version,
                status=Pairing.STATUS_PENDING,
                pairing_request_id=request_id,
            )
            raise PairingRequired(request_id) from exc
        # 重握手（同一 identity/deviceId；attempt_version 不变，成功后统一 _apply_result 落 paired）
        url = self._ws_url_for(instance)
        try:
            return self._run_handshake(url, instance.token, identity)
        except PairingRequired as e:
            # approve 后仍 pending：approve 未生效（CLI 未落库/竞态）→ 落最新 requestId + raise
            if self._is_valid_request_id(e.request_id):
                self._apply_result(
                    pairing=pairing,
                    attempt_version=attempt_version,
                    status=Pairing.STATUS_PENDING,
                    pairing_request_id=e.request_id,
                )
            else:
                self._apply_result(
                    pairing=pairing,
                    attempt_version=attempt_version,
                    status=Pairing.STATUS_ERROR,
                    pairing_request_id='',
                )
                raise PairingError(f'invalid pairing requestId after approve: {e.request_id!r}') from e
            raise
        except PairingError:
            # codex P2 :257：重握手抛 PairingError（网关断连/坏帧/超时）时，本异常源自外层
            # ``except PairingRequired`` 块内的本次调用，外层 sibling ``except PairingError`` 无法
            # 再捕获（Python：进入某 except handler 后，同一 try 的其它 except 不再 consult）。
            # 须在此落 STATUS_ERROR 再 raise，否则配对行停留在旧状态（force_repair 时甚至残留
            # 已撤销的 paired + 旧 deviceToken），且 API 返 502 时 DB 与真实配对态不一致。
            self._apply_result(
                pairing=pairing,
                attempt_version=attempt_version,
                status=Pairing.STATUS_ERROR,
            )
            raise

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
            cls._service = PairingService(approver=_default_approver())
        return cls._service

    @classmethod
    def override(cls, service: PairingService) -> None:
        """测试注入替身。"""
        cls._service = service

    @classmethod
    def reset(cls) -> None:
        cls._service = None


def _default_approver() -> PairingApprover | None:
    """默认 approver：经 containers Fleet 在容器内执行 ``openclaw devices approve``。

    lazy 引用 containers.Fleet（避免 chat ↔ containers 顶层循环导入）；Fleet.get() 在容器
    daemon 不可达或 settings 未就绪时可能抛异常——保守返回 None（退回原 pending 行为，
    由人工 approve），不阻断 PairingService 构造。
    """
    try:
        from containers.orchestrator import Fleet
        return ExecPairingApprover(Fleet.get().exec_sync)
    except Exception:  # pylint: disable=broad-exception-caught
        return None

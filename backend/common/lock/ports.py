"""common.lock —— 分布式锁共享 kernel 的 Port 契约（issue #251 / parent #243）。

Lock 横切基础设施：``containers``（create 租约 / in-flight 防重）与 ``chat``（pairing
互斥）都要用，故归属中立共享 kernel ``backend/common/lock/``，**不并入** ``integration/
openclaw/`` 防腐层——Redis 是自有持久化/协调基础设施，非外部 vendor 域（ADR 0002 定位
不同，照搬防腐层会错配）。

本模块仅定义**可注入的抽象**（Port 面，#246）：窄 ``DistributedLock`` Protocol + 闭合
``LockResource`` tagged union + ``LeaseHandle``。不碰 Redis、不接任何调用点（#251 契约侧
范围）。租约语义折叠进 TTL + renew，不设 Lease 子类型，不用裸 ``async with`` 省略续约。

**防 KV 逃逸口（两层都要，#246 Q6）：**
1. 类型化 resource：Port 由闭合 ``LockResource`` tagged union 键控（``ProvisionResource`` /
   ``PairingResource``），**绝不收裸 string**——新增用途须新增类型化 resource。
2. 窄 lock-only 签名：仅露 ``acquire``/``try_acquire``/``renew``/``release``，无 get/set/
   通用 KV；Redis 键由 adapter 内部构造、永不外泄。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import ClassVar, Protocol, runtime_checkable


@runtime_checkable
class LockResource(Protocol):
    """闭合 tagged union 的运行时标记（防 KV 逃逸口 #246 Q6 / #251 AC2）。

    只声明 ``kind`` 标记；各变体（``ProvisionResource`` / ``PairingResource``）为
    frozen dataclass，携带锁定所需的标识字段。Port 绝不受裸 string 作 resource——
    新增用途须新增类型化 resource（type-level guard）。
    """

    kind: ClassVar[str]


@dataclass(frozen=True)
class ProvisionResource:
    """容器 create 流程的锁资源：按容器名互斥（orchestrator create 租约 / in-flight 防重）。"""

    container_name: str

    kind: ClassVar[str] = 'provision'


@dataclass(frozen=True)
class PairingResource:
    """配对流程的锁资源：按实例 id 互斥（PairingService._instance_locks 跨进程化）。"""

    instance_id: int

    kind: ClassVar[str] = 'pairing'


@runtime_checkable
class LeaseHandle(Protocol):
    """一次成功获取的租约句柄。租约随 TTL 自动过期；续约/释放由持有方显式调用。"""

    async def renew(self, new_ttl: timedelta) -> None:
        """将租约 TTL 续至 ``new_ttl``；租约已过期时 no-op（不 resurrect 锁）。"""
        ...

    async def release(self) -> None:
        """释放租约（幂等）；此后再次 release 不再生效。"""
        ...


@runtime_checkable
class DistributedLock(Protocol):
    """窄分布式锁 Port（#246 唯一 Port / #251 AC1）。

    契约（租约语义折叠进 TTL+renew，不设 Lease 子类型，不用裸 ``async with`` 省略续约）：

    ::

        acquire(resource: LockResource, ttl) -> LeaseHandle      # 阻塞
        try_acquire(resource, ttl) -> LeaseHandle | None         # 非阻塞
        LeaseHandle: renew(new_ttl) ; release()

    **防 KV 逃逸口：** 仅露 acquire/try_acquire，无 get/set/通用 KV（结构性 guard）。
    """

    async def acquire(self, resource: LockResource, ttl: timedelta) -> LeaseHandle:
        """阻塞获取 ``resource`` 的租约（持有至 release / TTL 过期）。

        :param resource: 类型化锁资源（闭合 tagged union，绝收裸 string）。
        :param ttl: 租约 TTL；持有方须在 TTL 内 renew 以延长。
        :return: 租约句柄。
        """
        ...

    async def try_acquire(self, resource: LockResource, ttl: timedelta) -> LeaseHandle | None:
        """非阻塞获取 ``resource`` 的租约。

        :return: 获取成功返回 ``LeaseHandle``；已被他人持有返回 ``None``。
        """
        ...

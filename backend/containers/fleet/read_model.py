"""containers.fleet.read_model —— 读侧聚合（FleetReadModel，parent #277 / #279）。

#279 预重构（parent #277）：从原 ``containers.fleet.orchestrator.py`` 剥离**读侧**（list / detail /
created_item / _reconcile_creating / _build_item / _item），独立于写侧生命周期命令演进。只依赖
``FleetDeps`` 中的运行时 + 健康探测 + inflight guard；**不依赖写侧任何私有状态**。

- ``list``：DB 记账 + runtime 实时状态 + gateway 健康探测聚合（issue #39 验收），健康探测并发
  （ThreadPoolExecutor），bound 总延迟（非 N×timeout 串行；否则 20 不可达容器阻塞管理页约 40s）。
- ``_reconcile_creating``：list 读路径上的 **lazy-repair 对账**（只在 list 时被调、目的是让读侧
  返回准确 DTO），虽写 DB 但属读的副产物；inflight guard 经 ``FleetDeps`` 共享。会写 DB 的名义
  瑕疵以此注释说明。
- ``detail`` / ``created_item``：单实例聚合视图（POST 响应复用）。

依赖方向：``read_model`` → ``deps`` → ``values``（零 import 编排协作者），无环。
"""
from concurrent.futures import ThreadPoolExecutor

from django.utils import timezone

from containers.constants import MAX_HEALTH_WORKERS
from containers.fleet.values import (
    HEALTH_HEALTHY,
    HEALTH_PENDING,
    HEALTH_REMOVING,
    HEALTH_STOPPED,
    HEALTH_UNHEALTHY,
)
from containers.models import Instance


class FleetReadModel:
    """容器实例的读侧聚合（list/detail/created_item + creating 行对账）。"""

    def __init__(self, deps) -> None:
        self._deps = deps

    def _item(self, inst: Instance, status: str, health: str) -> dict:
        return {
            'name': inst.name,
            'port': inst.port,
            'status': status,
            'health': health,
            'image': inst.image,
            'container_id': inst.container_id,
            'created_at': inst.created_at,
        }

    def _build_item(self, inst: Instance) -> dict:
        """聚合单个 Instance 的 runtime 状态 + gateway 健康探测。

        codex R1 :133：creating/removing 瞬态透传（容器未起时 runtime.get 缺失
        不应误判 stopped，否则暴露错误生命周期、诱使他方对未就绪实例操作）。
        （creating 行的 runtime 对账/自愈在 list() 主线程完成，见 _reconcile_creating。）
        """
        if inst.status == Instance.STATUS_CREATING:
            return self._item(inst, Instance.STATUS_CREATING, HEALTH_PENDING)
        if inst.status == Instance.STATUS_REMOVING:
            return self._item(inst, Instance.STATUS_REMOVING, HEALTH_REMOVING)
        if inst.status == Instance.STATUS_ERROR:
            # codex R3 :319：中断收敛为 error 的行（provisioning 未完成）透传，不探健康
            return self._item(inst, Instance.STATUS_ERROR, HEALTH_STOPPED)
        # codex R7 :400：runtime.get() 可能因 daemon 不可用抛异常（非 NotFound），
        # ThreadPoolExecutor.map 在任一 item 异常时终止整个 list。
        # 单项抖动不隐藏其他正常容器——降级透传 unknown 状态。
        try:
            info = self._deps.runtime.get(inst.name)
        except Exception:  # pylint: disable=broad-exception-caught
            return self._item(inst, Instance.STATUS_RUNNING, HEALTH_STOPPED)
        running = bool(info and info.running)
        status = Instance.STATUS_RUNNING if running else Instance.STATUS_STOPPED
        if running:
            health = (
                HEALTH_HEALTHY
                if self._deps.health.is_reachable(inst.port)
                else HEALTH_UNHEALTHY
            )
        else:
            health = HEALTH_STOPPED
        return self._item(inst, status, health)

    def _reconcile_creating(self, insts: list[Instance]) -> None:
        """主线程对账 creating 行（codex R2 :226 / R3 :319）。

        仅处理**非在飞**的 creating 行（在飞者正被本进程 create provisioning，跳过）。
        非在飞即「崩溃中断」——按 runtime 实况收敛，不再永久 pending 占名/占端口：
        - 容器已 running（崩溃在最终 save 前，Docker 已起）→ 自愈为 running 并落盘。
        - 容器存在但未 running（created/exited，崩溃于 start 前后）→ 收敛为 stopped。
        - 无容器（崩溃在 run 之前）→ 收敛为 error（provisioning 未完成；行可经 delete 清除）。

        主线程串行执行（非线程池）：creating 行通常极少，且 Django ORM save 不宜在
        worker 线程做（pytest 事务包裹下 worker 连接隔离，落盘不可见）。

        codex R8 F1：跨进程 lease 替代 R7 的 created_at+60s。lease_expires_at 由 _reserve_row
        设置、create 在 run 前 checkpoint 续约；lease 未过期 = 有活动 create 持有（即使本进程
        inflight 不可见的多 worker 长 create），不收敛。None/过期 = 无活动持有，按崩溃中断收敛。
        """
        now = timezone.now()
        for inst in insts:
            if inst.status != Instance.STATUS_CREATING:
                continue
            if inst.name in self._deps.inflight:
                continue            # 正在 provisioning，非中断——跳过对账
            # codex R8 F1：lease 未过期 = 有活动 create 持有（_reserve_row 设、create 续约），
            # 即使本进程 inflight 不可见（多 worker 另一 worker 的长 create）也不收敛。
            # None/过期 = 无活动持有 → 按崩溃中断收敛。
            lease = inst.lease_expires_at
            if lease is not None and now < lease:
                continue
            # codex R8 F3：reconcile 的 runtime 查询与 _build_item（R7 :400）对称容错——
            # daemon 临时不可用时 get() 抛异常，须逐行降级（保持 creating/pending，下次 list 再
            # 对账），而非让整个 GET /containers/ 500 隐藏全部已持久化 instance。
            try:
                info = self._deps.runtime.get(inst.name)
            except Exception:  # pylint: disable=broad-exception-caught
                continue
            # codex R9-2 (P1)：label guard —— 仅 openclaw.instance label 匹配本行名的容器
            # 才被采纳为「本行拥有」。同名外来容器（手动创建/恢复/旧部署无 label）的 container_id
            # 不得写入 inst.container_id（否则后续 delete 的 live-ID 比对通过，误删外来容器）。
            if info and info.running and info.instance_name == inst.name:
                inst.status = Instance.STATUS_RUNNING
                if info.container_id:
                    inst.container_id = info.container_id
            elif info is not None and info.instance_name == inst.name:
                inst.status = Instance.STATUS_STOPPED
                if info.container_id:
                    inst.container_id = info.container_id
            else:
                inst.status = Instance.STATUS_ERROR
            try:
                inst.save(update_fields=['status', 'container_id'])
            except Exception:  # pylint: disable=broad-exception-caught
                # 落盘失败不阻断本次出参（内存对象已收敛，下次 list 再对账）
                pass

    def list(self) -> list[dict]:
        """聚合 DB 记账 + runtime 实时状态 + gateway 健康探测（issue #39 列表验收）。

        codex R1 :156：健康探测并发（ThreadPoolExecutor），bound list 延迟
        （非 N×timeout 串行；否则 20 不可达容器阻塞管理页约 40s）。
        insts 先物化（主线程迭代 QuerySet），_build_item 只读已加载字段 + 线程安全 IO。
        """
        insts = list(Instance.objects.order_by('created_at'))
        if not insts:
            return []
        # codex R2 :226：主线程先对账 creating 行（崩溃中断者自愈为 running），再进线程池
        self._reconcile_creating(insts)
        workers = max(1, min(MAX_HEALTH_WORKERS, len(insts)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            return list(pool.map(self._build_item, insts))

    def created_item(self, inst: Instance) -> dict:
        """由刚创建成功的 Instance 构造 POST 响应（codex R4 :60）。

        不做 runtime/health 二次查询——create 已 commit 并启动容器，若随后 detail() 的
        runtime 查询因 daemon 抖动失败，会让已成功的创建返回 500（客户端误判失败重试撞 409）。
        容器刚起、gateway 未就绪，health 即 pending（后续 list 轮询会反映真实健康）。
        """
        return self._item(inst, Instance.STATUS_RUNNING, HEALTH_PENDING)

    def detail(self, name: str) -> dict | None:
        """单个实例的聚合视图（post 响应复用）；不存在返回 None。"""
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            return None
        return self._build_item(inst)

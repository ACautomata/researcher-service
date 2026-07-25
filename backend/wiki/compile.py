"""wiki compile 触发器 —— spec §6 / r29 §2.4。

memory-wiki 无文件监听：后端直写后浏览页即时一致，但搜索索引/digest 滞后到下次 compile。
新建/删除后异步去抖触发一次 `wiki compile` 同步机器视图（编辑类低频人工不主动触发，
见 r29 §2.3）。真实执行走容器 exec（`docker exec <cid> openclaw wiki compile`），本地无真容器，
故经 CompileFleet locator 注入，测试可换 fake 断言「触发且去抖」。
"""
import threading
from typing import Protocol


class CompileExecutor(Protocol):
    """compile 执行策略接口（真实走 docker exec；测试可注入 fake）。"""

    def execute(self, instance) -> None:
        ...


class DockerCompileExecutor:
    """真实触发：容器内 exec openclaw wiki compile（best-effort，失败不阻断写操作）。"""

    def execute(self, instance) -> None:
        from containers.orchestrator import Fleet  # 局部导入避免循环依赖
        try:
            client = Fleet.get().client  # docker-py client（orchestrator 持有）
            container = client.containers.get(instance.container_id)
            container.exec_run(['openclaw', 'wiki', 'compile'], detach=True)
        except Exception:  # noqa: BLE001 — compile 滞后不影响人类视图，静默降级（r29 §2.4）
            pass


class DebouncedCompileTrigger:
    """按容器去抖合并的 compile 触发器：窗口内多次写只触发一次（组合 executor）。"""

    def __init__(self, executor: CompileExecutor | None = None,
                 debounce_seconds: float = 5.0) -> None:
        self._executor = executor or DockerCompileExecutor()
        self._debounce = debounce_seconds
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def __call__(self, instance) -> None:
        name = instance.name
        with self._lock:
            existing = self._timers.get(name)
            if existing is not None:
                existing.cancel()
            timer = threading.Timer(self._debounce, self._fire, args=(instance,))
            self._timers[name] = timer
            timer.daemon = True
            timer.start()

    def _fire(self, instance) -> None:
        with self._lock:
            self._timers.pop(instance.name, None)
        self._executor.execute(instance)


class CompileFleet:
    """compile 触发器 service locator（对齐 Fleet/PairingFleet：lazy 构造 + override/reset）。

    生产为 DebouncedCompileTrigger；测试 override 为记录调用的 fake（同步、无去抖）。
    """

    _trigger = None

    @classmethod
    def get(cls):
        if cls._trigger is None:
            cls._trigger = DebouncedCompileTrigger()
        return cls._trigger

    @classmethod
    def trigger(cls, instance) -> None:
        cls.get()(instance)

    @classmethod
    def override(cls, trigger) -> None:
        cls._trigger = trigger

    @classmethod
    def reset(cls) -> None:
        cls._trigger = None

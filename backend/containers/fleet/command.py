"""containers.fleet.command —— 写侧编排（FleetCommand，parent #277 / Ticket ③）。

#280 预重构（parent #277）：从 ``fleet/orchestrator.py`` 剥离**写侧**（create / delete /
rewrite_config / exec_in_container / exec_sync + 私有 _reserve_row / _used_ports）为独立深
协作者，并把 config 写盘收敛为 ``ConfigStore`` 原子写单源（本子包 ``config_store.py``）。
lazy ``ConfigRenderer`` 归本协作者——create/rewrite_config 是它唯一消费者。

- ``create``：进程内 inflight guard 覆盖完整 create → 事务占位（挡重名/仲裁 port）→
  mkdir + cp -a + 渲染 + 原子写 config + run；失败只回滚本次实际创建的资源。
  从裸 ``write_text``+chmod 升级为经 ``ConfigStore.write`` 原子落盘（消掉 torn/partial 风险）。
- ``delete``：容器 + 连数据删；home 清理失败不吞（保留 DB 行 + 标 REMOVING + raise）。
- ``rewrite_config``：DB（ModelProvider）为单一来源 → ProviderConfigBuilder 合并 → 经
  ConfigStore.write 原子覆盖写（既有原子逻辑原样迁入单源）。
- ``exec_in_container`` / ``exec_sync``：命令语义（让容器做事），与 create/delete 同族。

#297 异步化（parent #294）：create 拆「同步预占」与「后台完成」两阶段，解决生产容器化后端
经 nginx 代理长请求被 60s 掐断 → 504 的故障（issue #294）。``create_reserve`` 同步预占
creating 行（错误语义不变：LLM key 缺失/端口池耗尽→503，重名/残留目录→409），``create_complete``
在注入的 executor（``submit_task``）后台完成模板拷贝 + docker run；``create()`` 保留同步语义
封装（reserve + complete），既有调用方与 orchestrator 单测零破坏。

- ``submit_task`` 注入对齐 ``dir_remover``/``port_in_use`` 风格；生产默认
  ``ThreadPoolExecutor(max_workers=2).submit``，测试注入 inline 同步 callable。
- 后台线程安全：入口 ``close_old_connections()`` 防线程 DB 连接泄漏；保留 lease 续约（防长
  docker pull 窗口被 ``_reconcile_creating`` 误收敛）；inflight 时序保留（同步 claim / 后台
  finally release）。后台异常记日志 + 行标 ERROR，客户端经 list + delete 感知/重试。

依赖方向：``command`` → ``config_store`` → ``values``；``command`` → ``deps`` → ``values``。
组合注入（FleetDeps + ConfigStore），无继承；实例属性：_deps / _config_store / _renderer /
_submit_task（4 项）。
"""
import json
import logging
import os
import secrets
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from django.db import IntegrityError, close_old_connections, transaction
from django.utils import timezone

from containers.config_renderer import ConfigRenderer
from containers.constants import HOME_BIND, LEASE_TTL, MAX_PORT_RETRIES, TOKEN_URLSAFE_BYTES
from containers.fleet.config_store import ConfigStore
from containers.fleet.deps import FleetDeps
from containers.fleet.values import (
    ConfigurationError,
    InstanceBusy,
    InstanceCleanupError,
    InstanceDirExists,
    InstanceExists,
    InstanceNotFound,
    PortAllocationError,
)
from containers.models import Instance
from containers.runtime import ContainerSpec

logger = logging.getLogger(__name__)


class FleetCommand:
    """容器实例生命周期写侧（create/delete/rewrite_config/exec_*）——组合 FleetDeps + ConfigStore。"""

    def __init__(self, deps: FleetDeps, config_store: ConfigStore, submit_task=None) -> None:
        self._deps = deps
        self._config_store = config_store
        # #297：create 异步化 executor 注入——默认 ThreadPoolExecutor(2).submit（后台 provisioning
        # 并发上限 2），测试注入 inline 同步 callable。对齐 dir_remover/port_in_use 注入风格。
        self._submit_task = submit_task or ThreadPoolExecutor(max_workers=2).submit
        # lazy ConfigRenderer（仅 create/rewrite_config 使用）：推迟到首次 write 前构造——
        # 模板 JSON 仅供写配置使用，list/delete 不应因其损坏而 500（codex R6 :475 / R7 :509）。
        self._renderer = None

    def _ensure_renderer(self) -> ConfigRenderer:
        if self._renderer is None:
            template_text = Path(self._deps.config.template_json).read_text(encoding="utf-8")
            self._renderer = ConfigRenderer(template_text)
        return self._renderer

    def _used_ports(self, extra_used: set[int] | None = None) -> set[int]:
        """已用端口 = DB 记账 ∪ daemon 宿主发布端口（含未跟踪容器）∪ 池内宿主实测占用。

        仅记账会让最低候选被无关进程/未跟踪容器占用而反复失败；并入 daemon 侧端口与
        宿主 bind 实测后，allocator 跳过真实不可用端口。#295 codex P2：host_published_ports
        经 daemon 命名空间枚举（后端容器化时容器内 socket.bind 探不到宿主端口），
        list_fleet 按 label 过滤看不到未跟踪容器。宿主探测只扫池区间，且对池外/异常
        端口容错（占用即跳过该候选，不影响其余）。
        extra_used：create 重试循环内学习到的 bind 冲突端口（探测不可见，经 daemon 发布失败
        反推），并入门沿用。
        """
        used = set(Instance.objects.values_list('port', flat=True))
        if extra_used:
            used |= extra_used
        try:
            for info in self._deps.runtime.list_fleet():
                port = getattr(info, 'port', None)
                if isinstance(port, int):
                    used.add(port)
        except Exception:  # pylint: disable=broad-exception-caught
            # daemon 不可达不阻断分配：DB 记账 + 宿主实测仍可给出候选
            pass
        try:
            used |= self._deps.runtime.host_published_ports()
        except Exception:  # pylint: disable=broad-exception-caught
            pass
        for port in range(self._deps.config.port_start, self._deps.config.port_end + 1):
            if port not in used and self._deps.port_in_use(port):
                used.add(port)
        return used

    def _reserve_row(self, name: str, extra_used: set[int] | None = None) -> Instance:
        """事务内占位 INSERT：name/port 冲突由 DB 唯一约束仲裁（codex R1 :77/:84）。

        port 冲突（并发选同 port）→ 保存点回滚后重试下一个空闲 port；
        name 冲突（并发同名）→ InstanceExists（view 409，不重试）。
        预占在 mkdir 之前：DB 唯一约束先挡重名，避免误删既有实例目录。
        extra_used：create 重试循环内学习到的 bind 冲突端口（透传给 _used_ports）。
        """
        home = str(self._deps.config.root / 'instances' / name / 'home')
        token = secrets.token_urlsafe(TOKEN_URLSAFE_BYTES)
        for _ in range(MAX_PORT_RETRIES):
            port = self._deps.allocator.next_free(self._used_ports(extra_used))
            try:
                with transaction.atomic():
                    return Instance.objects.create(
                        name=name,
                        port=port,
                        token=token,
                        home_dir=home,
                        container_id='',
                        status=Instance.STATUS_CREATING,
                        image=self._deps.config.image,
                        # codex R8 F1：lease 起点随预占行落盘——其它 worker 的 _reconcile_creating
                        # 据此在 provisioning 期间不误收敛本行（created_at+60s 无法覆盖长 create）。
                        lease_expires_at=timezone.now() + LEASE_TTL,
                    )
            except IntegrityError:
                if Instance.objects.filter(name=name).exists():
                    raise InstanceExists(name) from None
                # 否则 port 冲突 → 保存点已回滚，继续重试下一 port
        raise PortAllocationError(name)

    @staticmethod
    def _is_bind_conflict(exc: Exception) -> bool:
        """识别 docker 发布端口时的宿主 bind 冲突异常。

        #295 codex P2：宿主非 Docker 进程占池端口时，容器内 socket.bind 与 daemon 容器
        枚举都看不到占用（命名空间盲区 / 无 PortBindings），allocator 仍选中该端口；
        docker run 发布时 daemon（宿主命名空间）最终仲裁 → bind 冲突。此异常须触发重试
        下一空闲端口，而非整段回滚。docker-py 抛 docker.errors.APIError，措辞依来源分两种：
        - OS 层 bind 失败（docker-proxy）："bind: address already in use"；
        - libnetwork portallocator（端口已被其它容器/本 daemon 记账占用）：
          "Bind for 0.0.0.0:19000 failed: port is already allocated"（含 "is"）。
        归一化匹配——"already allocated" 覆盖两者与 codex 的简写（#295 codex P2 新轮：
        只精确匹配前一种会让 portallocator 冲突走非 bind 回滚、create 失败而非学习冲突
        端口重试）。fake/tests 用 RuntimeError 近似。
        """
        message = str(exc)
        return 'address already in use' in message or 'already allocated' in message

    def create_reserve(self, name: str) -> Instance:  # pylint: disable=too-many-statements
        """create 阶段一（同步预占）——只做可在请求线程安全完成的确定性工作（#297）。

        错误语义与同步 create 完全一致（view 层 409/503 映射不变）：
        - LLM_API_KEY 缺失 → ConfigurationError（503）：否则创建外表 healthy 但永远无法调 LLM
          的容器，且 LLM_API_KEY 是面板级共享的不能通过 delete 修复（codex R6 :484）。
        - 进程内 inflight guard 先占名（并发同名 → InstanceExists → 409）。
        - ``_reserve_row`` 事务占位 creating 行（DB 唯一约束仲裁 name/port；name 冲突 →
          InstanceExists→409；port 冲突保存点内重试 → 耗尽 PortAllocationError→503）。
        - 残留目录预检（DB 无行的 orphan 目录）→ InstanceDirExists（409）：同步暴露而非留到
          后台 mkdir 才失败——否则客户端拿到 202 最终落成 ERROR 行，无「先清理」提示。
        - renderer 惰性构造（读模板 JSON）在预占阶段完成并缓存：模板文件缺失/损坏是确定性
          配置错误，同步暴露为失败（回滚行/释放 guard），后台线程直接复用缓存不重复读盘。

        不含 mkdir/cp -a/docker run 等耗时 IO——这些在 ``create_complete`` 后台执行。

        返回 creating 行；调用方（view 或 create() 封装）随后要么 ``create_complete`` 完成、
        要么 ``submit_create`` 提交后台完成。
        """
        if not self._deps.config.llm_api_key:
            raise ConfigurationError('LLM_API_KEY')
        if not self._deps.inflight.claim(name):
            raise InstanceExists(name)
        try:
            inst = self._reserve_row(name)
            try:
                # 残留目录预检 + renderer 惰性构造：任一失败回滚刚建的 creating 行再上抛，
                # 让调用方同步感知（view 409/503），不留下无主 creating 行。
                instance_dir = self._deps.config.root / 'instances' / name
                if instance_dir.exists():
                    raise InstanceDirExists(name, str(instance_dir))
                self._ensure_renderer()
            except Exception:
                if inst.pk is not None:
                    inst.delete()
                raise
            return inst
        except Exception:
            self._deps.inflight.release(name)
            raise

    def create_complete(  # pylint: disable=too-many-statements,too-many-branches
        self, inst: Instance, preserve_error_row: bool = False,
    ) -> Instance:
        """create 阶段二（后台/同步完成）——模板拷贝 + 渲染 + 原子写 config + docker run（#297）。

        与同步 create 的既有逻辑一致（状态机 creating→running + 统一回滚），并吸收 #295 codex
        P2 的 bind 冲突重试：docker run 因宿主端口被占用失败时，就地更新行端口重试下一空闲
        端口（learned_conflicts 学习集并入 _used_ports），而非整段回滚。独立为方法使它在注入
        executor（``submit_create``）的线程里跑，或经 ``create()`` 同步封装在请求线程跑。

        lease 续约保留（codex R8 F1）：render 完成后、run 前 checkpoint 续约，把 lease 起点
        推到此刻覆盖随后的 docker run——后台长 create（>600s image pull）不被 ``_reconcile_creating``
        误收敛后 resurrect。finally 释放 inflight（同步 add / 后台 discard 时序不变）。

        preserve_error_row（codex P1 / #297 后台）：同步 create() 传 False 保持历史契约
        （失败删行回滚、调用方感知异常）；后台 _run_create_complete 传 True——POST 已返 202，
        行对客户端可见，失败须保留 ERROR 行（客户端经 list + delete 感知/重试），不得让已
        接受的实例静默消失。
        """
        # 从行身份恢复本次 provisioning 资源路径（name 源自行，防后台线程用错参数）。
        name = inst.name
        instance_dir = self._deps.config.root / 'instances' / name
        home = instance_dir / 'home'
        config_path = instance_dir / 'openclaw.json'
        # #295 codex P2：bind 冲突重试预算 = 端口池候选数（MAX_PORT_RETRIES 是 DB 并发冲突
        # 预算）。宿主非容器监听占 8+ 最低端口时，池内更高端口仍空闲，须继续尝试直至 allocator
        # 池耗尽（_reserve_row 抛 PortAllocationError）。
        pool_size = self._deps.config.port_end - self._deps.config.port_start + 1
        # bind 冲突学习集——探测不可见的宿主占用端口（经 docker 发布失败反推），重试循环内并入
        # 已用集，避免每次 re-reserve 都重选同一冲突端口。
        learned_conflicts: set[int] = set()
        directory_created = False
        run_attempted = False
        preexisting = False
        try:
            for _ in range(pool_size):
                # 首轮复用 reserve 已预占的行；bind 冲突重试时行端口已就地更新（_reserve_row
                # 经 extra_used 跳过冲突端口），不删行重建——行对客户端可见（202 已返回）。
                # preflight 也在统一回滚范围内；daemon 异常不得遗留 creating 行。
                try:
                    preexisting = self._deps.runtime.get(name) is not None
                    if not directory_created:
                        try:
                            instance_dir.mkdir(parents=True, exist_ok=False)
                        except FileExistsError:
                            # 目录已存在但 _reserve_row 成功（DB 无行）= 上次崩溃中断/外部残留/
                            # 手动删 DB 遗留的 orphan 目录。回滚刚建的 CREATING 行（保持「DB 无行」
                            # 与残留目录一致，便于客户端经 DELETE 或手动清理后重试），转
                            # InstanceDirExists（view 409），不冒泡裸 500。
                            if inst is not None and inst.pk is not None:
                                inst.delete()
                            raise InstanceDirExists(name, str(instance_dir)) from None
                        directory_created = True
                    self._deps.provisioner.provision(home)
                    # #280：config 写盘从裸 write_text + chmod 升级为 ConfigStore 原子写单源
                    # （tmp + chmod 0644 + os.replace）——create 不再有 torn/partial 风险。
                    self._config_store.write(name, self._ensure_renderer().render())
                    # codex R8 F1：renewable lease——render 完成后、run 前续约，把 lease 起点推到
                    # 此刻覆盖随后的 docker run（create+start）。run 内 image pull 仍受 LEASE_TTL
                    # 约束（阻塞 IO 内部不续约，靠 TTL 充分性 + _reconcile self-heal 兜底）。
                    inst.lease_expires_at = timezone.now() + LEASE_TTL
                    inst.save(update_fields=['lease_expires_at'])
                    run_attempted = True
                    container_id = self._deps.runtime.run(
                        ContainerSpec(
                            name=name,
                            image=self._deps.config.image,
                            host_port=inst.port,
                            gateway_token=inst.token,
                            home_dir=str(home),
                            config_path=str(config_path),
                            llm_api_key=self._deps.config.llm_api_key,
                        ),
                    )
                    inst.container_id = container_id
                    inst.status = Instance.STATUS_RUNNING
                    inst.save()
                    return inst
                except Exception as exc:  # pylint: disable=broad-exception-caught
                    # #295 codex P2：docker run bind 冲突 → 就地更新行端口、继续循环重试下一端口。
                    # 该端口已被 daemon 判占用（宿主命名空间唯一仲裁源），并入学习集使下一轮
                    # _reserve_row 跳过它（host_published_ports / HostPortProbe 探测不可见）。
                    if self._is_bind_conflict(exc):
                        if inst is not None and inst.port is not None:
                            learned_conflicts.add(inst.port)
                        # bind 冲突后容器/目录清理失败不能吞（#295 第 4 轮）：残留容器/目录让下一轮
                        # 重试撞 name/InstanceDirExists，且行删则 delete 无所有权记录无法清理孤儿。
                        if run_attempted and not preexisting:
                            try:
                                created = self._deps.runtime.get(name)
                                if created is not None and created.container_id:
                                    inst.container_id = created.container_id
                                self._deps.runtime.remove(name)
                                inst.container_id = ''
                            except Exception:  # pylint: disable=broad-exception-caught
                                inst.status = Instance.STATUS_ERROR
                                try:
                                    inst.save(update_fields=['status', 'container_id'])
                                except Exception:  # pylint: disable=broad-exception-caught
                                    pass
                                raise InstanceCleanupError(name, str(instance_dir)) from None
                        if directory_created:
                            try:
                                self._deps.dir_remover(instance_dir)
                            except OSError:
                                inst.status = Instance.STATUS_ERROR
                                try:
                                    inst.save(update_fields=['status', 'container_id'])
                                except Exception:  # pylint: disable=broad-exception-caught
                                    pass
                                raise InstanceCleanupError(name, str(instance_dir)) from None
                        # 就地重试：释放端口 → 学习冲突集 → 下一轮 _reserve_row 选新端口。
                        # 行不删（对客户端可见），run 失败前未执行的步骤下一轮重做。
                        if inst is not None and inst.pk is not None:
                            next_port = self._deps.allocator.next_free(
                                self._used_ports(learned_conflicts),
                            )
                            inst.port = next_port
                            inst.save(update_fields=['port'])
                        continue
                    # 非 bind 冲突 → 统一回滚（保留历史语义）
                    if run_attempted and not preexisting:
                        try:
                            created = self._deps.runtime.get(name)
                            if created is not None and created.container_id:
                                inst.container_id = created.container_id
                            self._deps.runtime.remove(name)
                            inst.container_id = ''
                        except Exception:  # pylint: disable=broad-exception-caught
                            # 若清容器失败，保留刚观测到的 id，供 ERROR 行后续 delete 证明所有权。
                            pass
                    # mkdir 成功是目录所有权的正向证据；mkdir 自身失败时保留既有数据。
                    if directory_created:
                        try:
                            self._deps.dir_remover(instance_dir)
                        except OSError:
                            inst.status = Instance.STATUS_ERROR
                            try:
                                inst.save(update_fields=['status', 'container_id'])
                            except Exception:  # pylint: disable=broad-exception-caught
                                pass
                            raise InstanceCleanupError(name, str(instance_dir)) from None
                    if preserve_error_row:
                        # codex P1（#297 后台）：POST 已返 202，行对客户端可见——失败保留 ERROR 行
                        # 供 list 显示 error + delete 清理，而非让已接受的实例静默消失。
                        inst.status = Instance.STATUS_ERROR
                        try:
                            inst.save(update_fields=['status', 'container_id'])
                        except Exception:  # pylint: disable=broad-exception-caught
                            pass
                    else:
                        # 同步 create()：历史契约——失败删行回滚，调用方（view）感知异常。
                        if inst is not None and inst.pk is not None:
                            inst.delete()
                    raise
            # 理论上不可达：池候选数次循环内每次 return 或 raise（池耗尽抛 PortAllocationError）。
            raise PortAllocationError(name)
        finally:
            # guard 释放必须无条件执行：无论成功/回滚/重试耗尽，create 收尾都要释放在飞标记。
            self._deps.inflight.release(name)

    def _run_create_complete(self, inst: Instance) -> None:
        """后台线程入口（#297）：清理 DB 连接 + 完成 provisioning + 兜底记录异常。

        线程在请求进程的 executor 池里跑；Django 的 DB 连接默认绑定创建它的线程，
        新线程首用即建连接，退出时若不复用将泄漏——入口 ``close_old_connections`` 把
        可能残留的连接交还连接池。``except Exception`` 只记日志不崩线程（executor 吞异常
        会让 create 失败无痕；行已标 ERROR，客户端经 list + delete 感知/重试）。

        codex P1：后台路径 ``preserve_error_row=True``——POST 已返 202、行对客户端可见，
        失败须保留 ERROR 行（list 显示 error + delete 清理），而非删行让已接受的实例静默消失。
        """
        close_old_connections()
        try:
            self.create_complete(inst, preserve_error_row=True)
        except Exception:  # pylint: disable=broad-exception-caught
            # 后台失败的行已由 create_complete 保留/标 ERROR；此处仅记日志，不向请求线程
            # 传播（请求早已返回 202）。logger 记 name 便于运维对账。
            logger.exception('background create failed for %s', inst.name)

    def submit_create(self, inst: Instance) -> None:
        """create 阶段三：经注入的 executor 提交后台完成（#297）。"""
        self._submit_task(self._run_create_complete, inst)

    def create(self, name: str) -> Instance:
        """创建并启动一个容器（spec §5.4/§5.5）——同步封装，reserve + complete（#297）。

        供需要同步语义的调用方/测试使用（view 层改走 reserve + submit_create 返回 202）。
        失败回滚与 inflight 释放由 ``create_complete`` 统一负责，此处只需顺序串联两阶段。
        """
        inst = self.create_reserve(name)
        return self.create_complete(inst)

    def delete(self, name: str) -> bool:
        """删除容器 + 连数据删（spec §5.4）。

        实例不存在返回 False；容器不存在幂等清理。
        codex R1 :126：home 清理失败（root 容器改属主/权限）不吞——保留 DB 行 +
        标 REMOVING + raise InstanceCleanupError，客户端可重试（容器已删，重试只清目录 + 删行）。
        codex R3 :257：目标仍在 provisioning（create 在飞）→ raise InstanceBusy（view 409），
        防 delete 与在飞 create 竞争（create 收尾 save(running) 会 resurrect 已删行/容器数据已清）。
        """
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            return False
        # codex R9-1 (P1)：记录 claim 时的行身份。后续 rmtree 前重新查行——若行已被另一 delete
        # 删除（None）或被 recreate 替换（pk 不同），则跳过 rmtree（资源已不属于本行）。
        # pk 区分新旧行：recreate 必须等旧行 delete 后、name UNIQUE 阻止重复 INSERT。
        claimed_pk = inst.pk
        # codex R6 :304：基于 DB status 判断 provisioning——跨进程安全。
        # CREATING 行（无论本进程在飞与否）表明有 create 正在或曾经 provisioning；
        # delete 须拒删 CREATING 行以保护仍在飞的 create，崩溃中断的 CREATING 行
        # 经 _reconcile_creating 收敛后再删。仅进程内 inflight guard 在多 worker
        # 下不可见。
        if inst.status == Instance.STATUS_CREATING:
            raise InstanceBusy(name)
        # codex R3 :257：本进程在飞 create 的额外保险——status 尚未落盘 CREATING
        # 的极窄窗口（_reserve_row 前）仍由进程内标记挡。
        if name in self._deps.inflight:
            raise InstanceBusy(name)
        # container_id 是本行拥有 runtime 容器的正向证据。ERROR + 空 id 可能只是目录清理行，
        # 同名容器可能早于本次 create，不能无条件 stop/remove。
        # codex R6 :311：DB 记录的 container_id 可能与存活容器 ID 不匹配（外部删除后重建同名容器），
        # 先验证再 stop/remove，否则会误删非本 orch 拥有的健康容器。
        if inst.container_id:
            live = self._deps.runtime.get(name)
            if live is None or live.container_id != inst.container_id:
                inst.container_id = ''
                try:
                    inst.save(update_fields=['container_id'])
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
            else:
                # A3：容器以 root 跑，bind-mount home 内由容器写入的文件（session/cache 等）
                # 属主为 root，host 非 root rmtree 会 PermissionError。容器还在（root 权限）时
                # 同步 chown home 给 host uid，让 host rmtree 能清。best-effort——chown 失败不阻断。
                try:
                    self._deps.runtime.exec_sync(
                        name, ['chown', '-R', str(os.getuid()), HOME_BIND],
                    )
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
                self._deps.runtime.stop(name)
                self._deps.runtime.remove(name)
        # codex R4 :296：删除路径优先由 DB 记录的 home_dir 派生（创建时固化的绝对路径，
        # home_dir=<instance_dir>/home，取 parent 即 instance_dir）——OPENCLAW_FLEET_ROOT 变更后
        # 仍能删到旧 root 下的真实数据，而非用当前 cfg.root 重构（新 root 无该目录会被
        # FileNotFoundError 误判为成功，旧数据残留）。
        # 防御：home_dir 占位/被篡改（parent 不在任何 instances 根下，如 '/h'）时回退
        # cfg.root/instances/name，避免对危险路径 rmtree。
        recorded = Path(inst.home_dir).parent
        if recorded.name != name or recorded.parent.name != 'instances':
            instance_dir = self._deps.config.root / 'instances' / name
        else:
            instance_dir = recorded
        # codex R9-1 (P1)：rmtree 前重新查行身份——若行已被另一 delete 删除（None）或
        # 被 recreate 替换为新一代（pk ≠ claimed_pk），则跳过 rmtree。此时目录归新 owner，
        # 容器已由 container_id 比对守卫保护（不匹配→skip stop/remove）。
        current = Instance.objects.filter(name=name).first()
        if current is None or current.pk != claimed_pk:
            # 行已属于另一 lifecycle 代——跳过目录清理，仅删旧实例（inst 仍指向旧 pk）
            inst.delete()
            return True
        try:
            self._deps.dir_remover(instance_dir)
        except FileNotFoundError:
            # codex R2 :204：目录已不存在（外部清理/建行前崩溃）视为清理成功——
            # 否则 FileNotFoundError 落入 OSError 分支，行卡 REMOVING 且重试永远撞同一路径。
            pass
        except OSError as exc:
            inst.status = Instance.STATUS_REMOVING
            inst.save()
            raise InstanceCleanupError(name, str(instance_dir)) from exc
        inst.delete()
        return True

    def rewrite_config(self, name: str) -> None:
        """重渲染该容器 openclaw.json（spec §7：model CRUD 后经 OpenClaw watch 热加载生效）。

        DB（ModelProvider）为单一来源：读该实例全部 provider → ProviderConfigBuilder 合并进
        模板 base（强制 gateway 安全不变量）→ 经 ConfigStore 原子覆盖写
        instances/<name>/openclaw.json。
        #36 已证：改 models.providers 即热加载，无需 restart；SecretRef env 缺失时 reload 失败
        但 runtime 停留 last-known-good 不崩，env 补齐自动恢复。
        原子写（tmp + os.replace，单源 ConfigStore）：写盘失败不污染既有 openclaw.json，
        DB 事务据此回滚（view 层）。
        """
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise InstanceNotFound(name)
        renderer = self._ensure_renderer()
        specs = [p.as_spec() for p in inst.model_providers.all()]
        merged = self._deps.provider_builder.build(renderer.render_dict(), specs)
        self._config_store.write(name, json.dumps(merged, indent=2, ensure_ascii=False))

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        """在运行中的实例容器内执行命令（如 wiki compile）—— 委托 runtime（codex PR #62 意见1）。

        供 wiki compile 触发器等跨域调用；保持 runtime 为唯一 docker 接触面。
        """
        self._deps.runtime.exec_in_container(name, cmd)

    def exec_sync(self, name: str, cmd: list[str]) -> None:
        """在容器内同步执行命令并等待完成 —— 委托 runtime。

        区别于 exec_in_container 的 fire-and-forget（detach=True）：供需等命令落库的调用，
        如设备配对 approve（``openclaw devices approve <reqId>``）——approve 须在重握手前真正写入
        gateway 设备表，否则重握手仍 PAIRING_REQUIRED。runtime 为唯一 docker 接触面（同上）。
        """
        self._deps.runtime.exec_sync(name, cmd)

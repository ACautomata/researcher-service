"""OpenClaw 防腐层 4 Port 接口（Hexagonal / spec #97 / ADR 0002 / issue #98）。

四条接触路径各一个 Port（Protocol 形态），业务层依赖 Port、测试注入 fake/Adapter：
- ContainerRuntime（路径1，Docker SDK 编排）—— 复刻 containers.ports 既有 Protocol，归属前移到集成包
  （strangler：#101 才让 DockerRuntime implements + containers.Fleet 委托，本票仅接口骨架）。
- OpenClawWire（路径4，WS 协议 v4）—— **配对后长连接**（ADR 0004 修订 0002：移除 pair()，
  收窄为 chat.send + 事件流按 runId 路由 + 连接级审批 fan-out + 只读/会话 RPC；配对由
  PairingHandshake / PairingService 独立 seam 拥有）。实现单一（integration.openclaw.wire_client
  .OpenClawWireClient），最小契约 + 向下闭合同构（Port 只声明 pool/consumers/views 依赖的方法）。
- WikiFileSystem（路径2，宿主 bind-mount 读写）—— wiki/main 文件树 + 五分类 + 越权防护
  （#100 WikiService 构造注入；本票仅接口骨架）。
- HealthProbe（路径3，HTTP /health 探测）—— 构造注入 http client（#99 真实 Adapter；本票仅接口骨架）。

本票仅定义接口骨架；方法签名据现有业务推导，后续每路径「填实现」时按需细化。
"""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from containers.runtime import ContainerInfo, ContainerSpec


@runtime_checkable
class ContainerRuntime(Protocol):
    """路径1：容器运行时（Docker SDK 编排）。复刻 containers.ports.ContainerRuntime，归属前移。"""

    def run(self, spec: ContainerSpec) -> str:
        """创建并启动容器，返回 container_id。"""
        ...

    def list_fleet(self) -> list[ContainerInfo]:
        """列出所有 fleet 容器（label app=openclaw-fleet）。"""
        ...

    def get(self, name: str) -> ContainerInfo | None:
        """取单个实例的容器状态；不存在返回 None。"""
        ...

    def stop(self, name: str) -> None:
        """停止容器（优雅超时后 SIGKILL）。"""
        ...

    def remove(self, name: str) -> None:
        """删除容器（连匿名卷，force）；容器不存在则幂等。"""
        ...

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        """在运行中的实例容器内执行命令（如 wiki compile）；容器不存在则幂等。"""
        ...

    def exec_sync(self, name: str, cmd: list[str]) -> None:
        """同步在容器内执行命令并等待完成（区别于 exec_in_container 的 detach fire-and-forget）。

        供 delete cleanup（chown bind-mount home 给 host uid）：容器以 root 跑，home 内由容器
        写入的文件属主为 root，须容器还在时同步 chown 后再 rmtree——否则 host 非 root 清不掉（A3）。
        """
        ...


@runtime_checkable
class OpenClawWire(Protocol):
    """路径4：**配对后长连接**（ADR 0004 修订 0002 的配对合并——移除 pair()，收窄契约）。

    本 Port 只覆盖「已配对 deviceToken → 长连接事件流」：chat.send → ack(runId) → 事件按 runId
    路由 + 连接级审批 fan-out + 只读（commands/history/sessions list）/会话管理（create/delete）RPC。
    **配对握手不在本 Port**——challenge→connect→approve→持久化 deviceToken 的有状态多步流程由
    PairingHandshake / PairingService（独立 seam）拥有；pool 拿到 deviceToken 后构造本 Port 的
    实现（构造期注入 url/device_token/identity/scopes），再发起无参 ``connect()``。

    **最小契约 + 向下闭合同构**：只声明 pool / consumers / views 实际依赖的方法。实现
    （integration.openclaw.wire_client.OpenClawWireClient）可更富——``request_approval``（仅集成
    测试用）、``policy``（仅测试读）等留在实现内部、不进 Port；isomorph 守卫只强制「Port 每个
    方法在 Port/Fake/Impl 三处签名同构」，允许 Impl 比 Port 富（ADR 0004 / #227 downward-closure）。
    nonce 不出现在接口——connect() 内部等 connect.challenge 提取（#140，藏于 seam 之后）。
    """

    @property
    def dead(self) -> bool:
        """连接是否已不可用（recv loop 退出或被显式关闭）；pool 据此不复用、驱逐重建。"""
        ...

    # ── 生命周期 ────────────────────────────────────────────────

    async def connect(self) -> None:
        """建立已配对长连（构造期注入的身份材料；nonce 内部等 challenge 提取）。握手失败抛 ChatConnectError。"""
        ...

    async def aclose(self) -> None:
        """关闭长连、清理路由与审批注册（幂等；pool 驱逐/重建时调用）。"""
        ...

    # ── chat.send + 事件路由 ────────────────────────────────────

    async def send_message(
        self, session_key: str, message: str, *, on_event: Any, idempotency_key: str | None = None,
    ) -> str:
        """发 chat.send → ack(runId) → 事件流回调 on_event（**keyword-only**）；返回 runId。

        Falsification: 未 connect / dead 抛 ChatClientError；ack 超时/网关拒绝抛 ChatSendError
        （帧可能已发出时归 ChatSendTransmittedError 子类，consumer 据此不盲重试）。
        ``idempotency_key`` 可选：缺省每次生成新 key；consumer 自愈重试（codex #219 P2）
        对同一逻辑发送复用同 key，网关按幂等去重避免起两个 run。
        """
        ...

    def discard(self, run_id: str) -> None:
        """移除某 runId 路由（consumer 断开时清理，避免推已关闭连接）。"""
        ...

    # ── 连接级审批（T06 / spec §8.2）────────────────────────────

    def add_approval_subscriber(self, cb: Any) -> None:
        """注册连接级审批订阅者。"""
        ...

    def remove_approval_subscriber(self, cb: Any) -> None:
        """退订指定审批订阅者。"""
        ...

    def approval_subscribers(self) -> list:
        """返回当前全部审批订阅者的副本（codex #219 P2：共享 client 自愈迁移用）。

        consumer 自愈换 client 时须把所有订阅者（不止触发自愈的那个 consumer）迁到新
        client，否则被动 consumer 滞留死 client、错过新连接上的审批。Port/Fake/Impl 三处同构。
        """
        ...

    async def broadcast_approval_resolved(self, approval_id: str, decision: str) -> None:
        """把一次权威 resolve 结果 fan-out 到全部订阅者（codex R2 P2：共享 client 各 consumer 卡片一致收敛）。"""
        ...

    async def resolve_approval(self, approval_id: str, kind: str, decision: str) -> dict:
        """回覆一次权限审批（{kind}.approval.resolve RPC），返回网关 res payload。"""
        ...

    async def list_pending_approvals(self) -> list[dict]:
        """查询网关当前待审批列表（补拉断线期间积累），翻译成审批卡帧列表（best-effort 不抛）。"""
        ...

    # ── 只读 / 会话管理 RPC（T07 / spec §8.2 / #76）─────────────

    async def list_commands(self) -> dict:
        """拉取该 agent 工作区的斜杠命令清单（commands.list RPC），返回 payload。"""
        ...

    async def list_sessions(
        self, agent_id: str = 'main', *, include_derived_titles: bool = True, limit: int | None = None,
    ) -> dict:
        """列出该 agent 网关中真实存在的会话（sessions.list RPC），返回 payload（ADR-0003 校准参数）。"""
        ...

    async def get_history(
        self, session_key: str, *, limit: int | None = None, message_id: str | None = None,
    ) -> dict:
        """读取某会话完整聊天记录（chat.history RPC），返回 display-normalized payload。"""
        ...

    async def create_session(self, key: str, *, label: str | None = None) -> dict:
        """新建会话（sessions.create{key,label} RPC），返回 payload。"""
        ...

    async def delete_session(self, session_key: str) -> dict:
        """删除会话（sessions.delete{key} RPC，**admin 级提升权限操作**；wire 字段是 key 非 sessionKey）。"""
        ...


@runtime_checkable
class WikiFileSystem(Protocol):
    """路径2：wiki/main 文件树读写（bind-mount）。封装路径约定/五分类/越权防护。"""

    def build_tree(self) -> dict:
        """构建 wiki/main 文件树（跳过插件私有/占位目录）。"""
        ...

    def read_page(self, rel_path: str) -> dict:
        """读一页 {path,title,content}；越权路径上抛 InvalidPath。"""
        ...

    def list_category_pages(self) -> list:
        """递归扫全库 .md（跳过插件私有/占位目录文件），返回 [{path,title,content}]。

        供 categories 聚合（issue #84）：title 取 frontmatter/H1/文件名兜底，content 为
        原文全文（提取 `` `category:` `` 标记与摘要在 service 层做，不在本层）。
        """
        ...

    def write_page(self, rel_path: str, content: str) -> dict:
        """覆写已存在页；越权路径上抛 InvalidPath。"""
        ...

    def create_page(self, rel_path: str, content: str) -> dict:
        """新建页（父目录须存在）；已存在/越权上抛。"""
        ...

    def delete_page(self, rel_path: str) -> None:
        """删除页；越权路径上抛 InvalidPath。"""
        ...


@runtime_checkable
class HealthProbe(Protocol):
    """路径3：HTTP GET 127.0.0.1:<port>/health 探容器 gateway 可达性。构造注入 http client。"""

    def is_reachable(self, port: int) -> bool:
        """宿主映射端口对应的 gateway /health 是否可达（2xx）。"""
        ...

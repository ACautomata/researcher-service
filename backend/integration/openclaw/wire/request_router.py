"""请求-回执路由协作者（issue #271/#274，parent #217 / #214）。

``RequestRouter``：请求→回执（req→res）路由与超时清理单源（门面内部协作者，组合非继承）。
收口门面的待回执注册表——**发送 ack 表**（``chat.send``，携带 ``on_event`` 路由闭包 +
transmitted 判定，语义不同于审批 resolve 表）与**审批 resolve 表**（approval.resolve /
commands.list / exec.approval.list / 通用 RPC）——**保留双表不并表**（issue #274 明示：既有
测试断言两表各自为空；且发送 ack 携带路由闭包，语义与 resolve 表不同）。同时收口通用
``rpc``、session 与 commands RPC、``resolve_approval``、``send_message`` 的注册/有界等待/
transmitted 判定段、死窗口拒绝、payload-too-large 本地预检、ack 超时清理。

门面经构造注入本协作者（``ack_timeout``）；``ws`` / ``policy`` / ``dead`` 为**运行时**依赖
（每连接一 ws、policy 由 hello-ok 更新、dead 由门面维护），经方法参数传入——协作者不反向
引用门面（单向依赖 门面→协作者）。唯一 I/O（``ws.send``）在此；``ConnectionCore`` 拆出前
ws 仍由门面持有、本协作者按方法注入。
"""
from __future__ import annotations

import asyncio
import json
import uuid

from websockets.exceptions import ConnectionClosed

from chat.event_translate import ChatEventTranslator
from integration.openclaw.wire import (
    AGENT_ID as _AGENT_ID,
)
from integration.openclaw.wire import (
    ChatClientError,
    ChatPayloadTooLargeError,
    ChatSendError,
    ChatSendTransmittedError,
    GatewayPolicy,
)
from integration.openclaw.wire.values import AckOutcome, OnEvent


class RequestRouter:
    """请求→回执路由协作者（门面内部组合，单向依赖 门面→协作者，不引用门面）。

    双表注册表 + 有界等待 + transmitted 判定 + 死窗口拒绝 + payload 预检 + ack 结算
    （``resolve_ack`` 回返 ``AckOutcome`` 供门面装路由）——请求-回执职责单源。
    """

    def __init__(self, *, ack_timeout: float) -> None:
        self._ack_timeout = ack_timeout
        # 双表（issue #274：**保留双表不并表**）——发送 ack 表携带 on_event 路由闭包 +
        # transmitted 判定，语义不同于审批 resolve 表；既有测试断言两表各自为空。
        self._pending_acks: dict[str, tuple[asyncio.Future, OnEvent]] = {}
        self._pending_resolves: dict[str, asyncio.Future] = {}

    @property
    def pending_acks(self) -> dict[str, tuple[asyncio.Future, OnEvent]]:
        """发送 ack 注册表（门面经委托 property ``_pending_acks`` 直读，状态所有权在本协作者）。"""
        return self._pending_acks

    @property
    def pending_resolves(self) -> dict[str, asyncio.Future]:
        """审批 resolve 注册表（门面经委托 property ``_pending_resolves`` 直读）。"""
        return self._pending_resolves

    async def send_message(self, session_key: str, message: str, *, on_event: OnEvent,  # pylint: disable=too-many-arguments
                           idempotency_key: str | None, ws, policy: GatewayPolicy,
                           dead: bool, dead_before_send: bool) -> str:
        """发送 chat.send 并有界等 ack，返回 runId（issue #274：从门面收口，语义不变）。

        ``idempotency_key`` 可选：缺省每次调用生成新 key（普通发送）。调用方（consumer
        自愈重试，issue #214 / codex P1）对**同一逻辑发送**在初次与有界重试间复用同一
        key——若网关已收下原 chat.send 但 ack 在连接死亡前丢失，重试带同 key 让网关按
        幂等去重，避免起两个 run、工具被执行两次。

        运行时依赖参数：``ws``（当前连接 socket）、``policy``（hello-ok 解析的当前帧大小
        上限）、``dead``（门面 ``_dead or _closed``，死窗口入口守卫）、``dead_before_send``
        （门面在 send 前读取的 ``_dead`` 快照——发送前已死才断「确定未传输」，发送中才死
        归 transmitted 不盲重发）。
        """
        if ws is None or dead:
            # codex #219 九轮 P2-999：aclose 已置 _closed、_notify_all_error 正清空 _routes 期间，
            # _ws 尚未置 None——若只查 _ws，共享 client 的另一 consumer 可在此窗口进入 send_message，
            # 其 route 在 _notify_all_error 快照后安装、随后被 clear 却无终态 error → 浏览器永久
            # pending。_closed 一并视为不可发送，closing 期间拒绝新 send（抛错由 consumer 走既有
            # dead/evidence 重取换到健康 client）。
            # codex #219 十轮 P2-631：guard 再扩到 _dead（dead=_dead or _closed）——recv loop 置
            # _dead=True 后、_notify_all_error await 回调并关 _ws 前的窗口内，_ws 仍非 None、_closed
            # 仍 False；此时新 send 的帧或达网关，但 recv loop 已无法处理 ack/事件 → run 空跑、输出
            # 丢失。dead 视为已断连，consumer 据此走重取换到健康 client 再发。
            raise ChatClientError('client not connected')
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_acks[req_id] = (fut, on_event)
        frame = {
            'type': 'req', 'id': req_id, 'method': 'chat.send',
            'params': {
                'sessionKey': session_key,
                'message': message,
                'agentId': _AGENT_ID,
                'idempotencyKey': idempotency_key or uuid.uuid4().hex,
            },
        }
        # codex #219 十轮 P1-930：send **前**快照 dead——await 让渡期间 recv loop 可能置 dead。
        # 若待 catch 里才采样 self._dead，「send 刷帧中途 recv loop 置 dead」的竞态会读到 True，
        # 误判为「发送前已死、帧确定未发出」而保留原生 ConnectionClosed（consumer 据此安全重试）
        # ——但字节可能已部分到达网关（网关或已起 run），盲重试重复执行工具。发送前已死才可断
        # 「确定未传输」；发送尝试中抛出的 close 一律归 transmitted（不确定，consumer 不盲发）。
        # （#274：快照由门面读取传入——门面在委托前读 self._dead，本协作者不反向读门面状态。）
        frame_json = json.dumps(frame)
        # #196 T5 / #216：发送侧帧大小自律——按 hello-ok policy.maxPayload（缺省 25MB）预检。超限在
        # _ws.send 之前本地拒绝（不发出该帧、不触发网关协议断连），避免超长粘贴连累同连接其他在途
        # run、避免用户看到莫名「容器连接断开」。须先移除已注册的 pending ack：本地拒绝后既不发帧也
        # 无回执，不清会让该 future/dict 项悬挂泄漏（孤儿 entry，永不回执）。
        frame_bytes = frame_json.encode('utf-8')
        if len(frame_bytes) > policy.max_payload_bytes:
            self._pending_acks.pop(req_id, None)
            limit_mb = policy.max_payload_bytes / (1024 * 1024)
            raise ChatPayloadTooLargeError(f'消息超过网关帧大小上限 {limit_mb:g} MB，请分段发送')
        try:
            # codex #220 P1：send 必须传 str——bytes 会让 websockets 发二进制帧，而 OpenClaw 协议
            # （与其他 RPC 一致）走 JSON 文本帧，二进制帧会被网关拒绝/断连。
            await ws.send(frame_json)
        except ConnectionClosed as exc:
            self._pending_acks.pop(req_id, None)
            if dead_before_send:
                # send 前已知连接死（#213 看门狗/CancelledError 已置位）：帧确定未发出，
                # 保留原生 ConnectionClosed——consumer 据此作 decisive evidence 安全重试。
                raise
            # codex #219 八轮 P1：竞态——recv task 尚未置 dead（或 send 中途才置，十轮 P1-930），
            # 但 send 刷帧中途 socket 关闭。帧字节可能已部分/全部到达网关（网关或已起 run），传输
            # 结果**未知**，归 transmitted 让 consumer 不盲重发（盲重试被幂等去重到死连接 runId）。
            raise ChatSendTransmittedError('chat.send socket closed mid-send') from exc
        try:
            # 有界等待 ack：网关连着但 ack 丢失/不回时不应让 consumer 永久挂起
            run_id = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_acks.pop(req_id, None)
            # codex #219 P1：帧已发出、ack 超时——网关可能已起 run；不可盲重试（丢事件流）
            raise ChatSendTransmittedError('chat.send ack timeout') from exc
        except ChatSendError:
            # 网关显式拒绝（ack ok:false，如 rate limit）或 ack 缺 runId——确定未起 run，
            # 原样上抛（非 transmitted），consumer 走既有重试/error 路径。
            self._pending_acks.pop(req_id, None)
            raise
        except BaseException as exc:
            self._pending_acks.pop(req_id, None)
            # codex #219 P1：帧已发出后 recv loop 死（fail_pending_acks 置 ChatClientError）
            # ——可能已起 run；包装为 ChatSendTransmittedError 让 consumer 判不可盲重试。
            if isinstance(exc, ChatClientError):
                raise ChatSendTransmittedError(str(exc)) from exc
            raise
        # codex #219 十二轮 P2-921：此处**不再**重装 route——resolve_ack 在 recv loop 里收到
        # ok ack 时已先装 route 再 set_result，wait_for 返回 run_id 必意味着 route 已就绪。
        # 若在此由发送协程恢复后重装，两 consumer 共享 client 时：ack 后、本协程恢复前另一
        # consumer 触发自愈 aclose，_notify_all_error 已 fail+clear 该 route，本行会在已关闭/
        # 已清空的 client 上重新装入 route → 浏览器收不到终态帧永久 pending。route 生命周期
        # 单源化：recv loop（resolve_ack）安装、aclose/_notify_all_error fail+clear、
        # discard/事件终态清除，发送协程不再触碰。
        return run_id

    async def rpc(self, method: str, params: dict, *, ws, dead: bool) -> dict:
        """通用 req→res 回执 RPC（issue #80 T1）：sessions.list / chat.history / sessions.create /
        sessions.delete 共用。复用 _pending_resolves 注册表，按 req id 经 resolve_ack 分发 res。

        未连接抛 ChatClientError（会话管理是 REST 主动调用，须报错让上层映射 502/409，区别于
        list_commands/list_pending_approvals 的 best-effort 静默返回）；网关拒绝（res not ok）/ ack
        超时抛 ChatSendError。原样透传网关 payload，不做字段翻译（集中在 REST 解析层 T2）。
        """
        if ws is None or dead:
            # codex #219 十一轮 P2-319：closing/recv 死期间拒发 RPC（同 resolve_approval/send_message
            # 死窗口）——future 注册后 ack 随死连接丢失会让调用方空等超时。dead 视为已断连拒发。
            raise ChatClientError('client not connected')
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {'type': 'req', 'id': req_id, 'method': method, 'params': params}
        try:
            await ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError(f'{method} ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    async def resolve_approval(self, approval_id: str, kind: str, decision: str,
                               *, ws, dead: bool) -> dict:
        """回覆一次权限审批（T06，spec §8.2）：发 {kind}.approval.resolve(id,decision)，有界等 res。

        issue #154 实测（ghcr 2026.6.34 / ADR 0003）：method 按族为 exec.approval.resolve /
        plugin.approval.resolve（非通用 approval.resolve，后者 unknown method）。
        params 为 {id, decision}（无 kind），decision 值 allow-once/allow-always/deny。

        返回网关 res 的 payload——approval.resolve 是 first-answer-wins，权威记录的 decision 可能
        与本请求的 decision 不同（另一 operator 已答）；调用方须用 payload 里的权威结果，不能回声
        本请求的 decision（codex P1）。需 operator.approvals scope；网关拒绝抛 ChatSendError。
        """
        if ws is None or dead:
            # codex #219 十一轮 P2-319：closing/recv 死期间拒发 approval RPC——同 send_message 的
            # 死窗口（_notify_all_error 快照后 await 回调、_ws 未置 None），新 resolve 的 future
            # 注册后网关或已接受审批，但 ack/resolved 事件随死连接丢失 → 超时把已执行的卡误复位
            # pending。dead（_dead or _closed）视为已断连拒发，consumer 走 dead 重取换健康 client。
            raise ChatClientError('client not connected')
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {
            'type': 'req', 'id': req_id, 'method': f'{kind}.approval.resolve',
            'params': {'id': approval_id, 'decision': decision},
        }
        try:
            # codex R3 P2：死连接（ws 非 None 但已断）下 send 会 raise；须与等 ack 共用清理路径，
            # 否则重试会在 _pending_resolves 无限累积 future（内存泄漏 + 永不回执）
            await ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('approval.resolve ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    async def list_pending_approvals(self, *, ws) -> list[dict]:
        """查询网关当前待审批列表（codex P2 断线恢复），翻译成审批卡帧列表。

        best-effort：绝不抛异常打断 consumer 的 ready 流程。复用 _approval_card 单项翻译（kind 从事件族
        派生，此处无事件名，按 payload.kind 或缺省 exec）。

        方法名（codex R3 P1 / issue 验收③）：r26 §1 文档已证 exec/plugin 族各有 `.list`（查全部待审批），
        通用 `approval` 族仅 `get`/`resolve`、**无 `approval.list`**。故本方法用文档已证的
        `exec.approval.list`（exec 是 elevated 命令审批主路径，本特性正针对它）。
        **刻意不做 exec+plugin 双查合并**（收窄 codex R3 P1）：①同一审批极可能被两族各返一次致重复出卡；
        ②`.list` 响应 schema 同样「待实测」，双查合并 + 按 id 去重是把待实测路径复杂化成另一套未经证实的
        死扣；③plugin 审批远少于 exec。若实测表明须双查或响应键非 `approvals`，按实测改此处与 fakes。
        """
        if ws is None:
            return []
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {'type': 'req', 'id': req_id, 'method': 'exec.approval.list', 'params': {}}
        try:
            await ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except BaseException:  # pylint: disable=broad-exception-caught
            self._pending_resolves.pop(req_id, None)
            return []
        # 实测校准（spike ghcr 2026.6.34-browser, 2026-07-27）：payload 可能直接是 list
        # （空 [] / 非空 [{...}]），也可能是 dict {approvals:[...]}。list 上调 .get 会崩，先判类型。
        if isinstance(payload, list):
            items = payload
        elif isinstance(payload, dict):
            items = payload.get('approvals')
            if items is None:
                single = payload.get('approval')
                items = [single] if isinstance(single, dict) else []
        else:
            items = []
        if not isinstance(items, list):
            return []
        cards = []
        for item in items:
            if not isinstance(item, dict):
                continue
            card = ChatEventTranslator._approval_card('exec.approval.requested', item)
            if card is not None:
                cards.append(card)
        return cards

    async def list_commands(self, *, ws) -> dict:
        """拉取该 agent 工作区的斜杠命令清单（T07，spec §8.2）：发 commands.list，有界等 res。

        与 resolve_approval 同构的「req→res 回执」RPC（复用 _pending_resolves，按 req id 分发）。
        请求参数按 r26 §2：agentId="main"、scope="both"（text+native 全量）、includeArgs=True
        （保留参数元数据供前端后续展示；**响应原样透传**，外层键名 `commands` 与 includeArgs
        元数据字段名「待实测」由 REST 层解析/校准，client 不做键名假设）。
        未连接 → 返回 {}（对齐 list_pending_approvals 的 best-effort）；网关拒绝（缺 operator.read）/
        ack 超时 → 抛 ChatSendError（上层 REST 映射 502）。
        """
        if ws is None:
            return {}
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {
            'type': 'req', 'id': req_id, 'method': 'commands.list',
            'params': {'agentId': _AGENT_ID, 'scope': 'both', 'includeArgs': True},
        }
        try:
            await ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('commands.list ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    def resolve_ack(self, msg: dict) -> AckOutcome | None:
        """回执（res 帧）→ 决定：结算 pending future，回返 ``AckOutcome`` 供门面装路由。

        三桶编排的**决定段**（issue #274）：本方法只读**本协作者**的双表——先结算审批 resolve
        表（approval.resolve / commands.list / exec.approval.list / 通用 RPC 的回执，settle 后
        返回 None），再结算发送 ack 表（``chat.send``）。发送 ack 命中时回返 ``AckOutcome``：
        - ``run_id`` 非空（ack ok 且带 runId）：门面据此装路由 + 回放恢复缓冲（跨桶执行段）；
        - ``error`` 非空（网关拒绝 / ack 缺 runId）：本方法已 set_exception，门面见 run_id 空即 no-op；
        - 返回 None：无匹配 entry / resolve 回执已结算 / fut 已 done——门面无动作。
        """
        rid = msg.get('id')
        # approval.resolve 的回执（T06）：与 chat.send ack 用同一 res 帧，按 id 分发
        resolve_fut = self._pending_resolves.pop(rid, None)
        if resolve_fut is not None:
            self._settle_resolve(resolve_fut, msg)
            return None
        entry = self._pending_acks.pop(rid, None)
        if entry is None:
            return None
        fut, on_event = entry
        if fut.done():
            return None
        outcome = self._ack_outcome(msg, on_event)
        if outcome.error is not None:
            fut.set_exception(ChatSendError(outcome.error))
        else:
            fut.set_result(outcome.run_id)
        return outcome

    def _ack_outcome(self, msg: dict, on_event: OnEvent) -> AckOutcome:
        """chat.send ack → AckOutcome（决定段，issue #271/#273 骨架在门面、#274 收口本协作者）。

        ``run_id`` 非空 = ack ok 且带 runId（路由已可注册，on_event 随值对象回返供门面装路由）；
        ``error`` 非空 = 网关拒绝 / ack 缺 runId（set_exception）；两者皆空 = 不应发生（防御性）。
        """
        if msg.get('ok'):
            run_id = (msg.get('payload') or {}).get('runId')
            if run_id:
                return AckOutcome(run_id=run_id, on_event=on_event)
            return AckOutcome(error='chat.send ack missing runId')
        err = msg.get('error') or {}
        return AckOutcome(error=err.get('message') or err.get('code') or 'chat.send failed')

    @staticmethod
    def _settle_resolve(resolve_fut: asyncio.Future, msg: dict) -> None:
        """结算审批 resolve 回执（approval.resolve / commands.list / exec.approval.list / 通用 RPC）。"""
        if resolve_fut.done():
            return
        if msg.get('ok'):
            resolve_fut.set_result(msg.get('payload'))
        else:
            err = msg.get('error') or {}
            resolve_fut.set_exception(
                ChatSendError(err.get('message') or err.get('code') or 'approval.resolve failed'))

    def fail_pending_acks(self, message: str) -> None:
        """连接断开/关闭：reject 所有未决 ack，避免 send_message 调用方永久挂起。"""
        for entry in list(self._pending_acks.values()):
            fut = entry[0]
            if not fut.done():
                fut.set_exception(ChatClientError(message))
        self._pending_acks.clear()

    def fail_pending_resolves(self, message: str) -> None:
        """连接断开/关闭：reject 所有未决 approval.resolve，避免 resolve_approval 调用方挂起。"""
        for fut in list(self._pending_resolves.values()):
            if not fut.done():
                fut.set_exception(ChatClientError(message))
        self._pending_resolves.clear()

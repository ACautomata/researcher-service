"""chat views —— 设备配对控制面（issue #40 / spec §8.1）。

HTTP 薄适配层：业务委托 PairingService（PairingFleet service locator，测试可注入 fake）。
路径参数 name 经 NAME_VALIDATOR（防 URL path 注入）。受全局 IsAuthenticated 保护。

领域异常转 HTTP 语义：
- 配对成功 → 200 {status:paired, scopes}
- PAIRING_REQUIRED → 202 {status:pending, pairing_request_id, detail:宿主 approve 提示}
- 其它握手错误 → 502 {status:error}（固定文案，原始异常仅记服务端日志，不外泄）
- instance 不存在 → 404；非法 name → 400
"""
import logging
import uuid

from asgiref.sync import async_to_sync
from django.core.exceptions import ValidationError
from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from chat.asgi_guard import on_synctoasync_thread
from chat.models import Pairing
from chat.pairing import PairingConcurrencyError, PairingFleet
from chat.pairing_ws import PairingError, PairingRequired
from chat.pool import ChatFleet, NotPaired
from chat.serializers import (
    ApprovalResolveSerializer,
    PairingStatusSerializer,
    SessionCreateSerializer,
)
from containers.models import NAME_VALIDATOR, Instance
from integration.openclaw.translation import (
    APPROVAL_FIELD_DECISION,
    APPROVAL_FIELD_ID,
    APPROVAL_FIELD_KIND,
    format_device_approve_command,
)

logger = logging.getLogger(__name__)


class _InvalidName(Exception):
    """路径参数 name 非法（内部信号，非 HTTP 响应）。"""


def _loop_premise_503(name: str, label: str) -> Response:
    """fail-fast：非 SyncToAsync 派生线程触达 REST→pool 路径（issue #201 问题 1）。

    承认「单 Daphne 进程单 loop」前提：只有 SyncToAsync 派生线程（Daphne 下 sync view
    工作线程）上的 async_to_sync 才把协程调度回 client 所在主 loop；其它线程会新建
    临时 loop，跨 loop set_result 会炸 client 的 recv loop。宁可 503 也不炸连接。
    """
    logger.error(
        '%s rejected for %s: 非 SyncToAsync 派生线程触达（仅支持 ASGI/Daphne 单进程单 worker）',
        label, name,
    )
    return Response(
        {'detail': '部署形态不支持：本服务仅支持 ASGI（Daphne）单进程单 worker'},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


class PairingView(APIView):
    """GET 查询配对状态 + POST 触发/重试配对（spec §8.1）。"""

    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError as exc:
            raise _InvalidName from exc
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        return inst

    @extend_schema(responses=PairingStatusSerializer)
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        pairing = PairingFleet.get().get_status(inst)
        return Response(PairingStatusSerializer(pairing).data)

    @extend_schema(
        request=None,
        responses={200: PairingStatusSerializer, 202: PairingStatusSerializer,
                   502: PairingStatusSerializer},
    )
    def post(self, request, name):  # pylint: disable=too-many-return-statements
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            pairing = PairingFleet.get().ensure_paired(inst, force_repair=True)
        except PairingRequired as e:
            # ensure_paired 已落库 pending 行；直接取（不重复 get_status 副作用）
            # 但 e.request_id 已被 _is_valid_request_id 校验过，可直接使用
            try:
                pairing = Pairing.objects.get(instance=inst)
            except Pairing.DoesNotExist:
                return Response(
                    {'detail': '容器或配对记录已被删除，请刷新列表'},
                    status=status.HTTP_404_NOT_FOUND,
                )
            data = PairingStatusSerializer(pairing).data
            data['detail'] = (
                f'设备待批准：请在宿主执行 `{format_device_approve_command(e.request_id)}` '
                f'后重试本接口'
            )
            return Response(data, status=status.HTTP_202_ACCEPTED)
        except PairingError as e:
            # 原始异常（网络/协议细节）仅记服务端日志，不外泄到响应（codex R security）
            logger.warning('pairing handshake failed for %s: %s', name, e)
            try:
                pairing = Pairing.objects.get(instance=inst)
            except Pairing.DoesNotExist:
                return Response(
                    {'detail': '容器或配对记录已被删除，请刷新列表'},
                    status=status.HTTP_404_NOT_FOUND,
                )
            data = PairingStatusSerializer(pairing).data
            data['detail'] = '配对握手失败，请检查容器网关状态后重试'
            return Response(data, status=status.HTTP_502_BAD_GATEWAY)
        except PairingConcurrencyError:
            # 握手期间容器/配对行被删除
            return Response(
                {'detail': '容器或配对记录已被删除，请刷新列表'},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(PairingStatusSerializer(pairing).data)


def _parse_sessions(payload: dict) -> list[dict]:
    """把网关 sessions.list payload 校准为 [{session_key, title, updated_at}]（ACL 单点校准）。

    逐字段名「待实测」（对齐 CommandListView._parse_commands）：会话键主取 item['key']、回退
    item['sessionKey']；标题取派生标题 item['derivedTitle']（替代旧手填 title）；时间取
    item['updatedAt']。非 dict 项 / 缺 key 项跳过（对网关输入 0 信任）。实测后改此处即可。
    """
    items = (payload or {}).get('sessions')
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        key = item.get('key') or item.get('sessionKey')
        if not isinstance(key, str) or not key:
            continue
        title = item.get('derivedTitle')
        updated = item.get('updatedAt')
        out.append({
            'session_key': key,
            'title': title if isinstance(title, str) else '',
            'updated_at': updated if isinstance(updated, str) else '',
        })
    return out


def _parse_history(payload: dict) -> dict:
    """把网关 chat.history payload 校准为 {messages, hasMore, nextOffset}（ACL 单点校准）。

    messages 原样透传（网关已 display-normalized），非 dict 项跳过；hasMore/nextOffset 精确名
    「待实测」——缺省回退 False / None。实测后改此处即可。
    """
    payload = payload or {}
    items = payload.get('messages')
    messages = [m for m in items if isinstance(m, dict)] if isinstance(items, list) else []
    has_more = payload.get('hasMore')
    next_offset = payload.get('nextOffset')
    return {
        'messages': messages,
        'hasMore': has_more if isinstance(has_more, bool) else False,
        'nextOffset': next_offset if isinstance(next_offset, (int, str)) else None,
    }


def _parse_created_key(payload: dict) -> str:
    """从网关 sessions.create payload 取新建的 session key（主取 key、回退 sessionKey）。"""
    key = (payload or {}).get('key') or (payload or {}).get('sessionKey')
    return key if isinstance(key, str) else ''


class _GatewaySessionsView(APIView):
    """网关权威会话端点的公共底座：_get_instance + 取 pool client（409/502 错误语义单点）。

    容器为全面板共享基础设施、无 owner/user_id，吃全局 IsAuthenticated（同 ApprovalResolveView）；
    实际权限由网关侧 scope 强制（read/write/admin），后端只是经已配对长连接透传。
    """

    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError as exc:
            raise _InvalidName from exc
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        return inst

    def _instance_or_error(self, name: str):
        """(instance, None) 或 (None, 400 Response)。"""
        try:
            return self._get_instance(name), None
        except _InvalidName:
            return None, Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)

    def _client_or_error(self, inst, name: str):
        """(client, None) 或 (None, 409/502/503 Response)：未配对 409；离线/握手失败 502；
        非 SyncToAsync 派生线程触达 503（issue #201 部署前提守卫）。"""
        if not on_synctoasync_thread():
            return None, _loop_premise_503(name, 'pool acquire')
        try:
            return async_to_sync(ChatFleet.get().get_or_create)(inst), None
        except NotPaired as e:
            return None, Response(
                {'detail': f'容器未配对，请先完成设备配对（status={e.status}）'},
                status=status.HTTP_409_CONFLICT,
            )
        except Exception as e:  # pylint: disable=broad-exception-caught
            logger.warning('sessions pool acquire failed for %s: %s', name, e)
            return None, Response(
                {'detail': '连接容器失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )

    @staticmethod
    def _rpc_or_502(name: str, label: str, thunk):
        """执行一次网关 RPC（thunk 为零参 async callable）；网关拒绝/超时 → 502。

        固定文案不外泄原始异常（仅记服务端日志）。async_to_sync 直接包 client 的 async 方法。
        非 SyncToAsync 派生线程触达 → 503（issue #201 部署前提守卫，fail-fast 不炸 recv loop）。
        """
        if not on_synctoasync_thread():
            return None, _loop_premise_503(name, label)
        try:
            return async_to_sync(thunk)(), None
        except Exception as e:  # pylint: disable=broad-exception-caught
            logger.warning('%s failed for %s: %s', label, name, e)
            return None, Response(
                {'detail': '会话操作失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )


class SessionListCreateView(_GatewaySessionsView):
    """GET 列出网关权威会话 + POST 新建（issue #81 / spec #76，后端零持久化）。

    GET → sessions.list（agentId=main + includeDerivedTitles），派生标题替代旧 title，响应
    {sessions:[{session_key,title,updated_at}]}；POST → sessions.create{key,label}（label 可空，
    网关后续派生标题），201 返回 {session_key}。
    """

    @extend_schema(request=None, responses={200: None})
    def get(self, request, name):
        inst, err = self._instance_or_error(name)
        if err is not None:
            return err
        client, err = self._client_or_error(inst, name)
        if err is not None:
            return err
        payload, err = self._rpc_or_502(name, 'sessions.list', client.list_sessions)
        if err is not None:
            return err
        return Response({'sessions': _parse_sessions(payload)})

    @extend_schema(request=SessionCreateSerializer, responses={201: None})
    def post(self, request, name):
        inst, err = self._instance_or_error(name)
        if err is not None:
            return err
        client, err = self._client_or_error(inst, name)
        if err is not None:
            return err
        # 0 信任：非对象 body（[]/"x"/123/None）一律 400，不进 serializer（避免 [] or {} → 误判合法）
        if request.data is not None and not isinstance(request.data, dict):
            return Response(
                {'detail': '非法请求体：须为 JSON 对象'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ser = SessionCreateSerializer(data=request.data or {})
        if not ser.is_valid():
            return Response(
                {'detail': '非法请求体：label 须为字符串（可空）'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        label = ser.validated_data.get('label') or None
        key = uuid.uuid4().hex
        payload, err = self._rpc_or_502(
            name, 'sessions.create', lambda: client.create_session(key, label=label))
        if err is not None:
            return err
        return Response({'session_key': _parse_created_key(payload) or key},
                        status=status.HTTP_201_CREATED)


class SessionHistoryView(_GatewaySessionsView):
    """GET 读取某会话完整聊天记录（issue #81 / spec #76）：代理 chat.history。

    query 可选 limit / messageId 锚点（向回翻页）；透传 messages[]（网关已 display-normalized）
    + hasMore/nextOffset 分页字段。需 operator.read scope（网关侧强制）。
    """

    @extend_schema(request=None, responses={200: None})
    def get(self, request, name, key):
        inst, err = self._instance_or_error(name)
        if err is not None:
            return err
        client, err = self._client_or_error(inst, name)
        if err is not None:
            return err
        limit_raw = request.query_params.get('limit')
        limit = None
        if limit_raw is not None:
            try:
                limit = int(limit_raw)
            except (TypeError, ValueError):
                limit = None
        message_id = request.query_params.get('messageId') or None
        payload, err = self._rpc_or_502(
            name, 'chat.history',
            lambda: client.get_history(key, limit=limit, message_id=message_id))
        if err is not None:
            return err
        return Response(_parse_history(payload))


class SessionDetailView(_GatewaySessionsView):
    """DELETE 删除某会话（issue #81 / spec #76）：代理 sessions.delete。

    **提升权限（admin 级）操作**：需 operator.admin scope，实际权限由网关侧强制；网关先写压缩
    归档（*.jsonl.deleted.<ts>.zst）再删，可恢复。成功 → 204。
    """

    @extend_schema(request=None, responses={204: None})
    def delete(self, request, name, key):
        inst, err = self._instance_or_error(name)
        if err is not None:
            return err
        client, err = self._client_or_error(inst, name)
        if err is not None:
            return err
        _, err = self._rpc_or_502(name, 'sessions.delete', lambda: client.delete_session(key))
        if err is not None:
            return err
        return Response(status=status.HTTP_204_NO_CONTENT)


class CommandListView(APIView):
    """GET 拉取该容器的斜杠命令清单（T07，spec §8.4）：代理网关 commands.list（需 operator.read）。

    经该容器 pool client 发 commands.list，把网关清单翻译成前端补全契约
    [{name, description, aliases[]}]——aliases 为精确斜杠别名（textAliases，如 /model、/m）。

    校准逻辑（验收 3，spec §8.2 标「待实测」外层键名/includeArgs 元数据，集中在此便于实测后单点修改）：
    - 外层键名：主取 payload['commands']，回退兼容单数 payload['command']（与 list_pending_approvals 同策略）。
    - 命令项：非 dict / 缺 name 跳过（对网关输入 0 信任）；aliases 取 textAliases，缺省回退 `/{name}`。
    - includeArgs 元数据（args 等）当前**不透传**——前端 MVP 只需 name/description/aliases（cmd mono + 描述）；
      实测确认字段名后如需展示参数再扩。

    - 成功 → 200 [{name, description, aliases[]}]；instance 不存在 → 404；非法 name → 400
    - 未配对 → 409；网关拒绝（缺 scope）/离线/握手失败 → 502（固定文案，原始异常仅记服务端日志）

    授权模型同 ApprovalResolveView：容器为全面板共享基础设施、无 owner，吃全局 IsAuthenticated；
    实际权限由网关侧 operator.read scope 强制（spec §8.2），后端只是经已配对长连接透传。
    """

    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError as exc:
            raise _InvalidName from exc
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        return inst

    @staticmethod
    def _parse_commands(payload: dict) -> list[dict]:
        """把网关 commands.list payload 校准为 [{name, description, aliases[]}]（见类 docstring）。"""
        payload = payload or {}
        items = payload.get('commands')
        if items is None:
            single = payload.get('command')
            items = [single] if isinstance(single, dict) else []
        if not isinstance(items, list):
            return []
        out = []
        for item in items:
            if not isinstance(item, dict):
                continue
            cmd_name = item.get('name')
            if not isinstance(cmd_name, str) or not cmd_name:
                continue
            aliases = item.get('textAliases')
            if not isinstance(aliases, list):
                aliases = []
            aliases = [a for a in aliases if isinstance(a, str) and a]
            if not aliases:
                aliases = [f'/{cmd_name}']
            description = item.get('description')
            out.append({
                'name': cmd_name,
                'description': description if isinstance(description, str) else '',
                'aliases': aliases,
            })
        return out

    @extend_schema(request=None, responses={200: None})
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        # issue #201：同 _client_or_error 的部署前提守卫（本视图不经 _GatewaySessionsView 底座）
        if not on_synctoasync_thread():
            return _loop_premise_503(name, 'commands.list')
        try:
            client = async_to_sync(ChatFleet.get().get_or_create)(inst)
        except NotPaired as e:
            return Response(
                {'detail': f'容器未配对，请先完成设备配对（status={e.status}）'},
                status=status.HTTP_409_CONFLICT,
            )
        except Exception as e:  # pylint: disable=broad-exception-caught
            logger.warning('commands.list pool acquire failed for %s: %s', name, e)
            return Response(
                {'detail': '连接容器失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            payload = async_to_sync(client.list_commands)()
        except Exception as e:  # pylint: disable=broad-exception-caught
            # 原始异常（缺 operator.read/连接断开等）仅记服务端日志，不外泄到响应
            logger.warning('commands.list failed for %s: %s', name, e)
            return Response(
                {'detail': '拉取命令清单失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(self._parse_commands(payload))


class ApprovalResolveView(APIView):
    """POST 回覆一次权限审批（T06，spec §8.4 回退路径；WS 路径为主）。

    body {id, kind, decision} → 经该容器 pool client 发 approval.resolve（需 operator.approvals）。
    与 WS 路径共用同一 ChatFleet pool（同一条已配对长连接）。
    - 成功 → 200 {ok:true, id, decision}
    - 缺字段/非法 decision → 400；instance 不存在 → 404；非法 name → 400
    - 未配对 → 409；网关拒绝（缺 scope 等）/连接失败 → 502（固定文案，不外泄原始异常）

    授权模型（安全复审 acknowledge）：与整个容器控制面一致（见 chat/consumers.py 模块 docstring），
    容器为全面板共享基础设施、无 owner/user_id，本端仅吃全局 IsAuthenticated，不做对象级归属校验。
    resolve 的实际权限由**网关侧 `operator.approvals` scope** 强制（spec §8.2）——后端只是经已配对
    长连接透传；per-user 隔离需 `Instance`/`Session` 引入 owner 并在所有控制面统一加对象级门，非本端独有。
    """

    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError as exc:
            raise _InvalidName from exc
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        return inst

    @extend_schema(request=ApprovalResolveSerializer, responses={200: None})
    def post(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        ser = ApprovalResolveSerializer(data=request.data or {})
        if not ser.is_valid():
            return Response(
                {'detail': '缺少 id/kind，或 decision 非法（须为 allow-once/allow-always/deny）'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        approval_id = ser.validated_data[APPROVAL_FIELD_ID]
        kind = ser.validated_data[APPROVAL_FIELD_KIND]
        decision = ser.validated_data[APPROVAL_FIELD_DECISION]
        # issue #201：同 _client_or_error 的部署前提守卫（本视图不经 _GatewaySessionsView 底座）
        if not on_synctoasync_thread():
            return _loop_premise_503(name, 'approval.resolve')
        try:
            client = async_to_sync(ChatFleet.get().get_or_create)(inst)
        except NotPaired as e:
            return Response(
                {'detail': f'容器未配对，请先完成设备配对（status={e.status}）'},
                status=status.HTTP_409_CONFLICT,
            )
        except Exception as e:  # pylint: disable=broad-exception-caught
            # codex P2：配对有效但网关离线/握手失败 → get_or_create 抛连接异常，亦映射 502（非 500）
            logger.warning('approval.resolve pool acquire failed for %s: %s', name, e)
            return Response(
                {'detail': '连接容器失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            async_to_sync(client.resolve_approval)(approval_id, kind, decision)
        except Exception as e:  # pylint: disable=broad-exception-caught
            # 原始异常（缺 scope/连接断开等）仅记服务端日志，不外泄到响应
            logger.warning('approval.resolve failed for %s id=%s: %s', name, approval_id, e)
            return Response(
                {'detail': '审批回覆失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        # 不回送权威 decision——RPC ack payload 无 decision 字段（ADR 0003），
        # 实际权威值由网关经 exec/plugin.approval.resolved 事件广播。
        return Response({'ok': True, APPROVAL_FIELD_ID: approval_id})

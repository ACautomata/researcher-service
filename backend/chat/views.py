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

from chat.models import Pairing, Session
from chat.pairing import PairingConcurrencyError, PairingFleet
from chat.pairing_ws import PairingError, PairingRequired
from chat.pool import ChatFleet, NotPaired
from chat.serializers import ApprovalResolveSerializer, PairingStatusSerializer, SessionSerializer
from containers.models import NAME_VALIDATOR, Instance

logger = logging.getLogger(__name__)


class _InvalidName(Exception):
    """路径参数 name 非法（内部信号，非 HTTP 响应）。"""


class PairingView(APIView):
    """GET 查询配对状态 + POST 触发/重试配对（spec §8.1）。"""

    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError:
            raise _InvalidName
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
    def post(self, request, name):
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
                f'设备待批准：请在宿主执行 `openclaw devices approve {e.request_id}` '
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


class SessionListCreateView(APIView):
    """GET 列出容器会话 + POST 新建（后端生成 session_key）（spec §9.4）。

    name 经 NAME_VALIDATOR；instance 不存在 → 404；非法 name → 400。
    """

    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError:
            raise _InvalidName
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        return inst

    @extend_schema(responses=SessionSerializer)
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        sessions = Session.objects.filter(instance=inst).order_by('-created_at')
        return Response(SessionSerializer(sessions, many=True).data)

    @extend_schema(request=None, responses={201: SessionSerializer})
    def post(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        title = str((request.data or {}).get('title') or '')[:128]
        session = Session.objects.create(
            instance=inst, session_key=uuid.uuid4().hex, title=title,
        )
        return Response(SessionSerializer(session).data, status=status.HTTP_201_CREATED)


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
        except ValidationError:
            raise _InvalidName
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
        try:
            client = async_to_sync(ChatFleet.get().get_or_create)(inst)
        except NotPaired as e:
            return Response(
                {'detail': f'容器未配对，请先完成设备配对（status={e.status}）'},
                status=status.HTTP_409_CONFLICT,
            )
        except Exception as e:
            logger.warning('commands.list pool acquire failed for %s: %s', name, e)
            return Response(
                {'detail': '连接容器失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            payload = async_to_sync(client.list_commands)()
        except Exception as e:
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
        except ValidationError:
            raise _InvalidName
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
                {'detail': '缺少 id/kind，或 decision 非法（须为 approve/deny）'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        approval_id = ser.validated_data['id']
        kind = ser.validated_data['kind']
        decision = ser.validated_data['decision']
        try:
            client = async_to_sync(ChatFleet.get().get_or_create)(inst)
        except NotPaired as e:
            return Response(
                {'detail': f'容器未配对，请先完成设备配对（status={e.status}）'},
                status=status.HTTP_409_CONFLICT,
            )
        except Exception as e:
            # codex P2：配对有效但网关离线/握手失败 → get_or_create 抛连接异常，亦映射 502（非 500）
            logger.warning('approval.resolve pool acquire failed for %s: %s', name, e)
            return Response(
                {'detail': '连接容器失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        try:
            payload = async_to_sync(client.resolve_approval)(approval_id, kind, decision)
        except Exception as e:
            # 原始异常（缺 scope/连接断开等）仅记服务端日志，不外泄到响应
            logger.warning('approval.resolve failed for %s id=%s: %s', name, approval_id, e)
            return Response(
                {'detail': '审批回覆失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        # first-answer-wins：以网关权威记录的 decision 为准（可能与请求不同，codex P1）
        authoritative = (payload or {}).get('decision') or decision
        # codex R2 P2：REST 路径的权威回执也经 pool client fan-out 给 WS 订阅者，各渲染副本一致收敛；
        # 失败（无订阅者/连接已断）不影响已成功的 REST 回执。
        try:
            async_to_sync(client.broadcast_approval_resolved)(approval_id, authoritative)
        except Exception:
            logger.debug('approval.resolve broadcast to subscribers failed for %s', name)
        return Response({'ok': True, 'id': approval_id, 'decision': authoritative})

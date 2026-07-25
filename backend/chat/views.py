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
from chat.serializers import PairingStatusSerializer, SessionSerializer
from containers.models import NAME_VALIDATOR, Instance

logger = logging.getLogger(__name__)

# T06 decision 合法取值（前端只发这两个；网关完整取值集合待实测，r26:79）
_APPROVAL_DECISIONS = ('approve', 'deny')


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


class ApprovalResolveView(APIView):
    """POST 回覆一次权限审批（T06，spec §8.4 回退路径；WS 路径为主）。

    body {id, kind, decision} → 经该容器 pool client 发 approval.resolve（需 operator.approvals）。
    与 WS 路径共用同一 ChatFleet pool（同一条已配对长连接）。
    - 成功 → 200 {ok:true, id, decision}
    - 缺字段/非法 decision → 400；instance 不存在 → 404；非法 name → 400
    - 未配对 → 409；网关拒绝（缺 scope 等）/连接失败 → 502（固定文案，不外泄原始异常）
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

    @extend_schema(request=None, responses={200: None})
    def post(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        data = request.data or {}
        approval_id = str(data.get('id') or '')
        kind = str(data.get('kind') or '')
        decision = str(data.get('decision') or '')
        if not approval_id or not kind or decision not in _APPROVAL_DECISIONS:
            return Response(
                {'detail': '缺少 id/kind，或 decision 非法（须为 approve/deny）'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            client = async_to_sync(ChatFleet.get().get_or_create)(inst)
        except NotPaired as e:
            return Response(
                {'detail': f'容器未配对，请先完成设备配对（status={e.status}）'},
                status=status.HTTP_409_CONFLICT,
            )
        try:
            async_to_sync(client.resolve_approval)(approval_id, kind, decision)
        except Exception as e:
            # 原始异常（缺 scope/连接断开等）仅记服务端日志，不外泄到响应
            logger.warning('approval.resolve failed for %s id=%s: %s', name, approval_id, e)
            return Response(
                {'detail': '审批回覆失败，请稍后重试'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response({'ok': True, 'id': approval_id, 'decision': decision})

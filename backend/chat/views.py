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

from django.core.exceptions import ValidationError
from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from chat.models import Pairing
from chat.pairing import PairingConcurrencyError, PairingFleet
from chat.pairing_ws import PairingError, PairingRequired
from chat.serializers import PairingStatusSerializer
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
            pairing = Pairing.objects.get(instance=inst)
            data = PairingStatusSerializer(pairing).data
            data['detail'] = (
                f'设备待批准：请在宿主执行 `openclaw devices approve {e.request_id}` '
                f'后重试本接口'
            )
            return Response(data, status=status.HTTP_202_ACCEPTED)
        except PairingError as e:
            # 原始异常（网络/协议细节）仅记服务端日志，不外泄到响应（codex R security）
            logger.warning('pairing handshake failed for %s: %s', name, e)
            pairing = Pairing.objects.get(instance=inst)
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

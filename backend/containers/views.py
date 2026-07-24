"""containers views —— 容器列表/创建/删除（spec §3/§4/§9.3）。

HTTP 薄适配层：入参必经 Serializer is_valid（spec §4 零信任，禁裸读 request.data），
业务委托 Fleet.get()（orchestrator service locator）。路径参数 name 亦经 NAME_VALIDATOR
（防 URL path 目录穿越）。受全局 IsAuthenticated 保护（spec §3），无 token → 401。

codex R1：orchestrator 领域异常转译为 HTTP 语义——InstanceExists→409（并发重名），
InstanceCleanupError→409（home 清理失败，DB 行保留可重试）。
codex R2：PortPoolExhausted/PortAllocationError→503（端口池耗尽/持续分配冲突，
属预期容量条件，非内部缺陷——客户端可区分，不再裸 500）。
codex R3：InstanceBusy→409（删除目标仍在 provisioning，防与在飞 create 竞态）。
"""
from django.core.exceptions import ValidationError
from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from chat.models import Pairing
from chat.serializers import PairingStatusSerializer
from .models import NAME_VALIDATOR
from .orchestrator import (
    ConfigurationError,
    Fleet,
    InstanceBusy,
    InstanceCleanupError,
    InstanceExists,
    PortAllocationError,
)
from .ports import PortPoolExhausted
from .serializers import InstanceCreateSerializer, InstanceSerializer


class InstanceListCreateView(APIView):
    """GET 列表（name/status/health/port/image）+ POST 新建（spec §9.3）。"""

    @extend_schema(responses=InstanceSerializer(many=True))
    def get(self, request):
        items = Fleet.get().list()
        # Codex P2：批量预取配对快照，避免 serializer 方法里 N+1 查询
        pairings = {
            p.instance.name: p
            for p in Pairing.objects
            .filter(instance__name__in=[i['name'] for i in items])
            .select_related('instance')
        }
        for item in items:
            pairing = pairings.get(item.get('name'))
            item['pairing'] = PairingStatusSerializer(pairing).data if pairing else {
                'status': Pairing.STATUS_UNPAIRED,
                'device_id': '',
                'scopes': [],
                'pairing_request_id': '',
            }
        return Response(InstanceSerializer(items, many=True).data)

    @extend_schema(
        request=InstanceCreateSerializer,
        responses={201: InstanceSerializer, 409: None, 503: None},
    )
    def post(self, request):
        ser = InstanceCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)  # spec §4：禁裸读 request.data
        name = ser.validated_data['name']
        try:
            inst = Fleet.get().create(name)
        except ConfigurationError as e:
            # codex R6 :484：LLM_API_KEY 未配置 → 503，不裸 500
            return Response(
                {'detail': str(e)}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        except InstanceExists:
            # codex R1 :84：并发绕 UniqueValidator → DB 唯一约束 → 409（非裸 IntegrityError→500）
            return Response({'detail': '实例名已存在'}, status=status.HTTP_409_CONFLICT)
        except (PortPoolExhausted, PortAllocationError):
            # codex R2 :40：端口池耗尽 / 持续分配冲突（预期容量条件）→ 503，非裸 500
            return Response(
                {'detail': '端口池已耗尽，暂无法创建容器，请稍后重试或删除闲置容器'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except InstanceCleanupError:
            # codex R4 :265：create 回滚时目录清理失败（行标 ERROR 保留可重试）→ 409，非裸 500
            return Response(
                {'detail': '容器创建失败且数据目录清理未完成（权限/属主），请重试或联系管理员清理'},
                status=status.HTTP_409_CONFLICT,
            )
        # codex R4 :60：由 create() 返回构造 201，不再二次 detail() 查 runtime——
        # 创建已 commit 并启动容器后，detail 的 daemon 抖动会让成功创建误返 500（重试撞 409）。
        item = Fleet.get().created_item(inst)
        return Response(InstanceSerializer(item).data, status=status.HTTP_201_CREATED)


class InstanceDetailView(APIView):
    """DELETE 删除容器（默认连数据删，spec §5.4）。"""

    @extend_schema(responses={204: None, 409: None})
    def delete(self, request, name):
        # spec §4：路径参数也校验，防 URL path 注入 → 目录穿越（name 进 rmtree 路径）
        try:
            NAME_VALIDATOR(name)
        except ValidationError:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            removed = Fleet.get().delete(name)
        except InstanceBusy:
            # codex R3 :257：目标仍在 provisioning（create 在飞）→ 409，客户端稍后再删
            return Response(
                {'detail': '容器正在创建中，请稍候再删除'},
                status=status.HTTP_409_CONFLICT,
            )
        except InstanceCleanupError:
            # codex R1 :126：容器已停删但 home 清理失败 → 409 + DB 行保留（标 REMOVING，可重试）
            return Response(
                {'detail': '容器已停删，但 home 目录清理失败（权限/属主），请重试或手动清理'},
                status=status.HTTP_409_CONFLICT,
            )
        if not removed:
            raise Http404
        return Response(status=status.HTTP_204_NO_CONTENT)

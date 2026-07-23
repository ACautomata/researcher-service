"""accounts views —— 注册 / 登录 / 刷新 / 当前用户。"""
from django.conf import settings
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .serializers import (
    AccessTokenSerializer,
    CookieTokenRefreshSerializer,
    LoginSerializer,
    RegisterSerializer,
    UserSerializer,
)


class RegisterView(APIView):
    """本地账号注册（spec §3）。公开，不参与 JWT 拦截。"""

    permission_classes = [AllowAny]

    @extend_schema(request=RegisterSerializer, responses={201: UserSerializer})
    def post(self, request):
        ser = RegisterSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = ser.save()
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


class LoginView(APIView):
    """登录：access(JSON body) + refresh(httpOnly cookie)，spec §3。"""

    permission_classes = [AllowAny]

    @extend_schema(request=LoginSerializer, responses=AccessTokenSerializer)
    def post(self, request):
        ser = LoginSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = ser.validated_data['user']
        refresh = RefreshToken.for_user(user)
        response = Response(
            {'access': str(refresh.access_token)}, status=status.HTTP_200_OK
        )
        response.set_cookie(
            'refresh_token',
            str(refresh),
            httponly=True,
            samesite='Lax',
            secure=not settings.DEBUG,
            path='/api/v1/auth',
        )
        return response


class CookieTokenRefreshView(TokenRefreshView):
    """刷新 access：从 httpOnly cookie 读 refresh（spec §3）。"""

    serializer_class = CookieTokenRefreshSerializer

    @extend_schema(
        request=None,  # refresh 走 httpOnly cookie，无 body（codex P2-4）
        responses=AccessTokenSerializer,
    )
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


class LogoutView(APIView):
    """登出：让 httpOnly refresh cookie 过期（codex P2-2，JS 无法清 httpOnly）。

    受全局 IsAuthenticated 保护（需 access token）。
    """

    @extend_schema(responses={204: None})
    def post(self, request):
        response = Response(status=status.HTTP_204_NO_CONTENT)
        response.delete_cookie('refresh_token', path='/api/v1/auth')
        return response


class MeView(APIView):
    """当前用户信息（spec §3）。受全局 IsAuthenticated 保护，不设 AllowAny。"""

    @extend_schema(responses=UserSerializer)
    def get(self, request):
        return Response(UserSerializer(request.user).data)

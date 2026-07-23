"""accounts app 路由 —— 挂在 /api/v1/auth/（spec §3）。

登录与刷新用 simplejwt：TokenObtainPairView（签发 access/refresh）、TokenRefreshView。
二者自带 permission_classes=[AllowAny]，在全局 IsAuthenticated 下显式放行。
"""
from django.urls import path
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .views import MeView, RegisterView

urlpatterns = [
    path('register', RegisterView.as_view(), name='register'),
    path('login', TokenObtainPairView.as_view(), name='login'),
    path('token/refresh', TokenRefreshView.as_view(), name='token_refresh'),
    path('me', MeView.as_view(), name='me'),
]

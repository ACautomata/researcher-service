"""accounts app 路由 —— 挂在 /api/v1/auth/（spec §3）。

登录签发 access(JSON body) + refresh(httpOnly cookie)；刷新从 cookie 读 refresh。
全部公开（AllowAny），在全局 IsAuthenticated 下显式放行。
"""
from django.urls import path

from .views import CookieTokenRefreshView, LoginView, MeView, RegisterView

urlpatterns = [
    path('register', RegisterView.as_view(), name='register'),
    path('login', LoginView.as_view(), name='login'),
    path('token/refresh', CookieTokenRefreshView.as_view(), name='token_refresh'),
    path('me', MeView.as_view(), name='me'),
]

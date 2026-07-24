"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from .views import AuthProbeView, HealthView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/health', HealthView.as_view(), name='health'),
    path('api/protected', AuthProbeView.as_view(), name='auth_probe'),  # T02 契约探针
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/schema/swagger/', SpectacularSwaggerView.as_view(), name='swagger'),
    path('api/v1/auth/', include('accounts.urls')),
    path('api/v1/containers/', include('containers.urls')),
    # chat app 子资源（配对）：/api/v1/containers/<name>/pairing/
    path('api/v1/', include('chat.urls')),
]

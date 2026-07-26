"""containers / 编排域共享常量单一来源（spec §5.2/§5.3 / parent issue #79）。

收口 gateway 容器内固定端口 18789 在 ports.py / runtime.py / config_renderer.py 三处
的重复定义（issue #88，1/3）。后续容器/编排域真常量（label key、容器内路径等）陆续并入。

划分原则（parent #79）：
- **真常量进这里**：协议/架构级不变量——值由 spec 或 Docker 网络拓扑决定，跨部署不漂移。
  典型：容器内固定端口（18789，命名空间隔离）、容器名前缀、label key。
- **部署配置留 settings**：随环境变化的运营参数（端口池区间、宿主 bind、token、超时），
  经 config/settings/{base,dev,prod}.py + env 注入，不进本模块。

边界（ADR 0002）：wire 域常量在 integration/openclaw/wire.py 单独收口；本模块只管
容器/编排域。两包互不重复定义（wire.py 注释已声明）。
"""

# 容器内 gateway 固定端口（spec §5.2/§5.3：Docker 网络命名空间隔离，仅宿主侧分配映射端口）
GATEWAY_INTERNAL_PORT = 18789

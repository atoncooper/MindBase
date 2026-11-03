# OpenSandbox — 最小 Docker Compose 部署

用 **一个 lifecycle 服务** 就能在单机跑 OpenSandbox（Docker runtime）：server 通过
宿主 Docker socket 创建 sibling sandbox 容器，execd 自动注入；不需要 K8s/Helm。

## 快速开始（独立最小栈）

```bash
export OPENSANDBOX_API_KEY=$(openssl rand -hex 32)
docker compose -f deploy/docker/opensandbox/docker-compose.yml up -d

curl -fsS -H "OPEN-SANDBOX-API-KEY: $OPENSANDBOX_API_KEY" \
  http://127.0.0.1:8080/health
```

- 配置：[config.toml](config.toml)（Docker runtime、SQLite store、端口 40000-60000）；
- 数据：named volume `opensandbox_data`（SQLite 元数据）；sandbox 容器本身由
  Docker runtime 管理，server 重启后按 DB 状态恢复；
- 只监听 `127.0.0.1:8080`，不要暴露公网。

## 接入 MindBase（root compose）

```bash
# .env
OPENSANDBOX_API_KEY=<与 standalone/上文相同的值>
SANDBOX_ENABLED=true
SANDBOX_BASE_URL=http://apisix:9080/internal/sandbox
SANDBOX_API_KEY=$APISIX_CONSUMER_KEY
SANDBOX_ADMIN_TOKEN=<admin panel token>

docker compose --profile sandbox up -d
```

root compose 的 `opensandbox-server` 与 `app-sandbox` 同属 `sandbox` profile：
- server 只在 127.0.0.1:8080 暴露调试口，app-sandbox 走 `http://opensandbox-server:8080/v1`；
- app-sandbox 默认 `SANDBOX_RUNTIME_TYPE=opensandbox`；仅本地演示可显式设为 `fake`；
- app-sandbox 设置 `extra_hosts: host.docker.internal:host-gateway`，用于访问
  server 发布在宿主上的 sandbox execd 端口；
- sandbox 镜像默认 `python:3.12`，可用 `OPEN_SANDBOX_SANDBOX_IMAGE` 覆盖；
- 产物仍为 Fake artifact store（MinIO 未接入），执行/配额/审计正常。

## 资源限制（客户端开发最小档）

| 容器 | CPU | 内存 | 说明 |
|---|---:|---:|---|
| opensandbox-server（独立最小栈） | 0.5 | 512M | 可用 `OPEN_SANDBOX_CPUS`/`OPEN_SANDBOX_MEMORY` 覆盖 |
| opensandbox-server（root compose） | 1.0 | 768M | 同上（同一组 env） |
| app-sandbox（控制层） | 0.5 | 256M | `APPSANDBOX_CPUS`/`APPSANDBOX_MEMORY` |
| 单个 sandbox 执行容器 | 250m | 256Mi | `SANDBOX_SANDBOX_CPU`/`SANDBOX_SANDBOX_MEMORY`，经 app-sandbox `runtime.resources` → OpenSandbox `resourceLimits` |

```bash
# .env：按机器规格放宽（例如数据集较大时）
SANDBOX_SANDBOX_CPU=1
SANDBOX_SANDBOX_MEMORY=1Gi
OPEN_SANDBOX_MEMORY=1G
```

这些限制是 **Compose 层**的 cgroup 上限；sandbox 执行容器同时受 OpenSandbox
create 请求的 `resourceLimits` 约束。生产 K8s 部署在 [deploy/k8s/40-sandbox](../k8s/40-sandbox/README.md)
的 values/Pool 中调资源。

## 安全边界与限制

- **Docker socket 等价 root**：server 容器挂载 `/var/run/docker.sock`，只允许在
  受信单机使用；多租户/生产请改用 K8s 隔离（见 `deploy/k8s/40-sandbox`）。
- `[docker] publish_host = "0.0.0.0"` 会把 sandbox execd 端口发布到宿主所有接口，
  生产需用宿主防火墙限制，或改为 bridge 网关 IP 并调整 app-sandbox 网络。
- server 单进程；重启会短暂中断；sandbox 容器可能残留，需要
  `docker ps --filter label=opensandbox` 排查。
- config.toml 挂载为只读；修改后需 `docker compose restart opensandbox-server`。
- `config.toml` 的 `execd_image` 与 server 版本保持同一 release（当前 release-1.2.0）；
  私有仓库/离线环境需先转存 server/execd/egress 与 sandbox 基础镜像。
- 若 server 因 Docker socket 权限无法启动：确认镜像用户对 socket 有访问权限
  （`docker inspect` 查看 User；必要时给容器加 `group_add` 或使用 root 运行）。

## 排查

| 现象 | 排查 |
|---|---|
| `/health` 通过但创建 sandbox 失败 | `docker logs mind-base-opensandbox-server`；确认 socket 挂载与宿主 Docker 版本 |
| app-sandbox 502/timeout | 确认 `opensandbox-server` healthy、API Key 与 app-sandbox 一致 |
| execd 连接失败 | 检查 `host.docker.internal` 解析、`publish_host` 与宿主防火墙；端口范围 40000-60000 |
| 沙箱容器残留 | `docker ps -a --filter label=opensandbox`；server DB 与 Docker 状态不一致时重启 server |
| 镜像拉取失败 | 国内网络先转存阿里云 registry；或设置 `OPEN_SANDBOX_IMAGE` 指向镜像仓库 |

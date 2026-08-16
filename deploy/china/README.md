# 🇨🇳 中国区 Docker 部署指南

本目录包含 MindBase 的中国区优化 Docker 部署文件，解决了中国大陆网络环境下多个境外镜像源不可达的问题。

---

## 与原版的差异

| 组件 | 原版来源 | 中国区替代 | 原因 |
|------|---------|-----------|------|
| Backend 镜像 | `ghcr.io` 预构建 / 项目根 Dockerfile | 本地构建（本目录 `Dockerfile.backend`） | ghcr.io 被墙；ffmpeg 下载走 ghfast.top 代理 |
| Frontend 镜像 | `ghcr.io` 预构建 / `frontendv2/Dockerfile` | 本地构建（本目录 `Dockerfile.frontend`） | ghcr.io 被墙；npm 走 npmmirror |
| App-task 镜像 | `ghcr.io` 预构建 / `app-task/Dockerfile` | 本地构建（本目录 `Dockerfile.app-task`） | ghcr.io + gcr.io/distroless 被墙；运行时换 Alpine |
| etcd | `quay.io/coreos/etcd` | `bitnami/etcd`（Docker Hub） | quay.io 不稳定 |

其余基础设施镜像（MySQL、Redis、MongoDB、MinIO、Milvus、Nginx、APISIX）均在 Docker Hub，中国可直达，未做替换。

---

## 镜像源对照表

| 阶段 | 原版 | 中国区 |
|------|------|--------|
| apt 包 | `deb.debian.org` | `mirrors.aliyun.com`（阿里云） |
| pip 包 | `pypi.org` | `pypi.tuna.tsinghua.edu.cn`（清华） |
| npm 包 | `registry.npmjs.org` | `registry.npmmirror.com`（淘宝） |
| Alpine apk | `dl-cdn.alpinelinux.org` | `mirrors.aliyun.com`（阿里云） |
| Go modules | `proxy.golang.org` | `goproxy.cn` |
| ffmpeg 二进制 | GitHub Releases | `ghfast.top` 代理 |
| etcd 镜像 | `quay.io/coreos/etcd` | `bitnami/etcd`（Docker Hub） |
| app-task 运行时 | `gcr.io/distroless` | `alpine`（Docker Hub） |

---

## 镜像拉取与加速（重要，先读这一节）

本目录的构建链路已不再访问任何被墙的镜像仓库（ghcr.io / gcr.io / quay.io 均已替换），构建期的包下载（apt / pip / npm / Go / ffmpeg）也全部走国内源。**但所有基础镜像和基础设施镜像（python、node、golang、alpine、mysql、redis、mongo、milvus、nginx、APISIX、bitnami/etcd、minio）仍从 Docker Hub 拉取**——Docker Hub 本身自 2024 年起在中国大陆直连不稳定（间歇性超时/重置）。

**解决办法：给 Docker 配置镜像加速器（一次性配置，覆盖所有镜像拉取）**。

Docker Desktop（Windows / macOS）：Settings → Docker Engine，编辑 JSON；Linux：编辑 `/etc/docker/daemon.json` 后 `sudo systemctl restart docker`：

```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://hub.rat.dev"
  ]
}
```

> 公共加速器可用性会随时间变化，以上列表若失效请搜索当前可用的 Docker 镜像加速地址。**最稳定的方案**是使用云厂商个人加速器（需注册账号，免费）：
> - 阿里云：容器镜像服务 → 镜像加速器，获得专属地址 `https://<你的ID>.mirror.aliyuncs.com`
> - 腾讯云：`https://mirror.ccs.tencentyun.com`（仅腾讯云内网生效，公网需用其个人版地址）

配置完成后验证：

```bash
docker pull hello-world   # 应能通过加速器正常拉取
docker info | grep -A 3 "Registry Mirrors"
```

---

## 快速启动

```bash
# 1. 进入中国区部署目录
cd deploy/china

# 2. 从项目根复制环境变量（至少填 LLM__API_KEY）
cp ../../.env .env
# 编辑 .env：填入 LLM__API_KEY、SESSION__SECRET、SECURITY__API_KEY_ENCRYPTION_KEY

# 3. 构建并启动全部服务
docker compose up -d --build

# 4. 查看状态
docker compose ps

# 5. 查看日志
docker compose logs -f backend
```

首次构建约 5-15 分钟（pip + npm + Go modules 均走国内镜像，速度取决于带宽；ffmpeg 下载 ~130MB）。后续构建利用 Docker layer cache 加速。

### Profile 用法（与原版一致）

```bash
# 全栈（app + infra + Milvus + apisix + app-task）
docker compose up -d --build

# 仅定时出题（app + apisix + app-task，无 Milvus）
docker compose --profile task up -d --build

# 含向量库（Milvus + MinIO），无定时出题
docker compose --profile storage up -d --build

# 最小（前端 + 后端 + 数据库，无向量库/对象存储）
docker compose --profile standalone up -d --build

# 全部 + 管理工具（redis-commander、mongo-express）
docker compose --profile full up -d --build
```

---

## 验证部署

```bash
# 健康检查
curl http://localhost/health
# {"status": "healthy"}

# 前端
curl -s http://localhost | head -5

# Swagger API 文档
# 浏览器打开 http://localhost/docs
```

---

## 常见问题

### Q: 构建时仍然很慢？

**pip / npm / Go modules**：确认 `.env` 未覆盖国内源，或检查网络是否开启了代理（代理与镜像源可能冲突）。

**基础/基础设施镜像拉不动（`docker pull` 超时）**：这是 Docker Hub 直连不稳定，见上方「[镜像拉取与加速](#镜像拉取与加速重要先读这一节)」——配置 Docker 镜像加速器即可解决，一次配置覆盖所有镜像。

**ffmpeg 下载失败**：`ghfast.top` 代理偶尔不稳定。编辑 `Dockerfile.backend`，注释 curl 下载块并取消注释 apt 安装 ffmpeg 的备用方案（镜像增大 ~450MB 但走阿里云源，100% 稳定）。

### Q: 我有代理，还需要用这个版本吗？

如果你有稳定的代理（能访问 ghcr.io、quay.io、GitHub），**推荐直接用项目根的原始 `docker-compose.yml`**——它使用预构建镜像，构建更快。配置 Docker 客户端代理即可：

```json
// ~/.docker/config.json
{
  "proxies": {
    "http-proxy": "http://127.0.0.1:7890",
    "https-proxy": "http://127.0.0.1:7890"
  }
}
```

### Q: etcd 数据目录变了？

是的。原版使用 `quay.io/coreos/etcd`（数据目录 `/etcd`），本版本使用 `bitnami/etcd`（数据目录 `/bitnami/etcd`）。Volume 名相同（`etcd_data`），但首次启动会创建新的空数据集。如果你从原版迁移，需要导出 etcd 数据再导入。

### Q: 如何更新到最新版本？

```bash
cd deploy/china
git pull ../../    # 在项目根 pull
docker compose up -d --build
```

---

## 文件清单

| 文件 | 说明 |
|------|------|
| `docker-compose.yml` | 中国区编排文件（等价于项目根 docker-compose.yml） |
| `Dockerfile.backend` | 后端 FastAPI（阿里云 apt + 清华 pip + ghfast.top ffmpeg） |
| `Dockerfile.frontend` | 前端 Next.js（npmmirror + 阿里云 Alpine） |
| `Dockerfile.app-task` | Go 任务执行器（goproxy.cn + Alpine 替代 distroless） |

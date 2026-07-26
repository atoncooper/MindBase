# Docker Compose 配置审查报告

> 审查对象: `docker-compose.yml` + `docker-compose.stack.yml`
> 日期: 2026-07-26

---

## 🔴 CRITICAL

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| 1 | `docker-compose.yml:152` | **redis 密码明文出现在 command 中** — `--requirepass ${REDIS_PASSWORD:-mind-base}` 会暴露在 `ps aux` / `docker inspect` 中 | 改用 Redis ACL file 挂载，或通过环境变量让 redis 镜像处理 |
| 2 | `docker-compose.yml:251-256` | **MinIO notify Redis 密码明文在环境变量中** — `MINIO_NOTIFY_REDIS_PASSWORD_clouddrive` 直接暴露 | 使用 Docker secrets（Swarm）或 K8s Secrets |
| 3 | `docker-compose.stack.yml` | **Stateful 服务全部 constrained 到 manager 节点** — MySQL/Redis/Mongo 单点故障，无 HA | 生产环境使用托管数据库（RDS/ElastiCache/Atlas）或数据库 Operator |
| 4 | 两个文件 | **所有密码用默认值** — `mind-base` / `root123` / `minioadmin` 硬编码为默认 | 生产部署必须通过环境变量覆盖，移除默认值或设为空强制填写 |

---

## 🟠 HIGH

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| 5 | `docker-compose.yml` | **无资源限制** — 所有容器无 `deploy.resources.limits`，可能 OOM 影响其他服务 | 至少给 backend/mysql/milvus 加 4Gi/8Gi 内存上限 |
| 6 | `docker-compose.yml:68-73` | **healthcheck 使用 curl** — 镜像需额外安装 curl（backend Dockerfile 已安装，没问题）；但 mongo/milvus 的 probe 间隔偏长 | 生产环境建议 interval ≤10s, failureThreshold ≥3 |
| 7 | `docker-compose.yml` | **backend 无 `depends_on` mysql/redis/mongo** — 启动顺序无保证，backend 可能在数据库就绪前启动并 crash | 添加 `depends_on` + `condition: service_healthy` |
| 8 | `docker-compose.stack.yml:210` | **MySQL `placement.constraints: [node.role == manager]`** — manager 节点压力集中，stateful 服务应分散到 worker 节点 | 移除 constraint 或使用专用 label `node.labels.storage==true` |
| 9 | `docker-compose.stack.yml:271` | **MinIO `RELEASE.2024-11-07` 版本过旧** — 近 2 年未更新，可能存在已知 CVE | 升级到最新稳定版 |

---

## 🟡 MEDIUM

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| 10 | `docker-compose.yml:24-25` | **`backend_data:/app/data` 跨平台 bind 无说明** — Windows 下 volume 挂载 SQLite 可能锁冲突 | 生产环境 SQLite → MySQL/PostgreSQL，见配置中 `RDBMS__URL` |
| 11 | `docker-compose.yml:128` | **MySQL 镜像 `mysql:8.4` 无 digest pinning** — 每次 pull 可能拿到不同 minor | 固定到 digest: `mysql:8.4@sha256:...` |
| 12 | `docker-compose.stack.yml:306` | **Stack 网络驱动 `overlay`** 在多节点正确，但 `attachable: true` 允许任意容器接入，降低隔离性 | 如无外部容器接入需求，关闭 attachable |
| 13 | 两个文件 | **无日志驱动配置** — 容器日志无限增长可能填满磁盘 | 配置 `logging.driver: json-file` + `max-size: 10m` + `max-file: 3` |
| 14 | `docker-compose.yml:24-25` | **backend_data volume 无备份策略文档** | 至少用 cronjob + `docker run --rm -v ... alpine tar` 定期备份 |
| 15 | `docker-compose.stack.yml:46-47` | **backend_data / backend_logs 无 driver 指定** — 使用默认 local driver，无法跨节点迁移 | 改用 NFS/EFS 等共享存储，或添加 `driver_opts` |

---

## 🟢 LOW

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| 16 | `docker-compose.yml:39` | **Mongo URI 密码明文** — `mongodb://admin:mind-base@mongo` 可通过环境变量注入 | 生产用 `MONGO__URI` 环境变量覆盖，不要用默认值 |
| 17 | `docker-compose.yml:14-15` | **`${BACKEND_IMAGE:-ghcr.io/...}` 默认指向 `latest` tag** — 不够明确 | 生产使用语义化版本 tag（如 `v1.2.3`） |
| 18 | `docker-compose.stack.yml:25-26` | **Stack 文件中 backend/frontend 没有 `build:`** — 依赖外部构建好的镜像，缺少从哪构建的文档 | 在文件头部注释中说明构建流程（已做） |

---

## 📋 K8s 迁移对照

| Docker Compose 服务 | K8s 资源 | 文件 |
|---------------------|---------|------|
| backend | Deployment + PVC + Service | `mindbase-app.yaml` |
| frontend | Deployment + Service | `mindbase-app.yaml` |
| nginx | Deployment (ConfigMap 挂载 nginx.conf) | `mindbase-app.yaml` |
| mysql | StatefulSet + Headless Service | `infra-statefulset.yaml` |
| redis | StatefulSet + Headless Service | `infra-statefulset.yaml` |
| mongo | StatefulSet + Headless Service | `infra-statefulset.yaml` |
| minio | StatefulSet + Headless Service | `infra-statefulset.yaml` |
| milvus | StatefulSet + Headless Service (+ initContainers) | `milvus.yaml` |
| etcd | StatefulSet + Headless Service | `milvus.yaml` |
| *(新增)* Kafka | Strimzi Kafka CRD | `data-platform.yaml` |
| *(新增)* Spark | SparkApplication CRD | `data-platform.yaml` |
| *(新增)* Flink | FlinkDeployment CRD | `data-platform.yaml` |
| *(新增)* Iceberg | Deployment + Service (REST catalog) | `data-platform.yaml` |
| Reverse Proxy | Ingress (nginx-ingress) | `ingress.yaml` |

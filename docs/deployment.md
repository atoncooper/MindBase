# 生产部署指南

> 单机 Docker Compose 生产部署（HTTPS、监控、备份、扩容、沙箱）。Kubernetes 见
> [deploy/k8s/README.md](../deploy/k8s/README.md)；服务/端口/路由/数据归属的权威版本见
> [architecture.md](architecture.md)，配置体系见 [configuration.md](configuration.md)。

## 1. 架构与入口

```text
浏览器 ──80/443──► nginx（TLS/SPA/缓存/限流）
  ├─ /cloud/（大文件上传，绕过网关，auth_request 注入 X-Uid）→ app-cloud
  ├─ /minio-proxy/（预签名对象同源代理）→ minio
  └─ 其余 API → APISIX:9080（容器内）
       ├─ forward-auth → app-auth /internal/auth/verify（注入 X-Uid/X-Roles）
       ├─ key-auth     → 服务间 /internal/*、MCP
       └─ → app-ts / app-go 各服务 / app-pay / app-board / app-sandbox
```

| 端口 | 服务 | 默认可达性 | 说明 |
|---|---|---|---|
| 80 / 443 | nginx | **公网** | 唯一生产入口；443 需证书（第 5 节） |
| 3000 | frontend | 0.0.0.0 | 生产可只经 nginx；防火墙限制 |
| 9080 | APISIX | 无宿主端口 | 仅容器网络；调试 `docker compose exec apisix` |
| 8000 / 8001-8016 | app-ts、app-go 各服务、app-task | 127.0.0.1 | 回环调试口，对外走网关 |
| 3001 / 8016 | app-admin UI / API | 127.0.0.1 | 管理台仅回环，远程用 SSH 隧道 |
| 8002 / 8003 | app-pay / app-pay-admin | 127.0.0.1 | HTTPS-only；管理台仅回环 |
| 3306 / 27017 / 6379 / 19530 / 7474 / 7687 / 9000-9001 | MySQL/Mongo/Redis/Milvus/Neo4j/MinIO | **compose 默认 0.0.0.0** | 生产必须防火墙限制或改回环绑定 |
| 18080 / 18443 / 18081 | Higress 网关 / 控制台 | 网关回环；控制台 0.0.0.0 | 控制台生产限来源 IP |

> ⚠️ 默认 compose 把数据库/对象存储端口映射到所有网卡（方便本地调试）。生产只放行 80/443，
> 其余端口在防火墙/安全组拒绝；管理台与网关控制台只经 VPN/SSH 隧道访问。

## 2. 前置与资源

- Linux x86_64（Ubuntu 22.04+/Debian 12+）、Docker 24+ 与 Compose v2、域名 A 记录指向服务器。
- 端口：80、443 对外，其余按第 1 节限制。
- 资源（经验值，全部容器同机）：最低 4C/8G + 100GB SSD；推荐 8C/16G + 200GB SSD。
  Milvus、Neo4j、MinIO 是磁盘/内存大件；启用沙箱再预留约 2C/4G（第 9 节）。
- 时区：以各服务配置为准；备份与定时任务跨时区时注意触发时间口径。

## 3. 密钥与环境

```bash
cd /opt/mind-base
cp .env.example .env
mkdir -p secrets
openssl rand -base64 32 > secrets/api_key_encryption_key
chmod 600 secrets/api_key_encryption_key
```

`.env` 只放密钥/含密码连接串；普通开关、端口、模型名在各自服务 YAML（见 [configuration.md](configuration.md)）。

| 变量 | 必填性 | 用途 / 生成 |
|---|---|---|
| `secrets/api_key_encryption_key`（文件） | 必填 | 用户凭证加密主密钥；`openssl rand -base64 32`。**部署后不可更换**（更换=已存数据无法解密） |
| `APISIX_CONSUMER_KEY` | 硬必填 | 服务间 key-auth；compose 多处 `:?` 校验，缺失直接起不来。`python3 -c "import secrets; print(secrets.token_urlsafe(36))"` |
| `AI_GATEWAY__API_KEY` | 必填 | Higress 消费者（BEARER）key；供应商真实 key 只在网关控制台配置，不进 `.env` |
| `MYSQL_ROOT_PASSWORD` / `MYSQL_USER` / `MYSQL_PASSWORD` | 生产必填 | 主库 `mind_base`；不填则用 compose 开发默认值 |
| `MONGO_USER` / `MONGO_PASSWORD`；`REDIS_PASSWORD`；`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 生产必填 | Mongo / 缓存 / 对象存储 |
| `NEO4J_PASSWORD` | 启用 KG 时必填 | app-kg 与 neo4j 共用（默认 `mind-base`，生产必须改） |
| `RDBMS__URL` / `MONGO__URI` / `REDIS__URL` | 生产建议显式 | 含密码连接串；不写则用 compose 默认 |
| `OPENSANDBOX_API_KEY`、`SANDBOX_ADMIN_TOKEN`、`SANDBOX_ENABLED=true` | 启用沙箱时 | 见第 9 节 |
| `APPTASK_EMAIL_API_KEY` | 启用出题邮件时 | Resend key；为空时邮件 worker 只 dry-run |
| `PAY_MYSQL_ROOT_PASSWORD` / `PAY_MYSQL_USER` / `PAY_MYSQL_PASSWORD` | 启用支付时 | app-pay 独立库 `app_pay` |
| `PAY_TLS_CERT` / `PAY_TLS_KEY`（`PAY_TLS_ENABLED`） | 生产必填 | 正式证书；默认 `certs/pay.crt` 与 `certs/pay.key`；`false` 仅本机排障 |
| `PAY_EXECUTOR_TOKEN`、`PAY_READONLY_KEY` / `PAY_OPS_KEY`、`ALIPAY_*` | 按功能 | 委托令牌、内部 key 分离、支付宝凭证 |
| `PAY_OPS_KEY` | 启用 pay-admin 时硬必填 | compose 对 `PAYADMIN__APP_PAY__OPS_KEY` 做 `:?` 校验 |
| `APP_CLOUD_ATTEST_SECRET` | 多副本时必填 | 分享设备证明 HMAC，各副本同值（`openssl rand -hex 32`） |
| `APP_CLOUD_ADMIN_REVIEW_TOKEN` | 启用审核预览时 | app-admin ↔ app-cloud 共享令牌，两边同值 |
| `APP_KG_INTERNAL_TOKEN`、`SHARE_DOMAIN`、`OCR__API_KEY`、LangSmith 三项 | 可选 | 内网 token、分享域名、OCR/tracing |
| `SESSION__SECRET` | **无需配置** | 现行根 compose 与各服务均不读取（仅 `deploy/china` 旧变体引用） |
| `LLM__API_KEY` | **无需配置** | 平台 AI 统一经 Higress 出网，只用 `AI_GATEWAY__API_KEY` |

- 密钥不落日志；`.env`、`secrets/` 已在 `.gitignore`，禁止提交/贴群。改 `.env` 后用 `docker compose up -d`（必要时加 `--force-recreate`）让新环境变量生效。

## 4. Profiles 启动矩阵

| 命令 | 启动内容 | 说明 |
|---|---|---|
| `docker compose up -d --build` | 默认全栈（实测 29 个服务）：frontend/nginx/APISIX/app-ts/app-go 各服务/app-board(+MCP)/app-task/app-pay/app-admin/存储/cert-gen | 首次必须 `--build` |
| `--profile ai` | 追加 Higress AI 网关（追加后用于平台 LLM/embedding 出网） | 单独执行只起 5 个服务（higress+mysql/mongo/redis+cert-gen），**不含**主栈 |
| `--profile sandbox` | 追加 opensandbox-server / app-sandbox | 单独执行只起 6 个服务；配合 `SANDBOX_ENABLED=true` |
| `--profile pay-admin` | 追加 app-pay-admin | 单独执行只起 6 个服务；需 `PAY_OPS_KEY` |
| `--profile pay-test` | 追加 app-pay-test（回环 18002）与测试库（回环 18306） | 仅测试，不用于生产 |
| `--profile tools` | 追加 redis-commander / mongo-express | 仅内网调试 |
| `--profile pay` / `--profile admin` | 默认集合已含 app-pay / app-admin；仅单域最小栈时显式指定 | 单独执行会排除默认全栈 |
| `--profile full` | 一次启动全量（实测 37 个服务）：默认全栈 + higress + sandbox 两件 + pay-admin + pay-test(+库) + tools | 功能最全的一种启动方式 |

> **compose profile 语义（实测 `docker compose config --services`）**：服务带 `profiles: [""]` 属于默认集合；
> **一旦传入 `--profile X`，默认集合不再自动启动**。因此上表「追加」应分两步：
>
> ```bash
> docker compose up -d --build                 # ① 默认全栈
> docker compose --profile ai up -d            # ② 追加 Higress
> docker compose --profile sandbox up -d       # ③ 需要时追加沙箱
> ```
>
> 或一次到底：`docker compose --profile full up -d`。单独 `--profile ai` 只会起 5 个服务，**不会**拉起主栈。

- 只起部分服务：`docker compose up -d --build app-ts nginx apisix`（依赖按 `depends_on` 自动拉起）。
- **镜像策略**：第一方镜像（`atoncooper/mind-base-*`）大多 `pull_policy: never`（app-ts 为 `missing`）——`never` 的必须本地构建（`docker compose build` / `up --build`）或 `docker load` 预导入；`docker compose pull` 只对基础设施镜像与 `missing` 策略的服务有效。
- 生产建议：先 `docker compose up -d --build`，再 `docker compose --profile ai up -d`（需要沙箱再 `docker compose --profile sandbox up -d`，并保持 `SANDBOX_ENABLED=true`）。

## 5. HTTPS / TLS

- **入口 nginx**：cert-gen 在每次 `up` 前自动签发开发证书（共享 dev CA + nginx/app-board/app-pay/MCP 叶子）到 `nginx/certs/` 等目录，幂等且过期/缺失自动重签；自签会告警，仅适合内网验证。
- **生产替换**：正式 `fullchain.pem`/`privkey.pem` 放 `nginx/certs/`（或 `MB_CERT_KEEP=1` 让 cert-gen 不覆盖；正式证书需覆盖域名 SAN），然后 `docker compose restart nginx`。本地自签用 `bash scripts/gen-nginx-dev-cert.sh`；Let's Encrypt 用 `bash nginx/setup-ssl.sh letsencrypt <domain> <email>`（临时停 nginx 用 80 端口验证）。
- `nginx/nginx.conf` 的 443 server 默认启用（证书路径 `/etc/nginx/certs/fullchain.pem` 与 `privkey.pem`）；80 保留 ACME challenge；两者共用 `locations.conf`。
- 反向代理注意：`/chat` 等 SSE 必须关 buffering；`/cloud/` 上传上限 5g 且绕过 APISIX；`/minio-proxy/` 由 nginx 直连 MinIO。改路由只改 `nginx/locations.conf`。
- **app-pay**：`server.ssl` 默认启用，证书默认 `certs/pay.crt` 与 `certs/pay.key`，生产用 `PAY_TLS_CERT`/`PAY_TLS_KEY` 覆盖；证书缺失启动自检拒绝启动；APISIX 的 `upstream-app-pay` 走 HTTPS（当前仅加密不校验证书）。
- **app-board**：默认 HTTPS-only；显式证书用 `APPBOARD__SERVER__TLS__CERT`/`...__KEY`；APISIX 只读挂其 `dev-ca.crt`，首次起栈后 `/board/*` 报证书/502 时 `docker compose restart apisix` 刷新信任锚。
- MCP：默认回环 HTTP；跨机设 `BOARD_MCP_TLS_ENABLED=true` 并让客户端信任 dev CA。

## 6. 监控与日志

| 服务 | 健康/指标端点（容器内） | 备注 |
|---|---|---|
| app-ts | `:8000/health`、`:8000/agent/runtime` | health 含 Milvus 可用性；runtime 含队列/超时/breaker |
| app-go 服务 | 8006/8007/8008/8010/8011/8015 的 `/health` | app-cloud 另有 `/metrics` |
| app-kg | `:8014/health`（gRPC `:8013` 自带 health） | |
| app-board / 三个 MCP | `:8004/8005/8009/8012/health` | app-board 为 HTTPS |
| app-task | `:8001/health` | |
| app-pay | `:8002/health`（HTTPS，真实 DB 探测）+ `/actuator/{health,metrics,prometheus}` | |
| app-pay-admin / app-admin-api | `:8003/health`、`:8016/health` | app-admin DB 不可用返回 503 |
| app-sandbox | `:8017/health`、`/ready`（MySQL ping）、`/metrics` | |
| opensandbox-server | `:8080/health` | |
| 基础设施 | compose healthcheck / 依赖链（mysql、mongo、redis、minio、etcd 等） | `docker compose ps` 看 healthy |

> 入口 nginx 的 `/health` 会转发到 APISIX，而 APISIX 未声明该路由——**不要把入口 `/health` 当健康判据**；用容器 healthcheck、直连回环端口或 `docker compose exec` 检查。

- 日志：`docker compose logs -f <service>`；app-go/app-pay/app-board/MCP 同时写 `/app/logs`（lumberjack 轮转，命名卷 `*_logs`）；app-ts 仅 stdout；nginx 在容器 stdout/stderr。
- 审计：`pay-audit.jsonl`（app-pay 卷 `/app/logs`，365 天哈希链）、`pay-admin-audit.jsonl`（pay-admin 卷）、`admin_audit`（MySQL mind_base，app-admin）、`sandbox_audit`（MySQL mind_base，app-sandbox）；学术证据在 Mongo `academic_runs`。
- 建议外部监控：入口 `GET /` + 各服务回环 health；Prometheus 抓取 app-cloud/app-sandbox/app-pay 指标；日志集中采集容器 stdout。

## 7. 备份与恢复

先 `mkdir -p backup`；数据库密码用容器内环境变量取（不要在命令行明文）。

```bash
# MySQL（3 个独立实例/库）
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers mind_base' > backup/mind_base.sql
docker compose exec -T app-task-mysql sh -c 'exec mysqldump -uroot -p"$APPTASK_MYSQL_ROOT_PASSWORD" --single-transaction app_task' > backup/app_task.sql
docker compose exec -T app-pay-mysql sh -c 'exec mysqldump -uroot -p"$PAY_MYSQL_ROOT_PASSWORD" --single-transaction app_pay' > backup/app_pay.sql

# 恢复示例（MySQL）
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" mind_base' < backup/mind_base.sql
```

- **MongoDB**：官方 `mongo:7` 镜像不保证自带 `mongodump`，推荐**停写后备份数据卷**：`docker compose stop mongo` → 确认卷 `docker volume ls -q | grep -E '(^|_)mongo_data$'` → `docker run --rm -v <volume>:/data -v "$PWD/backup":/backup alpine tar czf /backup/mongo_data.tgz -C /data .` → `docker compose start mongo`；恢复=停 mongo、解包回卷、启动。若环境已有 `mongodump`，也可对 `mind_base` 与 `mind_base_ts` 分别 `--archive --gzip`。
- **MinIO / Milvus / Neo4j（命名卷）**：同理先停写再拷卷。MinIO 用 `minio_data`；Milvus 依赖 `milvus_data`+`etcd_data`+`minio_data` 需一并停/备份（或先在 Milvus 侧 flush 再停）；Neo4j 用 `neo4j_data`。恢复统一为：`docker compose stop <svc>` → `docker run --rm -v <volume>:/data -v "$PWD/backup":/backup alpine sh -c 'cd /data && tar xzf /backup/<file>.tgz'` → `docker compose start <svc>`。
- **证书与密钥**：`.env`、`secrets/api_key_encryption_key`、`nginx/certs`、`app-pay/certs`、`app-board/certs`、`mcp/app-board-mcp/certs` 必须随备份保存（丢主密钥=用户凭证不可恢复）。
- **顺序**：升级/迁移前先备份 MySQL+Mongo；app-pay 由 Flyway 前向迁移（不可逆），回滚代码前先恢复对应库备份。
- `docker compose down` 保留卷；`docker compose down -v` 删除全部数据卷（生产严禁）。

## 8. 扩容与多实例

| 服务 | 多实例能力 | 说明 |
|---|---|---|
| nginx / frontend / APISIX | 无状态，可扩 | 单机 compose 受宿主端口限制；多副本应上 K8s/Swarm |
| app-go 服务 | 无状态，可扩 | APISIX upstream 当前每服务单 node，扩容需同步改 upstream 或走 nginx 变量解析 |
| app-cloud | **支持** `docker compose up -d --scale app-cloud=2` | 宿主端口池 8007-8009；nginx `resolver 127.0.0.11 valid=10s` 自动纳用；后台任务租约锁 + Mongo outbox 认领；多副本必须同 `APP_CLOUD_ATTEST_SECRET`；APISIX upstream 仍单 node（仅 workspaces 兜底） |
| app-ts | 当前按单副本运行 | 进程内 admission/计划/限流/缓存，扩副本前需外置 |
| app-pay | 单实例语义（JobLease 防 job 翻倍） | 订单状态机/回调幂等依赖条件更新；多实例前评估内存态闸门 |
| app-sandbox | 单副本 | 进程内幂等缓存 + 单 sweeper；扩副本需 leader election/幂等落库 |
| 有状态存储 | 单实例 | MySQL/Mongo/Redis/Milvus/Neo4j/MinIO 的 HA 见 deploy/k8s 路线 |

## 9. 沙箱部署（代码执行）

链路：`app-ts` → APISIX `/internal/sandbox/*`（key-auth）→ `app-sandbox`（租约/配额/审计）→ OpenSandbox lifecycle → sandbox 容器。

```bash
# .env（沙箱相关）
OPENSANDBOX_API_KEY=<openssl rand -hex 32>   # 两侧同值
SANDBOX_ENABLED=true                        # app-ts 侧启用
SANDBOX_ADMIN_TOKEN=<openssl rand -hex 32>  # 管理面板令牌（可空=面板禁用）

docker compose up -d --build                 # 先起默认全栈（若尚未启动）
docker compose --profile sandbox up -d       # 再追加沙箱；单独 --profile sandbox 不会带起主栈
```

- 单机 compose 的 `opensandbox-server` 挂载宿主 Docker socket 创建 sibling sandbox 容器：**docker socket ≈ root**，只允许可信单机；多租户/生产用 K8s 隔离（[deploy/k8s/40-sandbox/README.md](../deploy/k8s/40-sandbox/README.md)）。
- 运行时默认 `SANDBOX_RUNTIME_TYPE=opensandbox`；仅本地演示可设 `fake`（不会真实隔离执行）。
- 验证：`curl -fsS http://127.0.0.1:8017/health`、`/ready`；`curl -fsS -H "OPEN-SANDBOX-API-KEY: $OPENSANDBOX_API_KEY" http://127.0.0.1:8080/health`。
- 单机最小部署：[deploy/docker/opensandbox/README.md](../deploy/docker/opensandbox/README.md)；生产 K8s（热池/NetworkPolicy/Helm）：[deploy/k8s/40-sandbox/README.md](../deploy/k8s/40-sandbox/README.md)。

## 10. Kubernetes 部署（摘要）

完整清单、Secret/ConfigMap、节点分工与运维见 [deploy/k8s/README.md](../deploy/k8s/README.md)。顺序：

```bash
# ① Secret/ConfigMap（仓库根执行；完整清单见 README §1/§1b）
kubectl -n mind-base create secret generic mindbase-env --from-env-file=.env
kubectl -n mind-base create secret generic nginx-tls --from-file=fullchain.pem=nginx/certs/fullchain.pem --from-file=privkey.pem=nginx/certs/privkey.pem
kubectl -n mind-base create secret generic api-key-encryption-key --from-file=api_key_encryption_key=secrets/api_key_encryption_key
kubectl -n mind-base create configmap mysql-init-sql --from-file=system.sql=db/system.sql
kubectl -n mind-base create configmap apisix-config --from-file=config.yaml=apisix/config.yaml --from-file=apisix.yaml=apisix/apisix.yaml
kubectl -n mind-base create configmap nginx-conf --from-file=nginx.conf=nginx/nginx.conf --from-file=locations.conf=nginx/locations.conf

# ② 沙箱（可选，先于主栈）；③ 主栈（namespace: mind-base）
bash deploy/k8s/40-sandbox/install.sh
kubectl apply -k deploy/k8s
kubectl -n mind-base get pods -w
```

- 入口是 nginx `Service type=LoadBalancer`（裸集群配 `metallb.yaml`），**无 Ingress 资源**；域名/证书走 `nginx-tls` Secret。
- 管理台（app-admin/pay-admin/app-sandbox）在 K8s 中通过 `kubectl port-forward` 访问，不对外暴露。

## 11. 升级与回滚

```bash
cd /opt/mind-base && git pull
docker compose build              # 第一方镜像必须重建
docker compose up -d
# 回滚：切回上一个可用 commit 后重建
git checkout <last-good-commit> && docker compose build && docker compose up -d
```

- **镜像**：第一方镜像大多 `never`（app-ts 为 `missing`），`docker compose pull` 拉不到新版本，必须 `build`；预构建/CI 镜像用 `docker load` 导入后 `up -d`（升级前记录旧镜像 ID，回滚可 `docker tag` 回去）。
- **数据库迁移**：app-pay 启动时 Flyway 自动执行 `db/migration/V*.sql`（前向迁移、`baseline-on-migrate`）；MySQL 主库 `db/system.sql` 只在首次初始化执行；app-go/app-board/app-sandbox 启动时 `CREATE TABLE IF NOT EXISTS`/AutoMigrate 增量建表；Mongo 无迁移。**回滚代码前先恢复对应数据库备份**，不要依赖逆向迁移。
- **向量**：更换 embedding 模型或维度会使 Milvus 集合不兼容，必须全量重建（升级前确认不做模型切换）。
- 数据卷在 `up -d`/`down` 间保留；只有 `down -v` 会清空。

## 12. 故障排查

| 现象 | 常见原因与处理 |
|---|---|
| 502 Bad Gateway | 上游未就绪：`docker compose ps` 看 apisix/frontend/app-ts；`docker compose logs nginx`；APISIX 依赖 etcd，查 `logs apisix etcd` |
| 401 / 403 | 会话过期（app-auth forward-auth 401）；服务间 `/internal/*` 需 `APISIX_CONSUMER_KEY`（key-auth）；直连应用端口绕过网关也会 401（只信任网关注入的 X-Uid） |
| app-pay 起不来 | 证书缺失（`PAY_TLS_CERT` 路径错/未生成 → 启动自检拒绝）；Flyway 迁移失败；`app-pay-mysql` 未 healthy |
| app-ts 功能降级 | Mongo/Milvus/Redis 不可用时启动日志出现 `memory fallback` / `[RAG] ... degraded`；服务仍可用但数据不落/检索受限，修复依赖后重启 |
| 沙箱不可用 | 未开 `--profile sandbox` 或 `SANDBOX_ENABLED` 非 true；`/ready` 失败（MySQL ping）；`OPENSANDBOX_API_KEY` 两侧不一致；查 `logs app-sandbox opensandbox-server` |
| 管理台 3001 打不开 | 仅回环：`ssh -L 3001:127.0.0.1:3001 user@host` 后访问 http://127.0.0.1:3001；`APPADMIN__SECURITY__IP_ALLOWLIST` 会拦截来源 IP |
| 端口冲突 | 在 `.env` 覆盖 `MYSQL_PORT`/`MONGO_PORT`/`REDIS_PORT`/`FRONTEND_PORT` 等；`docker compose ps` 查看占用 |
| 内存/磁盘告警 | Milvus/Neo4j/MinIO 为大件：`docker stats`、`docker system df -v`；必要时迁数据卷到更大磁盘 |

## 相关文档

- [architecture.md](architecture.md)：服务/端口/路由/数据归属；[configuration.md](configuration.md)：配置体系与密钥清单
- [setup-guide.md](setup-guide.md)：本地 Docker 起步
- 专项：[app-cloud.md](app-cloud.md)、[app-pay.md](app-pay.md)、[app-admin.md](app-admin.md)、[academic-agent.md](academic-agent.md)、[code-execution.md](code-execution.md)
- 机器可读部署清单：[deploy/k8s/README.md](../deploy/k8s/README.md)、[deploy/docker/opensandbox/README.md](../deploy/docker/opensandbox/README.md)

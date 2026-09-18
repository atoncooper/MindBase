# MindBase — Kubernetes 部署

本目录将 `docker-compose.yml` 的完整拓扑（4×MySQL、Redis、Mongo、Milvus+etcd、
MinIO、Neo4j、backend/frontend/app-task/app-pay/app-board/app-pay-admin、
APISIX、Higress、nginx）等价移植为 k8s 清单。

**核心设计：所有 Service 名称与 compose 服务名完全一致**
（`mysql`/`redis`/`mongo`/`milvus`/`minio`/`apisix`/`higress`/`nginx`/…），
因此 `.env` 里的连接串与 compose 的 environment 覆盖值**零改动**即可工作。

## 0. 前置要求

- Kubernetes ≥ 1.28，`kubectl` 已配置（kustomize 内置于 kubectl）；
- 默认 StorageClass 可用（StatefulSet/PVC 未指定 storageClassName，取默认）；
- 能拉取镜像：`ghcr.io/atoncooper/mind-base-*`、`milvusdb/milvus:v2.6.22`、
  `mysql:8.4`、`mongo:7`、`redis:7-alpine`、`neo4j:5-community`、
  `quay.io/coreos/etcd:v3.5.14`、`minio/minio:RELEASE.2024-11-07T00-52-20Z`、
  `apache/apisix:3.11.0-debian`、`nginx:alpine`、busybox、
  Higress all-in-one（国内集群直连阿里云仓库无压力；海外建议自行转存）。

## 1. 一次性创建 Secret（不进 git）

Secret 一律从本地文件生成，**清单里没有任何真实密钥**：

```bash
# ① 应用全部环境变量（= compose 的 env_file: .env，逐字等价）
kubectl -n mind-base create secret generic mindbase-env --from-env-file=.env

# ② nginx TLS（nginx/certs/ 已有开发证书；生产换正式证书后重跑）
kubectl -n mind-base create secret generic nginx-tls \
  --from-file=fullchain.pem=nginx/certs/fullchain.pem \
  --from-file=privkey.pem=nginx/certs/privkey.pem

# ③ app-pay TLS（服务端 HTTPS-only + app-task 委托回调 CA）
kubectl -n mind-base create secret generic app-pay-tls \
  --from-file=pay.crt=app-pay/certs/pay.crt \
  --from-file=pay.key=app-pay/certs/pay.key \
  --from-file=ca.crt=app-pay/certs/ca.crt

# ④ app-board TLS + APISIX 信任锚（dev-ca.crt 进 apisix 的 ca-bundle）
kubectl -n mind-base create secret generic app-board-certs \
  --from-file=dev-ca.crt=app-board/certs/dev-ca.crt \
  --from-file=server.crt=app-board/certs/server.crt \
  --from-file=server.key=app-board/certs/server.key
```

`.env` 改动后需同步：`kubectl -n mind-base delete secret mindbase-env && 重新 create`，
再 `kubectl -n mind-base rollout restart deploy`。

## 2. 部署 / 更新

```bash
kubectl apply -k deploy/k8s
kubectl -n mind-base get pods -w
```

启动顺序由各 Deployment 的 **initContainer 等待探针**保证
（backend 等 mysql/mongo/redis 就绪、apisix 等 etcd/backend、nginx 等四个上游…），
无需手工排序。

## 3. 部署后初始化（一次性）

| 事项 | 操作 |
|------|------|
| Higress 控制台 | `kubectl -n mind-base port-forward svc/higress 18081:8001` → http://127.0.0.1:18081 初始化 admin、配 Provider（供应商真实 key 只在这里）/ Consumer `mindbase-backend`(BEARER) / 路由 `/v1`、`/api/v1`、`/api-ws`；**modelMapping 保持空透传** |
| 网关 consumer key 回填 | 控制台生成的 key 填入 `.env` 的 `AI_GATEWAY__API_KEY` → 重建 mindbase-env Secret → rollout restart backend |
| app-pay-admin | `kubectl -n mind-base port-forward svc/app-pay-admin 8003:8003` → https://127.0.0.1:8003（种子账户 admin / app-pay-admin，首登改密） |
| 入口地址 | nginx Service 是 LoadBalancer：本地集群直接用分配的地址；云上绑域名 + 正式证书（更新 nginx-tls Secret 后 restart nginx） |

## 4. 与 docker-compose 的差异（有意为之）

| 项 | compose | k8s |
|----|---------|-----|
| app-pay-test / 测试 MySQL | `--profile pay-test` | **未移植**（测试实例与生产隔离的诉求在 k8s 下应另起 namespace） |
| redis-commander / mongo-express | `--profile tools` | **未移植**（用 port-forward + 本地工具替代） |
| app-board 证书共享 | 宿主目录 `./app-board/certs` 双挂载 | **Secret `app-board-certs`**：server.crt/server.key 给 app-board，dev-ca.crt 给 apisix——确定性高于自动生成；证书轮换 = 更新 Secret + 重启两服务 |
| app-pay TLS | 宿主目录 `./app-pay/certs` | Secret `app-pay-tls`（ca.crt 同时供 app-task 委托回调校验） |
| MySQL 建表脚本 | 宿主 `app/system.sql` | ConfigMap `mysql-init-sql`（kustomize generator，改 SQL 后 apply 重建） |
| APISIX 路由 | 宿主 `apisix/*.yaml` | ConfigMap `apisix-config`（subPath 挂载；改路由后 `kubectl -n mind-base rollout restart deploy/apisix`） |
| nginx 配置 | 宿主 `nginx/*.conf` | ConfigMap `nginx-conf`（subPath；同上 restart） |
| Higress 版本 | `:latest` + 可选 digest 钉死 | 同左；生产建议把 Deployment 的 image 改成 `@sha256:` 钉死 |
| 数据持久化 | named volumes | PVC（mysql 10Gi×3、mongo 10Gi、redis 5Gi、etcd 5Gi、minio 20Gi、milvus 20Gi、neo4j 10Gi、higress 5Gi、backend-data 5Gi）；日志与 nginx 缓存为 emptyDir |

探针语义与 compose healthcheck 一致（mysqladmin ping / mongosh ping /
redis-cli ping / etcdctl endpoint health / minio health/live / backend /health）；
无 HTTP 健康端点的 TLS 服务（app-pay/app-board/app-pay-admin）用 tcpSocket 探活。

## 5. 日常运维

```bash
# 看状态
kubectl -n mind-base get pods,svc,pvc
# 日志
kubectl -n mind-base logs deploy/backend -f
# 改 APISIX 路由：编辑 apisix/apisix.yaml 后
kubectl apply -k deploy/k8s && kubectl -n mind-base rollout restart deploy/apisix
# 扩容 backend（无状态，可扩；注意 Milvus/DB 连接数）
kubectl -n mind-base scale deploy/backend --replicas=2
```

## 6. 未覆盖（后续按需）

- HPA / PDB、网络策略（NetworkPolicy 限制 DB 仅被应用访问）、
  cert-manager 自动证书、Prometheus 监控、备份（PVC 快照/CronJob mysqldump）。
- 生产化前的硬性检查：替换所有 `change-me` 占位密钥、Higress 镜像钉 digest、
  nginx 正式证书、MySQL 关闭 root 远程。

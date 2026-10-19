# MindBase — Kubernetes 部署

本目录将 `docker-compose.yml` 的完整拓扑（3×MySQL、Redis、Mongo、Milvus+etcd、
MinIO、Neo4j、frontend、APISIX、Higress、nginx、app-ts（AI 域）、app-go 七服务
（auth/cloud/note/bili/quiz/kg/settings）、app-board + 三个 MCP、app-task、
app-pay/app-pay-admin）等价移植为 k8s 清单。

> ⚠️ Python backend 已于 2026-10-06 退役（见 docs/python-decommission.md）——
> 旧 `backend.yaml` 已删除，app-ts 沿用其 8000 端口与网关路由语义。

**核心设计：所有 Service 名称与 compose 服务名完全一致**
（`mysql`/`redis`/`mongo`/`milvus`/`minio`/`apisix`/`higress`/`nginx`/…），
因此 `.env` 里的连接串与 compose 的 environment 覆盖值**零改动**即可工作。

## 0. 前置要求

- Kubernetes ≥ 1.28，`kubectl` 已配置（kustomize 内置于 kubectl）；
- 默认 StorageClass 可用（StatefulSet/PVC 未指定 storageClassName，取默认）；
- 能拉取镜像：`atoncooper/mind-base-*`（含 `mind-base-minio`/`mind-base-certgen`，MinIO 上游已从
  Docker Hub 移除，见 scripts/minio.Dockerfile）、`milvusdb/milvus:v2.6.22`、
  `mysql:8.4`、`mongo:7`、`redis:7-alpine`、`neo4j:5-community`、
  `quay.io/coreos/etcd:v3.5.14`、
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

# ⑤ 主加密密钥（SESSDATA 解密;app-auth/app-bili 经 _FILE 约定读
#    /run/secrets/api_key_encryption_key——.env 里的 *_FILE 宿主相对路径
#    在容器内无效,清单中的 env 覆盖会指向此挂载路径）
kubectl -n mind-base create secret generic api-key-encryption-key \
  --from-file=api_key_encryption_key=secrets/api_key_encryption_key
```

## 1b. 一次性创建 ConfigMap（静态配置文件）

> kustomize 的 load restrictor 禁止引用目录外文件（kubectl ≥1.36 也已拒绝
> `loadRestrictions: LoadRestrictionsNone`），所以这三份 ConfigMap 与 Secret
> 一样用 kubectl 从仓库根文件创建，**必须在 `apply -k` 之前完成**：

```bash
kubectl -n mind-base create configmap mysql-init-sql \
  --from-file=system.sql=db/system.sql
kubectl -n mind-base create configmap apisix-config \
  --from-file=config.yaml=apisix/config.yaml \
  --from-file=apisix.yaml=apisix/apisix.yaml
kubectl -n mind-base create configmap nginx-conf \
  --from-file=nginx.conf=nginx/nginx.conf \
  --from-file=locations.conf=nginx/locations.conf
```

更新流程：改仓库源文件后重跑对应 `create configmap --dry-run=client -o yaml | kubectl apply -f -`，
再 `kubectl -n mind-base rollout restart deploy/<mysql|apisix|nginx>`。

`.env` 改动后需同步：`kubectl -n mind-base delete secret mindbase-env && 重新 create`，
再 `kubectl -n mind-base rollout restart deploy`。

## 1c. 环境变量分层（mindbase-defaults ConfigMap，kustomize 生成）

所有工作负载的 `envFrom` 顺序固定为两层，等价 compose 的 `${VAR:-default}` 语义：

1. `mindbase-defaults`（ConfigMap，kustomize literals 生成，见 kustomization.yaml）——
   compose 的兜底值（dev 凭据与连接串；这些默认值本就公开在 docker-compose.yml/git 里）；
2. `mindbase-env`（Secret，来自 .env）——同名键**覆盖**第 1 层。

推论：

- `.env` 只需要放「想覆盖的键 + 必填密钥」；没写的键自动落到 defaults；
- `APISIX_CONSUMER_KEY` 是唯一**硬必需**键（多处 valueFrom 直引用，缺失 = Pod 起不来）；
- `BOARD/NOTE/QUIZ_MCP_UID`、`*_MCP_AUTH_TOKEN`、`PAY_OPS_KEY` 为 optional 引用
  （缺失 = 对应功能停用，不影响启动）；
- 少数服务特定值以显式 `env:` 写死（显式 env 优先于 envFrom），想用 .env 覆盖它们时
  需 `kubectl patch`：app-ts/app-cloud/app-bili 的 `AI_GATEWAY__BASE_URL`、
  app-ts 的 `OCR__MODEL`、app-cloud 的 `MILVUS__URI`；
- compose 的 `${APISIX_CONSUMER_KEY}` 交叉引用在 K8s 用「先取源值再派生」的
  in-list 模式实现：`$(VAR)` 只能引用同容器 env 列表中**先定义**的变量，
  **envFrom 变量不可被 $(VAR) 引用**（K8s 硬限制——原清单 60 处踩坑已全部修复）；
- 基础设施侧三处固定引用不走 .env：redis 命令行口令、minio 事件通知口令、
  milvus 的 MinIO 凭证——均 configMapKeyRef 取 `mindbase-defaults`，与各客户端
  连接串默认值同源；改这些口令 = 改 kustomization literals + rollout restart。

其他两处 compose→k8s 的行为差异：

| 项 | compose | k8s |
|----|---------|-----|
| nginx resolver | Docker 内嵌 DNS `127.0.0.11` | nginx.conf 不可改源文件，容器启动时 `sed` 改写为本 Pod 集群 DNS 后以副本启动（见 30-apps/nginx.yaml command） |
| APISIX 依赖 | depends_on etcd healthy | 无依赖（config.yaml 为 data_plane，跳过 init_etcd），initContainer 已移除 |

## 2. 部署 / 更新

```bash
kubectl apply -k deploy/k8s
kubectl -n mind-base get pods -w
```

启动顺序由各 Deployment/StatefulSet 的 **initContainer 等待探针**保证
（app-go/app-ts 各等 mysql/mongo/redis/minio/neo4j/milvus 就绪、milvus 等 etcd+minio、
nginx 等上游…；apisix 是 standalone data_plane 不依赖 etcd，无 initContainer），
无需手工排序。

## 3. 部署后初始化（一次性）

| 事项 | 操作 |
|------|------|
| Higress 控制台 | `kubectl -n mind-base port-forward svc/higress 18081:8001` → http://127.0.0.1:18081 初始化 admin、配 Provider（供应商真实 key 只在这里）/ Consumer `mindbase-backend`(BEARER) / 路由 `/v1`、`/api/v1`、`/api-ws`；**modelMapping 保持空透传** |
| 网关 consumer key 回填 | 控制台生成的 key 填入 `.env` 的 `AI_GATEWAY__API_KEY` → 重建 mindbase-env Secret → rollout restart deploy/app-ts deploy/app-cloud deploy/app-bili |
| app-pay-admin | `kubectl -n mind-base port-forward svc/app-pay-admin 8003:8003` → https://127.0.0.1:8003（种子账户 admin / app-pay-admin，首登改密） |
| 入口地址 | nginx Service 是 LoadBalancer：本地集群直接用分配的地址；云上绑域名 + 正式证书（更新 nginx-tls Secret 后 restart nginx） |

## 4. 与 docker-compose 的差异（有意为之）

| 项 | compose | k8s |
|----|---------|-----|
| app-pay-test / 测试 MySQL | `--profile pay-test` | **未移植**（测试实例与生产隔离的诉求在 k8s 下应另起 namespace） |
| redis-commander / mongo-express | `--profile tools` | **未移植**（用 port-forward + 本地工具替代） |
| app-board 证书共享 | 宿主目录 `./app-board/certs` 双挂载 | **Secret `app-board-certs`**：server.crt/server.key 给 app-board，dev-ca.crt 给 apisix——确定性高于自动生成；证书轮换 = 更新 Secret + 重启两服务 |
| app-pay TLS | 宿主目录 `./app-pay/certs` | Secret `app-pay-tls`（ca.crt 同时供 app-task 委托回调校验） |
| MySQL 建表脚本 | 宿主 `db/system.sql` | ConfigMap `mysql-init-sql`（§1b kubectl 创建，改 SQL 后重建 + restart mysql） |
| APISIX 路由 | 宿主 `apisix/*.yaml` | ConfigMap `apisix-config`（subPath 挂载；改路由后重建 ConfigMap + `rollout restart deploy/apisix`） |
| nginx 配置 | 宿主 `nginx/*.conf` | ConfigMap `nginx-conf`（subPath；同上 restart） |
| Higress 版本 | `:latest` + 可选 digest 钉死 | 同左；生产建议把 Deployment 的 image 改成 `@sha256:` 钉死 |
| 数据持久化 | named volumes | PVC（mysql 10Gi×3、mongo 10Gi、redis 5Gi、etcd 5Gi、minio 20Gi、milvus 20Gi、neo4j 10Gi、higress 5Gi）；服务日志与 nginx 缓存为 emptyDir |
| 环境变量分层 | `env_file: .env` + compose `${VAR:-default}` | envFrom 两层（见 §1c）；`$(VAR)` 派生改 in-list 模式 |

探针语义与 compose healthcheck 一致（mysqladmin ping / mongosh ping /
redis-cli ping / etcdctl endpoint health / minio health/live / backend /health）；
无 HTTP 健康端点的 TLS 服务（app-pay/app-board/app-pay-admin）用 tcpSocket 探活；
app-kg 的健康端点在独立端口 8014（gRPC 数据面 8013）。

## 5. 日常运维

```bash
# 看状态
kubectl -n mind-base get pods,svc,pvc
# 日志
kubectl -n mind-base logs deploy/app-ts -f
# 改 APISIX 路由：编辑 apisix/apisix.yaml 后
kubectl apply -k deploy/k8s && kubectl -n mind-base rollout restart deploy/apisix
# 扩容 app-ts（无状态，可扩；注意 Milvus/DB 连接数与任务账本并发）
kubectl -n mind-base scale deploy/app-ts --replicas=2
```

## 6. 未覆盖（后续按需）

- HPA / PDB、网络策略（NetworkPolicy 限制 DB 仅被应用访问）、
  cert-manager 自动证书、Prometheus 监控、备份（PVC 快照/CronJob mysqldump）。
- 生产化前的硬性检查：替换所有 `change-me` 占位密钥、Higress 镜像钉 digest、
  nginx 正式证书、MySQL 关闭 root 远程。

## 7. 节点分工：数据层钉 database 节点（node-split overlay）

3 节点（1 control-plane + worker + database）的分工调度：

1. database 节点打污点（一次性，先于首次 apply）——应用 Pod 不会落上去：

   ```bash
   kubectl taint node <database节点名> dedicated=database:NoSchedule
   ```

2. 数据层走 overlay 钉到 database 节点（自带 toleration）：

   ```bash
   kubectl apply -k deploy/k8s/overlays/node-split
   ```

   覆盖 8 个数据 StatefulSet（mysql / app-task-mysql / app-pay-mysql / mongo /
   redis / etcd / minio / milvus）+ neo4j / higress（带 PVC 的 Deployment）。
   nodeSelector 用 `kubernetes.io/hostname`，换节点时改
   `overlays/node-split/*.yaml` 中的 hostname。

3. 应用层无需 patch：control-plane（内置污点）与 database（第 1 步污点）
   都不可调度，应用自动全部落在带 `node-role.kubernetes.io/worker` 标签的
   worker 节点上；未来扩 worker 时打同样的 worker 标签即可参与调度。

⚠️ local-path 的 PVC 数据绑定在**首次调度到的节点**——污点与 overlay 必须在
首次 `apply` 之前就位，起错了要删 PVC 重建才能搬家。

MetalLB（nginx LoadBalancer Service 的实现，kubeadm 裸集群默认无人认领）：
安装本体后 `kubectl apply -f deploy/k8s/metallb.yaml`（文件头有说明）。

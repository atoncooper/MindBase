# deploy/config — 生产级组件配置（非密钥）

本目录是第三方基础设施组件（etcd / Redis / MySQL / MongoDB / Milvus）的**唯一服务端配置源**，
供 `docker-compose.yml`、`deploy/docker`、`deploy/china`、`deploy/swarm`、`deploy/k8s`
只读挂载；K8s 用同一份文件生成 ConfigMap，避免两处维护。**只保留生产形态**（无 dev/client 档）。

## 边界（强约束）

- ❌ 密钥/口令/含密码 DSN 不进本目录：口令在 `.env`（compose env / K8s Secret）。
- ❌ 第一方服务配置不在这里（各服务 `default.yaml`；APISIX `apisix/`；nginx `nginx/`）。
- ✅ 硬化、持久化、日志/慢查询、TLS、以及 **容量参数**（buffer pool / cache / maxmemory / 连接数）都在这里。
- ✅ 容量参数不写死：由各组件的 `entrypoint-autosize.sh` 按 **容器 cgroup 内存上限 + CPU 核数**
  推导，启动时生成/渲染最终配置；容器资源上限在 compose/K8s 里显式声明。

## 容量自动推导（生产标准）

所有脚本读取 cgroup v2（`/sys/fs/cgroup/memory.max`、`cpu.max`），回退 cgroup v1，再回退
`/proc/meminfo`、`/proc/cpuinfo`。启动日志会打印 `[*-autosize] mem=… cpu=… -> …`，便于核对。

| 组件 | 推导规则 | 覆盖环境变量 |
|------|---------|-------------|
| MySQL | buffer pool = 内存 × 50%（<2G）/60%（<8G）/70%（≥8G），至少留 256MB；redo = buffer/4（128M..4G）；buffer instances = 1 或 min(8, buffer/1G)；max_connections = cpu×100（100..500）；io_capacity = cpu×500（400..8000），max=2×；read/write io threads = clamp(cpu,4,16)；thread cache = cpu×8（8..64） → 写 `/etc/mysql/conf.d/99-auto-sizing.cnf` | `MYSQL_BUFFER_POOL_MB`、`MYSQL_MAX_CONNECTIONS`、`MYSQL_AUTOSIZE_DISABLE=1` |
| Redis | maxmemory = 内存 × 70%（≥64MB），预留 max(128MB, 10%)；策略 **noeviction**（会话/配额预占宁可写失败也不驱逐） → 命令行注入 | `REDIS_MAXMEMORY_MB`、`REDIS_MAXMEMORY_POLICY` |
| MongoDB | WiredTiger cacheSizeGB = min(内存 × 50%, 内存-256MB)，下限 0.25、上限 8 → 渲染 `/tmp/mongod.conf`（`MONGO_TLS=1` 启用 requireTLS 段） | `MONGO_CACHE_GB`、`MONGO_TLS=0\|1` |
| etcd | 无自动容量（quota 是磁盘上限不是内存）：生产 8GB quota、periodic 1h 压缩、metrics 2381 | — |
| Milvus | 完整镜像默认配置副本 + MinIO TLS/etcd mTLS 覆盖（保留 Milvus 自身调参） | — |

> 容器内存/CPU 上限示例（compose）：MySQL 4g/2.0、app-pay MySQL 2g/1.0、app-task MySQL 768m/1.0、
> Redis 1g/1.0、MongoDB 1g/1.0、etcd 1g/1.0；K8s 用 `resources.limits`（mysql 1Gi 等）。
> 调整上限后只需重启组件，脚本自动重新推导，**无需改配置文件**。

## 文件与挂载契约

| 文件 | 挂载点 | 启动方式 |
|------|--------|---------|
| `mysql/conf.d/00-base.cnf` | `/etc/mysql/conf.d/00-base.cnf` | 官方镜像自动加载 |
| `mysql/conf.d/10-tls.cnf` | `/etc/mysql/conf.d/10-tls.cnf` | 仅 TLS 实例（require_secure_transport） |
| `mysql/conf.d/95-binlog.cnf` | `/etc/mysql/conf.d/95-binlog.cnf` | 生产必挂（ROW/FULL、7 天保留、sync_binlog=1） |
| `mysql/entrypoint-autosize.sh` | `/opt/mindbase/entrypoint-autosize.sh` | `entrypoint: ["/bin/sh", "..."]`，最后 exec 官方 entrypoint |
| `redis/redis.conf`（TLS）/ `redis.plain.conf`（明文） | `/usr/local/etc/redis/redis.conf` | 由 `entrypoint-autosize.sh` 注入 maxmemory 后 `redis-server <conf>` |
| `redis/entrypoint-autosize.sh` | `/opt/mindbase/entrypoint-autosize.sh` | 同上 |
| `mongodb/mongod.tmpl.conf` | `/opt/mindbase/mongod.tmpl.conf` | `entrypoint-autosize.sh` 渲染为 `/tmp/mongod.conf` 后 `mongod --config` |
| `mongodb/entrypoint-autosize.sh` | `/opt/mindbase/entrypoint-autosize.sh` | 同上 |
| `etcd/etcd.conf.yml`（TLS）/ `etcd.plain.conf.yml`（K8s 集群内明文） | `/etc/etcd/etcd.conf.yml` | `etcd --config-file=...` |
| `milvus/milvus.yaml` | `/milvus/configs/milvus.yaml` | 镜像默认 `milvus run standalone` |
| `minio/README.md` | — | MinIO 无配置文件（env-only），契约见该文件 |

## 各栈使用哪一份

| 栈 | etcd | redis | mysql | mongodb | milvus |
|----|------|-------|-------|---------|--------|
| 根 `docker-compose.yml`（生产全栈） | `etcd.conf.yml`（TLS，8G） | `redis.conf`（TLS） | base + TLS + binlog + autosize | 模板 + autosize（TLS） | `milvus.yaml` |
| `deploy/docker`（拆分） | `etcd.conf.yml`（TLS） | `redis.plain.conf` | base + binlog + autosize | 模板 + autosize（明文） | 镜像默认 |
| `deploy/china` | bitnami env-only（例外） | `redis.plain.conf` | base + binlog + autosize | 模板 + autosize（明文） | 镜像默认 |
| `deploy/swarm` | `etcd.conf.yml`（TLS） | `redis.plain.conf` | base + binlog + autosize | 模板 + autosize（明文） | 镜像默认 |
| `deploy/k8s` | `etcd.plain.conf.yml`（4G） | `redis.plain.conf` | base + binlog + autosize | 模板 + autosize（明文） | 镜像默认 |

## 校验 / 运维

**静态校验（无需启动）**：

```bash
sh -n deploy/config/*/entrypoint-autosize.sh
python -c "import io,yaml,sys;[yaml.safe_load(io.open(f,encoding='utf-8')) for f in sys.argv[1:]]" \
  deploy/config/etcd/*.conf.yml deploy/config/mongodb/mongod.tmpl.conf deploy/config/milvus/milvus.yaml
# compose 引用与挂载文件是否齐全
grep -rhoE '[^ ]*deploy/config[^:]*' docker-compose.yml deploy/*/*.yml | sort -u
```

**启动后冒烟**：

```bash
# 自动-sizing 结果（容器日志）
docker compose logs mysql | grep mysqld-autosize
docker compose logs redis | grep redis-autosize
docker compose logs mongo | grep mongo-autosize
# MySQL
docker compose exec mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e \
  "SHOW VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size','innodb_redo_log_capacity','max_connections','require_secure_transport','log_bin','slow_query_log');"
# Redis（TLS 实例）
docker compose exec redis redis-cli --tls --cacert /certs/dev-ca.crt -a "$REDIS_PASSWORD" -p 6379 CONFIG GET maxmemory maxmemory-policy appendonly
# MongoDB
docker compose exec mongo mongosh --quiet --tls --tlsAllowInvalidCertificates --eval 'db.adminCommand({getCmdLineOpts:1}).parsed'
# etcd
docker compose exec etcd etcdctl --endpoints=https://127.0.0.1:2379 --cacert=/certs/dev-ca.crt --cert=/certs/server.crt --key=/certs/server.key endpoint status -w table
```

**日志与备份**：
- MySQL 慢查询 `/var/lib/mysql/slow.log`（1s 阈值）；binlog `mysql-bin.*` 保留 7 天 →
  **全量备份周期必须 < 7 天**（PITR）。
- Redis AOF `/data/appendonlydir` + RDB `/data/dump.rdb`；备份用 `BGSAVE` 后拷 `dump.rdb`。
- MongoDB slowOp 记录在 `system.profile`；日志走 stdout。
- etcd 备份 `etcdctl snapshot save`（带 mTLS 参数）。

**变更流程**：改文件 → 静态校验 → 预发重启并核对 autosize 日志 → 生产滚动（MySQL/Mongo
`stop-first`）→ 观察 5~10 分钟错误率/慢查询。

## K8s（同源 ConfigMap）

```bash
kubectl -n mind-base create configmap mysql-conf \
  --from-file=00-base.cnf=deploy/config/mysql/conf.d/00-base.cnf \
  --from-file=95-binlog.cnf=deploy/config/mysql/conf.d/95-binlog.cnf \
  --from-file=entrypoint.sh=deploy/config/mysql/entrypoint-autosize.sh
kubectl -n mind-base create configmap mongo-conf \
  --from-file=mongod.tmpl.conf=deploy/config/mongodb/mongod.tmpl.conf \
  --from-file=entrypoint.sh=deploy/config/mongodb/entrypoint-autosize.sh
kubectl -n mind-base create configmap redis-conf \
  --from-file=redis.conf=deploy/config/redis/redis.plain.conf \
  --from-file=entrypoint.sh=deploy/config/redis/entrypoint-autosize.sh
kubectl -n mind-base create configmap etcd-conf \
  --from-file=etcd.conf.yml=deploy/config/etcd/etcd.plain.conf.yml
```

Pod 的 cgroup 上限来自 StatefulSet `resources.limits`，entrypoint 在启动时自动推导容量；
更新配置后重跑 apply + `kubectl rollout restart statefulset/<name>`。

## 例外（保留 env / 镜像默认）

- **Neo4j**：官方镜像 entrypoint 按 `NEO4J_*` env 生成/追加 `neo4j.conf`，挂只读配置与其
  初始化逻辑冲突；Bolt TLS 是官方推荐 env 方式。
- **MinIO**：无配置文件（见 `minio/README.md`）。
- **deploy/china 的 bitnami etcd**：镜像只认 `ETCD_*` env。
- **Higress**：配置持久化在 `data/higress` 数据目录（控制台管理）。
- **deploy/docker、china、swarm、K8s 的 MongoDB/Milvus 数据层 TLS** 尚未同步（见 docs/tls.md §6）。

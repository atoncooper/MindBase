# 客户端部署（docker-compose.client.yml）

> 单人客户端最小化 compose：服务端根 [docker-compose.yml](../docker-compose.yml) 的裁剪+调参变体。
> 同一份代码、同一份 `.env`、同一镜像模型（first-party 镜像本地构建，绝不自动拉 Hub）。

## 与服务端 compose 的差异

| 维度 | 服务端（根 compose） | 客户端（本文件） |
|------|--------------------|----------------|
| 默认服务数 | ~25（含 pay/task/kg 三套独立栈） | 20（核心常驻，其余 opt-in） |
| app-pay + app-pay-mysql | 默认启动 | `--profile pay` |
| app-task + app-task-mysql | 默认启动 | `--profile task` |
| neo4j + app-kg | 默认启动 | `--profile kg` |
| Higress | `--profile ai` | `--profile ai`（默认改为**直连供应商**） |
| 3 套 MySQL 实例 | 主 + task + pay | 只留主库（按需 opt-in 另外两套） |
| Milvus / etcd | 无内存上限；独立 etcd 容器（4GB 配额） | Milvus 上限 1.5GB；**etcd 容器已砍**（内嵌 etcd，元数据落 milvus_data 卷） |
| MySQL | 默认参数 | performance_schema/binlog/mysqlx 关，buffer pool 128M，60 连接 |
| Mongo | WiredTiger 默认（随宿主内存膨胀） | 缓存压到 256MB |
| Redis | 256MB | 128MB |
| MinIO | 含控制台 + 9001 端口 | `MINIO_BROWSER=off`，不映射宿主端口 |
| APISIX | worker = CPU 核数 | 固定 1 worker（`apisix/config.client.yaml`） |
| 数据面端口 | 部分对公网（mysql/redis/mongo） | 全部 `127.0.0.1`，对外只留 nginx 80/443 |
| 日志 | 无轮转约束 | json-file 10MB × 3 全服务轮转 |
| 典型常驻内存 | ~7–9GB | **~2.5–3GB**（上限合计 ~5.7GB） |

> 核心服务**没有** `profiles` 键，因此 `docker compose -f docker-compose.client.yml --profile kg up -d` 会同时启动核心 + kg（根 compose 的 `""` profile 语义不同：加 `--profile` 反而会停掉核心服务）。

> ⚠️ **与服务端栈互斥**：客户端 compose 用独立项目名 `mindbase-client`（compose 顶层 `name:`），
> 卷/容器与服务端（project `mindbase`）彻底隔离——绝不能在同一目录用同一项目名跑两份 compose，
> 否则 `up -d <同名服务>` 会直接重建服务端正在运行的容器（真实发生过）。
> 即便隔离了项目名，两栈仍不可同时运行：`container_name` 与宿主端口相同；切换时先
> `docker compose down`（当前栈）再 up 另一个。

## 快速开始

前置：本仓完整 clone、`.env`（可从服务端拷贝后改）、`secrets/api_key_encryption_key`
（app-auth/app-cloud/app-bili 解密用户 SESSDATA 用；服务端拷贝或 `openssl rand -base64 32` 生成，
**一旦存了用户数据不可换**）、Docker Desktop（WSL2 后端）。

```bash
# 首次：构建全部 first-party 镜像（frontend/app-ts/8 个 Go 服务/3 个 MCP/minio/certgen）
docker compose -f docker-compose.client.yml build

# 启动核心栈
docker compose -f docker-compose.client.yml up -d

# 浏览器打开 https://localhost（或 http://localhost），登录即用
```

可选功能（与核心同时启动）：

```bash
docker compose -f docker-compose.client.yml --profile kg up -d    # KG 图谱
docker compose -f docker-compose.client.yml --profile pay up -d   # 会员/支付
docker compose -f docker-compose.client.yml --profile task up -d  # 定时出题
docker compose -f docker-compose.client.yml --profile ai up -d    # Higress AI 网关
docker compose -f docker-compose.client.yml --profile tools up -d # 调试 UI
```

## AI 请求出口：直连模式（默认）

客户端默认**不部署 Higress**，LLM/embedding/ASR 直连供应商——单人客户端把供应商 key
放在本机 `.env` 是可接受的（服务端"key 只在网关"的红线针对公网部署，不进 git 即可）：

```bash
# .env（二选一）
# —— DashScope（LLM/embedding 兼容口 + ASR 原生口）——
AI_GATEWAY__API_KEY=sk-xxxx
AI_GATEWAY__BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_GATEWAY_NATIVE_BASE_URL=https://dashscope.aliyuncs.com/api/v1   # app-bili ASR 用
# —— 或 OpenRouter（LLM/embedding；ASR 仍需 DashScope 直连口）——
# AI_GATEWAY__BASE_URL=https://openrouter.ai/api/v1
```

- `AI_GATEWAY__BASE_URL`：OpenAI 兼容口，app-ts（LLM/embedding/OCR）与 app-cloud（向量化）使用。
- `AI_GATEWAY_NATIVE_BASE_URL`：客户端新增的插值变量，仅 app-bili 的 ASR 原生透传使用；
  未设置时默认 `http://higress:8080/api/v1`（`--profile ai` 形态）。
- 改 embedding 模型 = Milvus 全量重建（红线同服务端）。
- 用回 Higress（`--profile ai`）：删掉 `.env` 里上面几行覆盖，密钥在网关控制台
  （http://127.0.0.1:18081，客户端已只绑回环）配置。

## 裁剪后的降级行为

| 不启动 | 影响 |
|--------|------|
| app-pay（默认） | 会员/支付页不可用；app-ts 会员档位 fail-open = free；app-cloud 配额同。**聊天/RAG/笔记/云盘不受影响** |
| app-task（默认） | 定时出题邮件任务不跑；聊天内出题/批改、task-quiz 手动流程正常 |
| neo4j + app-kg（默认） | app-ts 以 `KG__ENABLED=false` 清洁禁用 KG（不注册 kg_search，无 gRPC 重试噪音）；app-cloud L1 文档路由降级 Mongo 匹配；图谱/盲区页不可用 |
| Higress（默认） | AI 请求直连供应商（见上节） |

启用 kg profile 时在 `.env` 追加：
```bash
KG__ENABLED=true
KG_GRPC__ENABLED=true
APP_CLOUD_KG_BASE_URL=http://app-kg:8014
```

## 中间件去留清单（为什么不能再砍）

| 中间件 | 去留 | 原因 |
|--------|------|------|
| etcd | ✂️ **已砍** | 只有 Milvus 用它 → Milvus 2.6 内嵌 etcd（见下节），省一个容器 ~100MB |
| Higress | ✂️ 默认不启 | AI 请求直连供应商（`--profile ai` 可回网关模式） |
| app-pay / app-task / neo4j+app-kg 两套 MySQL | ✂️ 默认不启 | 单人用不到支付/定时任务/KG（`--profile` 按需开） |
| **APISIX** | ❌ 必须留 | 唯一路由权威：apisix.yaml 1139 行 ~35 条路由，承载 forward-auth（bili_session → X-Uid）+ key-auth（/internal/* M2M）。砍它 = 把全部路由+鉴权语义移植进 nginx（双份维护，登录/聊天必炸），省的 ~100MB 不值 |
| **nginx** | ❌ 必须留 | RSS 仅 ~15MB，却承载：`/minio-proxy` 预签名媒体代理、`/cloud-stream` 视频流缓存（X-Accel-Redirect internal 跳转，APISIX 无法复制其 internal-only 语义）、`/cloud/` 5GB 直传（绕开网关 body-limit）、页面/XHR 双用途分发、TLS。砍掉后这些流量全部改道 Node/网关，内存不降反升且功能必坏 |
| **Redis** | ❌ 必须留 | 承载 MinIO 事件 → 向量化管道（云盘自动向量化）、app-auth 验证码/限流、board 读缓存；仅 ~130MB，砍掉 = 改代码 |
| **MinIO** | ❌ 必须留 | Milvus 对象存储 + 云盘 + skills + 壁纸的存储本体（功能承载者，非纯中间件） |
| MySQL / MongoDB | ❌ 必须留 | 数据层，砍掉 = 重写所有服务 |

## Milvus 内嵌 etcd（本次新增的关键裁剪）

`docker-compose.client.yml` 的 milvus 服务带三个环境变量：

```yaml
- DEPLOY_MODE=STANDALONE          # ⚠️ 必须显式设置（大小写敏感）
- ETCD_USE_EMBED=true
- ETCD_DATA_DIR=/var/lib/milvus/etcdData   # 落在 milvus_data 卷内，持久化
```

- 已在 milvusdb/milvus:**v2.6.22** 实测：正常启动、`/healthz` OK、
  query coordinator 成功连上内嵌 etcd、空库 RSS ~152MB。
- **`DEPLOY_MODE` 的坑**：Milvus 在 Go 包初始化期读 `DEPLOY_MODE`
  （`metricsinfo.DeployModeEnvKey`），未设置时视为分布式模式，直接
  `panic: embedded etcd can not be used under distributed mode`。漏配只会看到
  milvus 反复重启，先查这个变量。
- **回退**：内嵌 etcd 异常时，把 milvus 的 `ETCD_USE_EMBED` 改 `false`、加回
  `ETCD_ENDPOINTS=etcd:2379`，再取消 compose 里注释掉的 `etcd` 服务块并
  `up -d etcd`（先于 milvus 起来）。
- **从服务端迁移元数据的坑**：服务端 Milvus 的集合/字段元数据存在**服务端 etcd 容器**
  的 `etcd_data` 卷里（不在 milvus_data 里）。直接搬 milvus_data 会让客户端 Milvus
  元数据为空 → 向量对象虽在 minio_data 但 collection 定义丢失。迁移元数据：

  ```bash
  # 服务端（在 etcd 容器内做快照）
  docker exec mind-base-etcd etcdctl snapshot save /etcd/snapshot.db
  docker cp mind-base-etcd:/etcd/snapshot.db ./snapshot.db
  # 客户端（milvus 停止状态下，恢复进 milvus_data 卷的 etcdData 目录）
  docker run --rm -v mindbase-client_milvus_data:/v -v .:/b quay.io/coreos/etcd:v3.5.14 \
    etcdctl snapshot restore --data-dir=/v/etcdData --skip-hash-check /b/snapshot.db
  ```

  单人库若规模不大、重建向量化成本低，也可以不迁元数据——在客户端重建 collection
  并重跑向量化（minio_data 里的 ASR 文本仍在，重跑的是 embedding 代价）。

## 内存调参旋钮（.env）

| 变量 | 默认 | 说明 |
|------|------|------|
| `MILVUS_MEM_LIMIT` | `1536m` | 全栈最大头；全量重建/大集合 OOM 时调大 |
| `APP_TS_MEM_LIMIT` / `APP_TS_NODE_HEAP` | `640m` / `512` | agent/RAG 进程 cgroup 上限 / V8 堆上限 |
| `MYSQL_MEM_LIMIT` | `512m` | 主库上限 |
| `MONGO_MEM_LIMIT` | `384m` | WiredTiger 已另压到 256MB 缓存 |
| `MINIO_MEM_LIMIT` | `512m` | 大文件分块上传峰值留量 |
| `APP_PAY_MEM_LIMIT` | `512m` | JVM heap = 60% × 上限（MaxRAMPercentage） |
| `NEO4J_MEM_LIMIT` | `512m` | heap 350M + pagecache 128M |
| `HIGRESS_MEM_LIMIT` | `1536m` | 仅 `--profile ai` |
| `NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT` | `80` / `443` | 宿主端口被占时改 |

实测参考（服务端栈同宿主 docker stats 冷态值）：apisix 294MB（服务端 auto-worker）→ 客户端
1 worker 约 100–150MB；mysql 446MB（默认参数）→ 客户端关 P_S/binlog 后约 250–350MB；
mongo 260MB、minio 68MB、app-ts 223MB、frontend 80MB、redis ~10MB、nginx ~23MB、
milvus 空库 152MB（随向量数据增长，上限 1.5GB）；6 个 Go 服务合计 ~100MB、3 个 MCP 合计 ~20MB。
**客户端核心栈典型合计 ≈ 1.5–2.5GB**。被砍掉不再常驻的实测值：higress 567MB、neo4j 465MB、
app-pay 321MB、两个附加 MySQL 共 926MB、etcd 59MB（服务端全家桶合计约 4GB+）。
原估计（已被上表实测取代）：mysql ~350MB、mongo ~300MB、milvus 0.5–1.5GB（含内嵌 etcd）、
minio ~150MB、apisix ~100MB（1 worker）、app-ts ~400MB、frontend ~250MB、
6 个 Go 服务 ~250MB、3 个 MCP ~80MB、redis ~130MB、nginx ~15MB。

## 从服务端迁移数据

卷名前缀 = compose 项目名：服务端 `mindbase_*`，客户端（独立项目名）`mindbase-client_*`。
数据全在 named volumes，按卷 tar 打包搬运（示例：主库 MySQL；Mongo/MinIO 同理）：

```bash
# 服务端导出
docker run --rm -v mindbase_mysql_data:/d -v /backup:/b alpine tar czf /b/mysql.tgz -C /d .
# ...对 mindbase_mongo_data / mindbase_minio_data 同理
# 客户端导入（先 up 过一次让 mindbase-client_* 卷存在）
docker run --rm -v mindbase-client_mysql_data:/d -v /backup:/b alpine sh -c "cd /d && tar xzf /b/mysql.tgz"
```

Redis 不建议迁移（captcha/事件桥，短暂态）。
**Milvus 向量数据要分两半迁**：向量对象在 `mindbase_minio_data`（照常 tar 搬运），
但集合/字段**元数据在服务端 etcd 容器的 `mindbase_etcd_data` 卷里**——客户端已改用
内嵌 etcd，直接搬 milvus_data 不会带回元数据，必须做 etcd 快照恢复（见上节
「Milvus 内嵌 etcd」的迁移说明），否则 collection 定义丢失、只能重建向量库。

## Windows / Docker Desktop 提示

- WSL2 全局内存上限可在 `%UserProfile%\.wslconfig` 里限：`[wsl2]` `memory=6GB`，
  配合本文件的 per-container 上限形成双保险。
- 宿主 80/443 若被 IIS 等占用，改 `NGINX_HTTP_PORT`/`NGINX_HTTPS_PORT`。
- 本文件与根 compose 的 **APISIX 路由面（apisix/apisix.yaml）完全共用**；config 用
  客户端变体 `apisix/config.client.yaml`（与服务端 config.yaml 唯一差异是 worker 数），
  改路由只需维护一份。

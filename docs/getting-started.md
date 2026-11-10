# 本地开发入门（Getting Started）

在本地把 MindBase 跑起来并开始改代码。本文只讲**开发环境**：前置依赖、`.env` 配置、两条启动路径（容器起基础设施 + 本地跑应用 / 全 Docker）、验证链路、测试与常见问题。

> **技术栈现状**：AI 域在 **app-ts**（Node + Fastify + tsx，端口 8000）；业务 CRUD 在 **app-go/** 下的 Go 微服务（app-user〔auth/bili/settings 三域合一〕/ app-content〔note/quiz/board 三域合一〕/ cloud / kg / admin）、**app-pay**（Java 21 / Spring Boot，HTTPS-only）、**app-task**（独立仓库镜像）；沙箱控制层是 **app-go/app-sandbox**；前端是 **frontendv2/**（Next.js 16）与 **frontend-admin/**（Vite + React + antd）。
> 旧 Python backend（`app/`）已于 2026-10-06 彻底退役，任何 `pip install` / `uvicorn app.main:app` / `app/config/default.yaml` 的说法都已失效。
>
> 服务清单、端口、网关路由以 [architecture.md](architecture.md) 为权威；配置体系（各服务 YAML / env 前缀 / 密钥清单）见 [configuration.md](configuration.md)；生产部署见 [deployment.md](deployment.md)。

---

## 1. 前置依赖

| 工具 | 版本 / 要求 | 用途与核对方式 |
|------|------------|----------------|
| Git | 2.x | 拉代码 |
| Node.js | **≥ 22.17**（`app-ts/package.json` 的 `engines`；CI 用 Node 22） | app-ts、frontendv2、frontend-admin |
| npm | 随 Node 提供 | app-ts / frontendv2 依赖安装 |
| pnpm | 任意近期版本（`corepack enable` 即可） | 仅 frontend-admin（有 `pnpm-lock.yaml`） |
| Go | **1.25+**（`app-go/*/go.mod`；`app-sandbox` 为 1.24） | app-go 各服务（含内容域 MCP server `app-content-mcp`） |
| Java + Maven | **JDK 21** + Maven 3.9+ | 仅 app-pay（`pom.xml` `java.version=21`） |
| Docker + Compose | Docker Engine/Desktop，**Compose v2**（`docker compose version`） | 基础设施与全栈启动 |
| ffmpeg / ffprobe | 任意近期版本 | **仅本地直跑 app-user（bili 路由）做 ASR 时需要**；容器镜像已内置静态 ffmpeg |
| openssl | 任意近期版本 | 生成主密钥文件（本地跑 app-pay 时也用它生成 HTTPS 证书） |

> 你不需要在本机装 MySQL / Mongo / Redis / Milvus / MinIO / Neo4j / APISIX：它们都跑在容器里。
> Windows 建议 Docker Desktop + WSL2 后端；下文命令以 bash 为例，PowerShell 差异见 §2.2 与 §3.3。

---

## 2. 第一次配置

### 2.1 拉代码

```bash
git clone https://github.com/atoncooper/MindBase.git
cd MindBase
```

### 2.2 `.env` 与主密钥文件

```bash
cp .env.example .env
mkdir -p secrets
openssl rand -base64 32 > secrets/api_key_encryption_key
```

PowerShell：

```powershell
Copy-Item .env.example .env
New-Item -ItemType Directory -Force secrets | Out-Null
openssl rand -base64 32 | Out-File -Encoding ascii secrets/api_key_encryption_key
```

规则（详见 [configuration.md](configuration.md)）：`.env` **只放密钥 / 含凭证的连接串**（`secrets/` 已 gitignored）；开关、模型名、超时、并发等普通配置进各服务自己的 YAML。变量名用双下划线嵌套（`MINIO__ACCESS_KEY` → `minio.access_key`）。

### 2.3 必填项

| 项 | 说明 |
|----|------|
| `secrets/api_key_encryption_key` | app-user（auth/bili 域）/ app-cloud 共用的用户凭证加密主密钥（一行 base64）。**不是**环境变量文件内容，而是独立密钥文件；compose 把它挂到 `/run/secrets/`。文件缺失时容器会反复重启（Docker 会把缺失的绑定源建成目录），日志报读取失败。**部署后不可更换**，否则已加密数据无法解密。 |
| `APISIX_CONSUMER_KEY` | 服务间 key-auth 共享密钥。compose 强制要求（未设置直接报错 `err_APISIX_CONSUMER_KEY_not_set_in_.env`）。**唯一来源是 `.env`**：APISIX 容器启动时由 `apisix/render-config.sh` 把它渲染进 `apisix.yaml`（模板 `apisix/apisix.yaml.template` 只含占位符，standalone 模式不读 env 由渲染补齐）。轮换 = 改 `.env` 后重启 apisix。 |
| `AI_GATEWAY__API_KEY` | 平台 AI 出网凭证（LLM / embedding / OCR）。用 `--profile ai` 的 Higress 时填 Higress consumer `mindbase-backend` 的 key（在网关控制台 `http://127.0.0.1:18081` 配置，详见 configuration.md）；不用 Higress 时可直接填供应商 key，并把 `AI_GATEWAY__BASE_URL` 指向供应商的 OpenAI 兼容口。**留空时 app-user（bili 路由）会启动失败**（`asr.api_key` 必填），app-ts 的 AI 调用也会在调用时报错。 |

### 2.4 按需开启的可选项

| 变量 | 作用 |
|------|------|
| `APPTASK_EMAIL_API_KEY` | 定时出题邮件（Resend）；为空时邮件 worker 走 dry-run |
| `PAY_OPS_KEY` | 可选；app-admin「退款复核」经 APISIX pay-ops consumer 调 app-pay 资金写端点，留空则该页 404 隐藏 |
| `SANDBOX_ADMIN_TOKEN` | app-admin 的沙箱管理代理令牌（与 app-sandbox `SANDBOX__ADMIN__TOKEN` 同值） |
| `APP_CLOUD_ADMIN_REVIEW_TOKEN` | 管理后台「分享内容受控预览」（app-admin ↔ app-cloud 同值） |
| `TAVILY_API_KEY` / `SEARXNG_URL` | `web_search` 的优质搜索源（不配只剩爬虫兜底） |
| `DEEPSEEK_API_KEY` | DeepSeek 官方网页搜索/抓取 |
| `LANGSMITH_API_KEY` 等 | LLM 链路追踪（SDK 直接读 env，全组设置才生效） |
| `CONTENT_MCP_UID` / `CONTENT_MCP_AUTH_TOKEN` | 外部 MCP 宿主连接 app-content-mcp（8019）用（app-ts 服务模式不需要） |

---

## 3. 路径 A（推荐）：容器起后端，本地跑 app-ts / frontendv2

适合日常改 AI 域或前端：基础设施与 Go 服务跑容器，app-ts 与 frontendv2 在本机热重载。

### 3.1 启动全栈（然后让出 8000 / 3000）

```bash
docker compose up -d --build   # 首次会构建 first-party 镜像，几分钟
docker compose ps              # 全部 running / healthy 再继续
docker compose stop app-ts frontend
```

说明：裸 `docker compose up -d` 就是全栈（见 §4）。停掉 `app-ts` / `frontend` 只是把 8000 / 3000 端口让给本地进程；其余 Go 服务、MCP server、网关、存储继续跑在容器里，正好是本地 app-ts 的外部依赖。

### 3.2 让宿主能访问 APISIX(:9080) 与 MinIO(:9000)

默认 compose **不把 APISIX 和 MinIO 的 API 端口映射到宿主**（只走容器网络与 nginx）。但本地 app-ts 的出站调用（app-task / app-pay / app-content / 沙箱）走 `127.0.0.1:9080`，frontendv2 的 dev 代理也指向 `localhost:9080`，所以本地开发要加一个 override：

```yaml
# docker-compose.override.yml —— 本地开发用，不要提交
services:
  apisix:
    ports:
      - "127.0.0.1:9080:9080"
  minio:
    ports:
      - "127.0.0.1:9000:9000"
```

`docker compose` 会自动合并同目录下的 `docker-compose.override.yml`；生效：

```bash
docker compose up -d apisix minio
```

（compose 对 `ports` 是合并语义，MinIO 控制台 9001 不会丢。）

### 3.3 本地跑 app-ts

app-ts **不会自己读 `.env`**（compose 里是 `env_file` 注入），本地启动前要把变量导入当前 shell：

```bash
cd app-ts
npm ci

# 连接串 / 密钥（值取自 compose 内置默认值与 .env）
export MONGO__URI='mongodb://admin:mind-base@127.0.0.1:27017/?authSource=admin'
export REDIS__URL='redis://:mind-base@127.0.0.1:6379/1'
export MINIO__ENDPOINT='http://127.0.0.1:9000'
export MINIO__ACCESS_KEY=minioadmin
export MINIO__SECRET_KEY=minioadmin
export MINIO__BUCKET=drive-videos
export APISIX_CONSUMER_KEY='<与 .env 同一 key；APISIX 启动时渲染进 apisix.yaml>'
export AI_GATEWAY__BASE_URL='http://127.0.0.1:18080/v1'   # 用 --profile ai 起的 Higress；或供应商兼容口
export AI_GATEWAY__API_KEY='<key>'

npm run dev    # tsx watch，监听 127.0.0.1:8000
```

PowerShell 里把 `export KEY='value'` 换成 `$env:KEY='value'`（逐条执行），其余步骤相同。

- `MILVUS__ADDRESS` 默认就是 `127.0.0.1:19530`（`app-ts/config/default.yaml`），正好命中容器映射，通常不用设。
- `KG_GRPC__TARGET` 默认 `127.0.0.1:8013`，app-kg 容器也映射了 8013，本地 app-ts 可直接用 KG。
- 内容域 MCP server（`app-content-mcp`）的默认地址是 `127.0.0.1:8019/mcp`，容器已映射，无需改。本地 app-ts 若要用 note/quiz/board 工具，对应 `CONTENT_MCP__URL=http://127.0.0.1:8019/mcp`（默认值已如此）。
- 缺少 `MONGO__URI` / `REDIS__URL` / `MINIO__ENDPOINT` 时对应能力**显式降级**（会话落内存、不订阅事件、skills 关闭），启动不会崩；需要持久化就按上面导出。
- 个人非敏感覆盖可写 `app-ts/config/local.yaml`（gitignored），优先级高于 `default.yaml`。

### 3.4 本地跑 frontendv2

```bash
cd frontendv2
npm ci
npm run dev     # http://localhost:3000
```

开发模式由 `next.config.ts` 的 rewrites 把 API 请求转发到 `NEXT_PUBLIC_APISIX_HOST`（默认 `localhost:9080`），所以需要 §3.2 的 9080 映射且 apisix 在跑；`/minio-proxy/` 媒体代理默认指向 `http://localhost`（即 compose nginx :80）。需要换目标时：

```bash
NEXT_PUBLIC_APISIX_HOST=127.0.0.1:9080 npm run dev
```

### 3.5 本地跑某个 Go 服务

**每个 `app-go/*` 都是独立 Go module**（仓库根没有 `go.mod`/`go.work`），必须进入服务目录启动；服务会从工作目录向上读项目根 `.env`：

```bash
docker compose stop app-content     # 停容器后再本地起（单端口 8004 HTTPS，宿主调试口 APP_CONTENT_PORT）
cd app-go/app-content
CONTENT__DATABASE__MYSQL__URL='mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base' \
CONTENT__DATABASE__MONGO__URI='mongodb://admin:mind-base@127.0.0.1:27017/?authSource=admin' \
CONTENT__DATABASE__REDIS__URL='redis://:mind-base@127.0.0.1:6379/1' \
go run ./cmd/app-content
```

各服务的 MySQL 连接串是**带服务前缀**的变量（共享的 `MONGO__URI`/`REDIS__URL`/`MINIO__*`/`AI_GATEWAY__*` 才无前缀）。`Validate` 会在缺必填项时报错，按报错文案补即可：

| 服务 | 端口 | 本地启动必填 |
|------|------|--------------|
| app-user | 8006（auth）/ 8006（auth/bili/settings 单 listener） | `APPAUTH__RDBMS__URL` + `APPBILI__RDBMS__URL` + `AI_GATEWAY__API_KEY` + `APPSETTINGS__RDBMS__URL`；本地 ASR 需 `ffmpeg`/`ffprobe` 在 PATH |
| app-cloud | 8007 | `APPCLOUD__RDBMS__URL` + `MINIO__ACCESS_KEY`/`MINIO__SECRET_KEY`（缺访问密钥直接拒启；另需 `MINIO__ENDPOINT=http://127.0.0.1:9000`） |
| app-content | 8004（HTTPS，单端口承载 board/note/quiz） | `CONTENT__DATABASE__MYSQL__URL` + `CONTENT__DATABASE__MONGO__URI`（Redis 可选；旧 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__` 数据源变量兼容但必须一致） |
| app-kg | 8013 gRPC / 8014 health | `APPKG__RDBMS__URL` + `KG__URI`（+ `KG__PASSWORD` 或 `NEO4J_PASSWORD`） |
| app-admin | 8016 | `APPADMIN__RDBMS__URL`（种子账户 `admin` / `app-admin`，首登强制改密） |
| app-sandbox | 8017 | `SANDBOX__DATABASE__DSN`（或 `RDBMS__URL`）+ `SANDBOX__AUTH__API_KEY`；本机无 OpenSandbox 时用 `SANDBOX__RUNTIME__TYPE=fake` |

不适合本地直跑、建议直接用容器的：

- **app-pay**（Java）：`cd app-pay && mvn spring-boot:run`，但服务端强制 HTTPS，先跑 `app-pay/scripts/gen-dev-cert.ps1`（或 `.sh`）生成 `app-pay/certs/`；
- **app-task**：本仓无源码（镜像来自独立仓库），compose 默认拉取；
- **app-content**（8004，单端口 HTTPS）：宿主调试口 `APP_CONTENT_PORT`；三域 AI 操作经 app-content-mcp（8019 单端点）访问。

---

## 4. 路径 B：全 Docker

```bash
docker compose up -d --build
docker compose ps
```

首次会构建 frontend / app-ts / 各 Go 服务 / app-content-mcp / certgen / minio 等镜像，需要几分钟；`cert-gen` 会一次性生成 nginx / app-content / app-content-mcp / app-pay 的开发证书，无需手工准备 TLS。

### 4.1 profile 的真实语义

用 `docker compose config --services` 实测（服务带 `profiles: [""]` 表示属于默认集合）：

| 命令 | 实际启动 |
|------|----------|
| `docker compose up -d` | **23 个服务 = 全栈**：frontend / nginx / apisix / etcd / mysql / mongo / redis / milvus / neo4j / minio / app-ts / app-user / app-cloud / app-content / app-kg / app-admin(+api) / app-content-mcp / app-task(+独立 MySQL) / app-pay(+独立 MySQL) |
| `docker compose --profile full up -d` | **30 个服务**：全栈 + higress + app-sandbox + opensandbox-server + app-pay-test(+MySQL) + redis-commander / mongo-express（管理台默认已含支付运营） |
| `docker compose --profile ai up -d` | 只有 5 个：higress + mysql/mongo/redis + cert-gen |
| `docker compose --profile sandbox up -d` | 只有 6 个：app-sandbox + opensandbox-server + mysql/mongo/redis + cert-gen |

**结论**：单独传 `--profile X` 会**排除默认全栈**。要在已运行的全栈上追加可选组件，分两步：

```bash
docker compose up -d                              # 先起全栈
docker compose --profile ai up -d                 # 再追加 Higress（不动已在跑的服务）
docker compose --profile sandbox up -d            # 再追加沙箱控制层
```

或一次到底：`docker compose --profile full up -d`。注意加了 `--profile sandbox` 后 app-ts 仍需 `SANDBOX_ENABLED=true` 才会启用 `run_code`（见 §7）。

### 4.2 本地入口

| 入口 | 地址 | 说明 |
|------|------|------|
| 用户端（nginx） | http://localhost ／ https://localhost | 统一入口；443 用开发 CA 自签证书 |
| 用户端（frontend 容器直连） | http://localhost:3000 | compose `frontend` 服务 |
| 管理后台 UI | http://127.0.0.1:3001 | app-admin 静态站（分享审核 / 用户 / 沙箱 / 支付运营 / 账户 / 审计），同源代理 `/api` 到 8016 |
| 管理后台 API | http://127.0.0.1:8016 | 仅回环，不经 APISIX |
| app-task 控制台 | http://127.0.0.1:8001/ | 默认账户 `admin` / `app-task-admin`，首登改密 |
| Higress 控制台（`--profile ai`） | http://127.0.0.1:18081 | 配置供应商与 consumer key |
| MinIO 控制台 | http://127.0.0.1:9001 | 默认 `minioadmin` / `minioadmin` |
| Neo4j Browser | http://127.0.0.1:7474 | 密码取 `NEO4J_PASSWORD`（默认 `mind-base`） |

其余服务只在 `127.0.0.1` 暴露调试端口（app-ts 8000、app-user 8006、app-cloud 8007、app-content 8004（单端口 HTTPS）、app-kg 8013/8014、app-sandbox 8017、app-pay 8002 HTTPS、app-content-mcp 8019）；**APISIX 不映射宿主端口**，业务流量一律经 nginx 进入。

---

## 5. 验证链路

### 5.1 各服务健康检查

```bash
curl -s http://127.0.0.1:8000/health     # app-ts：{"status":"ok","milvus":{...}}
for p in 8006 8007 8004 8010 8015 8016; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$p/health"
done
curl -s  http://127.0.0.1:8014/health    # app-kg：MySQL/Neo4j 不可用 → 503
curl -sk https://127.0.0.1:8002/health   # app-pay：HTTPS-only，-k 跳过自签校验
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/   # nginx → 前端页面
```

注意：app-ts 的 `/health` **只要进程活着就返回 200**，向量库是否就绪看响应里的 `milvus.available`；`/health` 不是 APISIX 路由，别用 `http://localhost/health` 验后端，直接打回环端口。

### 5.2 最小端到端

打开 http://localhost（或本地 dev 的 http://localhost:3000）→ B 站 App 扫码登录（app-user auth 路由 + MySQL + Redis 正常即可）→ 进「收藏夹」同步一个收藏夹触发知识库构建（ASR + 向量化，需要几分钟）→ 构建完成后在聊天里就收藏内容提问，应看到流式回答与来源。

前提：AI 网关 / 供应商 key 可用（否则聊天报错）、Milvus 就绪（`milvus.available=true`）、app-user（bili 路由）能出公网访问 B 站与语音识别服务。

---

## 6. 测试与静态检查

| 范围 | 命令 |
|------|------|
| app-ts | `cd app-ts && npm ci && npm run typecheck`（= `npx tsc --noEmit`）；`npm test`（= `npx vitest run`，离线、不依赖 Mongo/Milvus 实例） |
| frontendv2 | `cd frontendv2 && npm ci && npx tsc --noEmit && npm run lint`；`npm run build`（生产构建） |
| frontend-admin | `cd frontend-admin && pnpm install --frozen-lockfile && pnpm build`（= `tsc --noEmit && vite build`） |
| Go 单服务 | `cd app-go/app-content && go vet ./... && go test -count=1 ./...`（CI 同款顺序还包含 `gofmt -l .` 与 `go build ./cmd/app-content`） |
| app-sandbox | `cd app-go/app-sandbox && go test ./tests/`（内存 repo + fake runtime，不需要真实 MySQL） |
| app-pay | `cd app-pay && mvn test`（纯 JUnit，无外部数据库） |

> Windows 上 `gofmt -l .` 会把所有 CRLF 文件都列出来（误报），格式化检查请在 WSL / Linux 或 CI 上跑；`go vet` / `go test` 在 Windows 正常。
> 提交前的 CI 清单见 `.github/workflows/ci-*.yml`。

---

## 7. 常见问题

**端口被占用。** 常见冲突：3000（compose `frontend` 与本地 `npm run dev` 二选一，或用 `FRONTEND_PORT` 改容器端口）、8000（compose `app-ts` 与本地 dev，可用 `APP_TS_PORT` 改）、80/443（nginx；根 compose 固定映射，Windows 上常被 IIS/其他服务占用，需先停占用进程或改 `docker-compose.yml`；`docker-compose.client.yml` 支持 `NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT`）、3001（compose app-admin UI 与 frontend-admin `pnpm dev`）、8016、3306。先 `docker compose stop <服务>` 再用本地进程。

**`docker compose` 启动直接报 `err_APISIX_CONSUMER_KEY_not_set_in_.env`。** 这是 compose 的强制校验，按 §2.3 / §2.4 填 `.env`。`PAY_OPS_KEY` 自 2026-11-03 起为**可选**（仅 app-admin「退款复核」用；留空则该页 404 隐藏，不再触发 compose 校验）。

**服务起来了但服务间调用全 401/403（APISIX key-auth 拒绝、或下游报 API key 无效）。** 先确认 `.env` 的 `APISIX_CONSUMER_KEY` 非空，再看 apisix 日志里 `[apisix-config] rendered ...` 是否出现（渲染失败容器会直接退出）；改 `.env` 后必须 `docker compose up -d apisix` 重建，渲染只发生在启动时。

**app-user / app-cloud 反复重启。** 多半是 `secrets/api_key_encryption_key` 没建：compose 会把缺失的绑定源建成**目录**，服务读取失败退出。补上文件后 `docker compose up -d app-user app-cloud`。

**改了 `.env` 不生效。** 各服务只在启动时读取：容器要 `docker compose up -d <服务>` 重建；本地 app-ts 要重启 `npm run dev`（且注意它**不会**自动加载 `.env`，见 §3.3）。

**Mongo / Milvus 没起。** app-ts 仍能启动但降级：启动日志出现 `memory fallback`（会话落内存、重启即丢），向量检索返回空、`/health` 里 `milvus.available=false`。补 `docker compose up -d mongo milvus` 后重启 app-ts。

**MinIO 相关功能不可用。** `MINIO__ENDPOINT` 为空时 skills 关闭；云盘 / 壁纸 / 技能都需要 MinIO，且 app-cloud **缺 MinIO 凭证会直接拒启**。容器默认不映射 9000 到宿主，本地进程需要它时按 §3.2 加映射。

**`run_code` 提示「代码没有实际运行」。** 沙箱默认关闭（`sandbox.enabled=false` 时走 `NoopCodeExecution` 诚实降级）。启用：`docker compose --profile sandbox up -d opensandbox-server app-sandbox`，再在 app-ts 侧设 `SANDBOX_ENABLED=true`（`SANDBOX__BASE_URL` 默认经 APISIX `/internal/sandbox/v1/*`）；本地无 OpenSandbox 时可给 app-sandbox 设 `SANDBOX__RUNTIME__TYPE=fake` 只做链路演示。细节见 [code-execution.md](code-execution.md)。

**只用 `--profile ai` 结果全栈没起来。** profile 语义见 §4.1：单 profile 不含默认服务。先裸 `up -d`，再追加 profile；或一次 `--profile full up -d`。

**前端本地 dev 数据全挂 / 图片 404。** dev 代理的目标 `localhost:9080`（APISIX）或 `http://localhost`（nginx）在宿主不可达：确认 apisix / nginx 在跑，且按 §3.2 映射了 9080。

**`go run ./app-go/app-content` 报 `cannot find main module`。** 每个 Go 服务是独立 module，必须 `cd app-go/app-content && go run ./cmd/app-content`。

**`https://localhost` 证书不受信。** 用的是开发 CA（`nginx/certs/dev-ca.crt`），把它导入系统/浏览器信任库即可；也可以先用 `http://localhost`。

---

## 8. 相关文档

- 架构与配置：[architecture.md](architecture.md)（服务清单 / 端口 / 网关路由，权威）、[configuration.md](configuration.md)（配置入口与密钥清单）、[project-structure.md](project-structure.md)（目录索引）、[features.md](features.md)（功能清单）、[api.md](api.md)（API 概览）。
- 运行与部署：[setup-guide.md](setup-guide.md)（只用 Docker 跑起来）、[deployment.md](deployment.md)（生产 / HTTPS / 备份）、[client-compose.md](client-compose.md)（单人客户端 compose）、[faq.md](faq.md)。
- 专题：[academic-agent.md](academic-agent.md)（学术 Agent）、[code-execution.md](code-execution.md)（`run_code` 沙箱与降级）、[app-admin.md](app-admin.md)（分享审核 / 沙箱管理代理）。

完整文档索引见 [docs/README.md](README.md)。

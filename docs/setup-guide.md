# MindBase 安装与运行指南

> 给**不写代码的用户**：照着顺序复制命令，就能在自己的电脑上把这套系统跑起来。

> 只需要装 Docker。数据库、向量库、图数据库、对象存储、AI 网关等全部跑在容器里，不用单独安装或配置。本文是「本地单机体验」路径；线上部署见 [deployment.md](deployment.md)。

## 1. 前置准备

### 1.1 安装 Docker

- Windows / macOS：安装 [Docker Desktop](https://www.docker.com/products/docker-desktop)（Windows 请用 WSL2 后端）。
- Linux：安装 Docker Engine + Compose 插件（发行版官方文档或 `get.docker.com` 脚本）。

打开 Docker Desktop（或确认 Docker 服务已启动），在终端确认：

```bash
docker --version
docker compose version    # 需要 v2，输出形如 Docker Compose version v2.x
```

第二条命令报错说明 Docker 没启动或 Compose 未安装，先解决再继续。

### 1.2 机器配置建议

| 项目 | 建议 | 说明 |
|------|------|------|
| 内存 | **16GB（最低 8GB）** | 全量服务常驻约 7–9GB；Milvus / Neo4j / MinIO 是内存大户，8GB 会紧张 |
| 磁盘 | **预留 40GB 以上** | 镜像与构建缓存数 GB，数据库 / 向量 / 文件数据随同步内容增长 |
| 网络 | 能访问 Docker Hub 与 GitHub | 国内网络建议先配镜像加速器，见第 8 节 |

Docker Desktop 用户：Settings → Resources 里把可用内存调到建议值，Apply & Restart。

## 2. 获取代码

```bash
git clone https://github.com/atoncooper/MindBase.git
cd MindBase
```

没有 Git 也可以在 GitHub 页面点 Code → Download ZIP，解压后进入该目录。**后续所有命令都在这个项目根目录执行。**

## 3. 准备密钥（全程只有这一步要动手）

### 3.1 生成主密钥文件（用户登录凭证加密用）

```bash
# macOS / Linux / Git Bash
mkdir -p secrets
openssl rand -base64 32 > secrets/api_key_encryption_key
```

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force secrets | Out-Null
openssl rand -base64 32 | Out-File -Encoding ascii secrets/api_key_encryption_key
```

该文件已被 `.gitignore` 忽略（`secrets/`），不会被提交，**部署后不要更换**（换了已保存的用户凭证将无法解密）。缺它时 `app-user` / `app-cloud` 会反复重启（Docker 会把缺失的挂载路径建成目录）。

### 3.2 复制环境变量模板

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

`.env` 只放密钥和含密码的连接串；数据库密码等已有本地默认值，初体验不用改。

### 3.3 必填项（打开 `.env`，填这 3 项）

| 变量 | 怎么填 |
|------|--------|
| `AI_GATEWAY__API_KEY` | AI 网关的「通行证」。先自己生成一串：`openssl rand -hex 32`，填到等号右边；第 5 步在网关控制台创建消费者 `mindbase-backend` 时填**同一个值**。留空会导致 `app-user`（bili 路由）起不来、所有 AI 能力不可用。 |
| `APISIX_CONSUMER_KEY` | 服务之间互相认证的共享密钥，**必须与 `apisix/apisix.yaml` 里 `consumers.internal.key` 一致**（该文件不读 `.env`）。本地体验：直接填仓库内置开发值 `D4ldTC-nOpCp0YEokVKrEMN2mvjc_LDsOjaBY2oRPbooWLre`；对外部署：换成自己生成的值并同步改该文件里的 `key`。保持模板占位串会到处 401。 |
| `secrets/api_key_encryption_key` | 3.1 已生成，**不需要**写进 `.env`。 |

### 3.4 可选项（用到再填，留空即可）

| 变量 / 文件 | 用途 |
|------|------|
| `OPENSANDBOX_API_KEY` | 沙箱（科研代码执行）用；`openssl rand -hex 32` 生成，空值时 OpenSandbox 拒绝启动。 |
| `SANDBOX_ENABLED=true` | 让 AI 服务真正调用沙箱（默认 `false` 时 `run_code` 会如实提示未配置）。 |
| `SANDBOX_ADMIN_TOKEN` | 管理台「沙箱」面板令牌（与 app-sandbox 同值）；留空 = 面板禁用，不影响其他后台功能。 |
| `APPTASK_EMAIL_API_KEY` | 定时出题邮件（Resend 的 `re_` 开头 key）；不填时邮件只记 dry_run，不会真的发送。 |
| `PAY_MYSQL_*` / `PAY_OPS_KEY` | 会员 / 支付：`PAY_MYSQL_*` 用本地默认值即可；`PAY_OPS_KEY` 可选（管理台「退款复核」用，留空则该页隐藏）。 |
| `APP_CLOUD_ADMIN_REVIEW_TOKEN` | 管理台「分享内容受控预览」。 |
| `TAVILY_API_KEY` / `SEARXNG_URL`、`LANGSMITH_*`、`BOARD_MCP_*` | 可选增强：联网搜索质量、调用链追踪、外部 MCP 宿主接入。 |

逐项说明见 `.env.example` 注释，配置体系见 [configuration.md](configuration.md)。

## 4. 启动

### 4.1 先起主栈（默认即全栈，不含 AI 网关 / 沙箱；管理台已含支付运营）

```bash
docker compose up -d
docker compose ps
```

- 首次会拉取第三方镜像并在本地构建项目镜像，**通常十几分钟**（取决于网络）。
- 一次性容器 `cert-gen` 会自动生成开发证书（HTTPS 自签），无需手工准备。
- 默认入口：用户端 `http://localhost`（nginx 80/443）、`http://localhost:3000`、管理台 `http://127.0.0.1:3001`、定时任务控制台 `http://127.0.0.1:8001`。
- `app-user`（bili 路由）需要非空 `AI_GATEWAY__API_KEY` 才能启动，所以请先完成 3.3。

### 4.2 追加可选能力（重要：先 4.1，再追加）

`--profile` 是「选择启动范围」而不是叠加：单独执行 `--profile ai` 只会起该 profile 的服务，不会带上主栈。在已运行的主栈上追加最省事：

```bash
docker compose --profile ai up -d          # AI 网关（AI 能力必须）
docker compose --profile sandbox up -d     # 科研代码执行：沙箱控制层 + OpenSandbox
docker compose --profile pay up -d         # 会员 / 支付（支付运营在默认管理台内）
docker compose --profile tools up -d       # Redis / Mongo 网页管理工具
```

也可以一次起「全栈 + 全部可选组件」（含支付测试实例与管理工具）：

```bash
docker compose --profile full up -d
```

- 更新代码：`git pull` 后 `docker compose up -d --build`（项目镜像需要重建）。
- 定时任务执行器来自远程镜像，升级用 `docker compose pull app-task && docker compose up -d app-task`。
- 停止：`docker compose down`（保留数据）；`docker compose down -v` 会删除全部数据卷，谨慎使用。

## 5. 配置 AI 供应商（关键步骤，只需一次）

MindBase 不让用户各自填供应商密钥：所有 AI 请求统一经自建 **Higress AI 网关**出网，供应商密钥只存在网关里（不写 `.env`、不下发前端、不进日志）。

1. 确认网关已启动：`docker compose ps higress` 应为 `running` / `healthy`（需先执行 4.2 的 `--profile ai`）。
2. 浏览器打开 `http://127.0.0.1:18081`（本机访问；该端口默认对所有网卡开放，公网部署请在防火墙限制来源），首次进入按提示初始化控制台管理员。
3. 配置**供应商（Provider）**，填供应商真实 key。至少需要两类：一个能提供平台默认对话模型 `z-ai/glm-5.3-flash` 的供应商（如 OpenRouter，OpenAI 兼容接口）；以及 **DashScope（阿里云百炼）**——平台默认 embedding 模型 `text-embedding-v4`、rerank 模型 `gte-rerank-v2` 和语音转写 ASR 都走它（经 `/api/v1` 原生透传）。
4. 配置**模型路由**（覆盖 `/v1`、`/api/v1`、`/api-ws`）并保持模型名**原样透传**；平台默认请求的模型名见 `app-ts/config/default.yaml`。**不要更换 embedding 模型**，否则需清空并重建 Milvus 向量库。
5. 创建**消费者** `mindbase-backend`，认证方式 Key-Auth，key 填 3.3 写进 `.env` 的那个值（两者必须完全一致）。
6. 保存后立即生效，并持久化在 `./data/higress`（已 gitignore）：重建容器不丢配置。
7. 若两处 key 不一致：改 `.env` 使其一致，然后重建读取它的三个服务：

```bash
docker compose up -d app-ts app-cloud app-user
```

更多细节见 [configuration.md](configuration.md)「AI 网关」与 [faq.md](faq.md)「AI 与密钥」。

## 6. 验证

### 6.1 浏览器入口

| 入口 | 地址 | 说明 |
|------|------|------|
| 用户端 | `http://localhost`（备用 `http://localhost:3000`） | 能打开登录页即正常 |
| 管理台 | `http://127.0.0.1:3001` | 分享审核 / 沙箱运维；默认 `admin` / `app-admin`，**首登强制改密** |
| 定时任务控制台 | `http://127.0.0.1:8001` | 默认 `admin` / `app-task-admin`，登录后请立即改密 |

### 6.2 命令行健康检查

各服务的 `/health` 只绑定本机回环，直接打端口：

```bash
curl -s http://127.0.0.1:8000/health      # AI 域主服务；milvus.available=true 表示向量库就绪
curl -s http://127.0.0.1:8001/health      # 定时任务执行器
curl -s http://127.0.0.1:8016/health      # 管理台 API
curl -s http://127.0.0.1:8014/health      # 知识图谱存储（MySQL/Neo4j 不可用时 503）
curl -sk https://127.0.0.1:8002/health    # 交易/会员（HTTPS；未启 pay 时无输出属正常）
curl -s http://127.0.0.1:8017/health      # 沙箱控制层（需先启 sandbox）
```

注意：**不要用 `http://localhost/health` 验证服务**——该路径不是网关路由，会 404；判断 nginx / 前端是否正常，直接看 `http://localhost` 页面即可。启动失败时：`docker compose ps` 找异常服务，再 `docker compose logs -f <服务名>` 看日志。

## 7. 开始使用

1. 打开 `http://localhost`，用 **B 站 App 扫码**登录（也支持账号密码）。
2. 导航「**收藏夹**」：选择收藏夹并同步；之后自动进入处理链路——下载音频 / 抓字幕 → 语音转写 → 切块向量化。耗时取决于视频数量（每篇通常几分钟），页面可见进度。
3. 打开「**对话**」提问，回答带来源引用；也可以让 AI 帮你整理笔记、生成题目、操作思维导图。
4. 「**科研**」：科研工作台（项目六阶段、文献检索与核验、稿件写作）。其中「在沙箱里跑分析脚本」需要 4.2 的 `--profile sandbox` 与 3.4 的 `SANDBOX_ENABLED=true`。
5. 「**题目练习**」生成 / 批改题目；「**定时出题**」设定时间后自动出题并发邮件（需 3.4 的邮件配置）。
6. 其他入口：「更多」→ 知识图谱 / 知识盲区；「笔记」「思维导图」「云盘」「技能」；右上角「设置」改偏好与壁纸。
7. 管理与运维：管理台 `http://127.0.0.1:3001`（分享审核、沙箱面板、支付运营、账户与审计；默认 `admin` / `app-admin`，首登改密）。支付运营读 `app-pay` 库（`--profile pay`），退款复核需 `PAY_OPS_KEY`。

## 8. 常见问题

**3000 / 80 端口打不开。** 容器还在构建或启动：`docker compose ps` 看状态，`docker compose logs -f nginx frontend` 看日志。80/443 被别的程序占用时先停掉占用进程；也可在 `.env` 设 `FRONTEND_PORT=3001` 改前端端口。只想跑轻量核心栈可用 [client-compose.md](client-compose.md)。

**有容器 unhealthy / Exited。** 先 `docker compose ps` 找出异常服务，再 `docker compose logs -f <服务名>`。最常见原因：缺 `secrets/api_key_encryption_key`（3.1）、`APISIX_CONSUMER_KEY` 与 `apisix/apisix.yaml` 不一致（3.3）、`AI_GATEWAY__API_KEY` 留空。

**镜像拉不动 / 构建很慢（国内网络）。** 给 Docker 配镜像加速器：Docker Desktop → Settings → Docker Engine（Linux 改 `/etc/docker/daemon.json`），加 `registry-mirrors` 后重启 Docker；方法见 [deploy/china/README.md](../deploy/china/README.md)「镜像拉取与加速」（**只取加速器配置**；该目录编排文件是旧快照，不要用它启动）。GitHub 慢可用代理或 ZIP 包。

**AI 调用失败（对话报错、转写失败、出题失败）。** 依次检查：①是否执行 `--profile ai`、`higress` 是否 healthy；②控制台供应商 key 是否有效、模型路由是否覆盖默认模型名（`z-ai/glm-5.3-flash`、`text-embedding-v4`、`gte-rerank-v2`）；③`.env` 的 `AI_GATEWAY__API_KEY` 是否与网关消费者 key 完全一致；④改完 `.env` 后执行 `docker compose up -d app-ts app-cloud app-user` 让服务重新读取。若换过 embedding 模型，检索会为空，需要重建向量库。

**沙箱 / `run_code` 不可用。** 确认 `--profile sandbox` 已启动且 `app-sandbox`、`opensandbox-server` 均 healthy；`OPENSANDBOX_API_KEY` 非空且两边一致；`.env` 有 `SANDBOX_ENABLED=true` 并重启过 `app-ts`。只想演示控制层链路时可在 `.env` 设 `SANDBOX_RUNTIME_TYPE=fake`，它不会真实隔离执行代码。

**管理台 502 / 登录不了。** 管理台页面（3001）把 `/api` 反代到 `app-admin-api`（8016）：先 `curl -s http://127.0.0.1:8016/health`，502 时看 `docker compose logs -f app-admin-api`（常见：数据库未就绪、8016 被占用）。默认 `admin` / `app-admin`，首登强制改密；沙箱面板还需 3.4 的 `SANDBOX_ADMIN_TOKEN`。

**磁盘告警 / 空间不足。** `docker system df` 看占用；`docker builder prune -f`、`docker image prune -f` 清理缓存与悬空镜像；`docker compose down` 停栈并保留数据。数据卷（MySQL / Mongo / Milvus / Neo4j / MinIO）会随同步内容增长，长期使用请放在空间充足的分区；同一时间只运行一套 compose。

**想彻底重来。** `docker compose down -v` 删除全部数据卷（含账号、知识库、向量），执行前请确认；`secrets/api_key_encryption_key` 删除后，已加密的用户凭证无法恢复。

## 9. 相关文档

- 本地开发（改代码、跑测试）：[getting-started.md](getting-started.md)
- 系统组成、端口、路由、数据归属：[architecture.md](architecture.md)
- 配置项与密钥清单：[configuration.md](configuration.md)
- 生产部署（HTTPS、备份、多机）：[deployment.md](deployment.md)
- 常见问题总表：[faq.md](faq.md)
- 功能全景与入口：[features.md](features.md)
- 目录结构：[project-structure.md](project-structure.md)

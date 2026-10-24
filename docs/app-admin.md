# app-admin — 云盘分享审核管理后台

> 管理后台由 `app-admin`（Nginx 静态 UI，`:3001`，仅回环）+ `app-admin-api`（Go + Gin，`:8016`，仅回环）组成；UI 经同源 `/api` 代理到 API，不经过主站公网 Nginx/APISIX。
> 业务域 = **云盘分享先分享后审核**（plan/1.0.16）：只读用户账户与分享元数据，唯一写操作是 `cloud_shares` 的 4 个审核列。
> 内容能力 = **受控预览**（Issue #154，2026-10）：admin 角色可依法预览分享内文件（用户创建分享时已单独确认告知）；**无下载、绝不直连 MinIO**（预览经 app-cloud 内部端点返回：媒体/pdf 为短时效内联授权，文档为后端提取的纯文本）。

## 定位与红线

- **数据访问**：直连共享 bilirag MySQL（`RDBMS__URL` 同 app-auth/app-cloud）。读 `users` / `user_profile` / `rbac_user_role` / `rbac_role` / `cloud_shares` / `cloud_files` / `cloud_folders`；**唯一写** = `cloud_shares` 的 `moderation_status/moderation_reason/moderation_time/moderation_by`（与 `admin_audit` 同事务）。
- **受控内容预览（Issue #154，审核员可查看）**：仅 admin 角色；app-admin 校验分享存在 + 文件在分享范围（文件分享 = 目标文件；文件夹分享 = 子树存活成员）并落 `admin_audit`（action=`preview_content`），再调 app-cloud `GET /internal/cloud/admin-review/shares/{id}/files/{fid}/preview`（Bearer 共享令牌 `APP_CLOUD_ADMIN_REVIEW_TOKEN`，两边同值）。**审核员可查看任意已存在的分享**（含 banned / 已撤销 / 已过期 / 历史未确认告知的分享——举报常在属主撤销后才到）；app-cloud 只校验分享存在与文件归属范围，不校验公开可访问性，也不要求用户确认告知；每次预览先落审计再签发授权。预览返回：pdf / 图片 / 音视频 → 短时效内联 URL（`/minio-proxy/...`，admin UI 内置 Nginx 同源代理到 MinIO，PDF 以 `X-Frame-Options: SAMEORIGIN` 允许同源 iframe 展示）；docx / xlsx / pptx / html / markdown / txt 等 → 后端提取的纯文本（`viewMode:"text"`，xlsx 按单元格顺序输出、XML 实体自动解码），不生成对象 URL、不渲染 HTML（防存储型 XSS）；暂不支持类型 / 无文本（扫描件/加密件）/ 过大文件返回 422/413 并带原因。viewer 角色一律 403。
- **app-cloud 关系**：admin API **直接查/写 MySQL**，请求不转发给 app-cloud。Compose 启动 app-cloud 是为了让其 schema owner migration 创建/补齐 `cloud_shares` 审核列；这些列已迁移后，admin 的日常查询不依赖 app-cloud 业务 API。全新库首次启动时仍需 app-cloud 完成迁移。
- **自有表**（本服务 `Migrate` 只 `CREATE TABLE IF NOT EXISTS` 这三张，守护测试锁定）：`admin_user`（控制台账户）/ `admin_session`（DB 会话）/ `admin_audit`（操作审计）。
- **绝不** `AutoMigrate`/ALTER 共享表；**绝不** 触碰 `is_revoked`（属主撤销语义独立，admin 只改审核列）。
- **对象存储边界**：GORM 模型连 `bucket`/`object_key` 都不映射，app-admin 不持有任何 MinIO 凭证；内容只经 app-cloud 内部预览端点返回：媒体/pdf 为短时效内联 URL（经 admin UI Nginx `/minio-proxy/` 同源代理，PDF iframe 按 SAMEORIGIN 放行），文档为提取文本（文本模式无对象 URL 到达浏览器）；列表/详情其余字段仍只出 name/size/mimeType/path 元数据。
- **端口/暴露**：UI `3001`、API 调试口 `8016` 都只绑定 `127.0.0.1`；用户浏览器访问 UI，由同源 Nginx 代理 `/api`。后台不经主站 APISIX/nginx。
- **包结构**：`router`（参数解析/鉴权/错误体）→ `service`（业务规则 + DTO 组装）→ `repo`（SQL）；响应 DTO 独立在 `internal/dto`（纯 JSON 契约、无依赖，service 与 router 共用），不放在 service 包里。

## 页面（frontend-admin）

| 路由 | 说明 |
|------|------|
| `/login` | 登录；`mustChangePassword=true` 时**强制先改密**（POST `/api/me/password`）再进后台 |
| `/shares` | 分享审核：筛选（审核状态 / 属主 uid / 关键词 / 是否已撤销 / **内容状态**）+ 元数据表格 + **每行「查看」详情抽屉**（元数据 + 分享内文件列表 + 受控预览入口）+ **放行 / 封杀 / 解封**（reason 弹窗，封杀必填）。**默认只看「目标内容存在」的可审核分享**，目标已删除的存量记录需切到「内容：全部/目标已删除」查看（仅审计，无可审核内容）；预览与审核操作仅 admin；审核员可查看任意分享内容，每次预览落审计 |
| `/users` | 用户只读：uid / email / phone / nickname / status / 角色 Tag；行点击抽屉看角色明细。查询框**自动识别** UID（数字）/ 11 位手机号（1[3-9] 开头）/ 邮箱（含 @），实时显示识别结果；前端正则校验 + 后端二次校验，非法输入不发起请求 |
| `/audit` | 审计日志倒序；操作下拉筛选 + 管理员精确筛选；操作中文标签/颜色，详情按动作格式化（封杀/解封/放行原因、预览文件与模式、登录 IP/客户端、自助改密）；「分享 #ID」可跳转并自动打开分享详情抽屉 |

前端请求层 `src/api/client.ts` 统一：带 cookie、`{detail}` 错误透传、401 清态踢回登录；uid 为 bigint（可 > 2^53），解析时保留为字符串防精度丢失。

**查看分享内容**：列表行「查看」→ 详情抽屉；文件行「预览」→ 受控预览（admin）。**审核员可查看任意分享的内容**（包括已撤销、已过期、封杀中、以及创建时用户未确认《管理员内容审核告知》的历史分享），用户告知状态仅作展示、不阻断预览。每次预览后端写 `preview_content` 审计；除受控预览外不提供下载/导出/URL 复制。

## 鉴权

| 机制 | 说明 |
|------|------|
| 账户 | `admin_user` + bcrypt；种子账户 **`admin` / `app-admin`**（`APPADMIN__SEED__USERNAME` / `APPADMIN__SEED__PASSWORD` 可覆盖，**只插缺失不覆盖**），首登强制改密（`must_change_password=1`） |
| 会话 | DB 会话 `admin_session` + **HttpOnly cookie `admin_session`**（SameSite=Lax；TLS 下自动 Secure）；**滑动 12h**（每个认证请求续期），登出只删当前会话 |
| 角色 | `admin`（审核写）/ `viewer`（只读）；ban/unban/approve 仅 admin；改密对所有登录账户开放 |
| 限流 | 每 IP 每分钟 10 次登录失败 → 429 + `Retry-After`；进程内限流；`SetTrustedProxies(nil)` 防 XFF 伪造 |
| IP 访问控制 | 可选精确 IP/CIDR 白名单（`APPADMIN__SECURITY__IP_ALLOWLIST`）；空列表时仍依赖 loopback / 防火墙 / VPN / ClusterIP；`/health` 为探针豁免 |
| 浏览器来源 | CORS 仅允许同源或显式配置的精确 Origin；跨域预检校验方法/请求头；浏览器 POST/PUT/PATCH/DELETE 必须带允许的 Origin（CSRF 防护），不允许 `*` |
| 加固 | nosniff / `X-Frame-Options: DENY` / CSP `frame-ancestors 'none'` / `/api/*` no-store |

IP 白名单检查应用实际看到的 TCP 对端地址，**不读取 `X-Forwarded-For`**。Compose 下 API 看到的是 `app-admin` UI 容器的地址，不是浏览器 IP；不要把管理员电脑的 IP 当成 API allowlist，否则会被拒绝。通过 SSH 隧道、Docker NAT、Kubernetes port-forward 或反向代理访问时，真实用户 IP 应在 SSH 入口、防火墙或可信入口代理处限制。若管理 SPA 与 API 跨域部署，必须配置精确的 CORS Origin；CORS 本身不是网络访问控制。

## API 速览

错误体统一 `{"detail": ...}`；分页 `page` 从 1 起、`pageSize` ≤100、缺省 20。

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| GET | `/health` | — | 探活（**真查 DB** `SELECT 1`；DB 不可用 503） |
| POST | `/api/login`、`/api/logout` | — | 登录/登出（登录在 session 闸门外） |
| GET | `/api/me`；POST `/api/me/password` | 登录 | 会话回显（含 `mustChangePassword`）/ 自助改密（旧密校验 + 新密 ≥8 位） |
| GET | `/api/users?q=&mode=uid\|phone\|email&page=&pageSize=` | viewer+ | 用户列表：q **精确匹配** UID（正整数）/ 11 位手机号（1[3-9] 开头）/ 邮箱（含 @）；`mode` 可选，前端按正则判定后传入、后端再次校验（格式或方式不匹配 → 400）；不传 mode 时后端自行推断；响应 `queryMode` 回显实际查询方式 |
| GET | `/api/users/:uid` | viewer+ | 详情 + 角色明细（granted/expires/isActive），**不含任何文件/存储信息** |
| GET | `/api/shares?status=active\|approved\|banned&uid=&revoked=0\|1&available=0\|1&q=&page=&pageSize=` | viewer+ | 分享列表：文件/文件夹；文件夹用**一条递归 CTE** 聚合 fileCount/totalSize。`contentAvailable` 表示目标文件/文件夹是否仍存在；`available=1`（UI 审核队列默认）=仅可审核，`0`=仅目标已删除的存量记录，缺省=全部 |
| GET | `/api/shares/:id` | viewer+ | 详情 + `files: [{name,size,mimeType,path}]`（上限 2000，超出 `truncated: true`） |
| POST | `/api/shares/:id/ban` | admin | `reason` 必填 → `moderation_status=banned` + audit；**不触碰 is_revoked** |
| POST | `/api/shares/:id/unban` | admin | → `active`（清 reason/time/by；可选 reason 只进审计）+ audit |
| POST | `/api/shares/:id/approve` | admin | → `approved`（可选 reason）+ audit |
| GET | `/api/shares/:id/files/:file_id/preview` | admin | 受控内容预览：短时效**内联**授权（url/viewMode/mimeType/fileName/fileSize/expiresIn）；审核员可查看任意分享（banned/撤销/过期/未确认告知均可）；非分享范围或文件已删除 → 404；未配置 → 500 + 提示；每次查看审计 action=`preview_content` |
| GET | `/api/audit?action=&admin=&page=&pageSize=` | viewer+ | 审计倒序（ban/unban/approve/preview_content/login/logout/change_password） |

## 审核如何生效

- 公开访问 `GET /cloud/s/{token}` 由 app-cloud `ResolveShare` 判定：`moderation_status=banned` 与 `is_revoked` **同等统一 404** → admin 写共享库后**即时生效**（无需回调/重载）。
- 引用面（`cloud_refs` 解析）同时校验来源分享未 banned/revoked/过期 → 封杀后已保存引用也立即失效（404「引用已失效」并落 dead）。
- 属主列表（`GET /cloud/video/:uuid/shares` / `/cloud/folders/:id/shares`）返回审核三元组（status/reason/time），属主可见审核结果。

## 配置

三层合并（后者覆盖前者）：`default.yaml`（go:embed 嵌入）← `-config` 覆盖层 ← `APPADMIN__` 环境变量（最高）；另经 godotenv 读项目根 `.env`。

```bash
APPADMIN__RDBMS__URL=mysql+aiomysql://mind_base:mind-base@mysql:3306/mind_base
APPADMIN__SEED__USERNAME=admin          # 种子账户（只插缺失）
APPADMIN__SEED__PASSWORD=app-admin      # 生产务必覆盖
APPADMIN__SESSION__TTL_MINUTES=720      # 会话滑动 TTL（默认 12h）
APPADMIN__SECURITY__IP_ALLOWLIST=        # 可选，逗号分隔 IP/CIDR；例：10.0.0.10/32,192.168.1.0/24
APPADMIN__SECURITY__CORS__ALLOW_ORIGINS= # 可选，逗号分隔精确 Origin；例：https://admin.example.com
# 内容审核预览（与 app-cloud 共享令牌，两边同值 = 预览开启；单侧配置或都为空 = 预览关闭）
# APPADMIN__CLOUD_REVIEW__BASE_URL=http://app-cloud:8007
# APPADMIN__CLOUD_REVIEW__TOKEN=<openssl rand -hex 32>
APPADMIN__LOG__LEVEL=info               # debug|info|warn|error；format: text|json
APPADMIN__LOG__OUTPUT=both              # stdout|file|both（compose 置 both，落 /app/logs）
APP_ADMIN_WEB_PORT=3001                 # compose 宿主机 UI 端口（默认 3001，仅回环）
APP_ADMIN_PORT=8016                     # API 调试映射端口（默认 8016，仅回环）
```

普通配置（端口/时区/连接池/日志轮转）在 `app-go/app-admin/default.yaml`；时区固定 Asia/Shanghai（DSN `loc=Local`）。

## 启动

```bash
# 一条命令启动完整管理后台入口及依赖：UI + API + MySQL + auth/cloud schema owner
docker compose up -d --build app-admin
# 浏览器打开 http://127.0.0.1:3001；默认种子账户 admin / app-admin，首登强制改密
# app-admin UI 同源代理 /api -> app-admin-api:8016；API 调试口仅回环 127.0.0.1:8016

# 仅启动 API（不启动后台 UI）
docker compose up -d --build app-admin-api

# 本地（Go 模块模式；连宿主 MySQL）
cd app-go/app-admin
APPADMIN__RDBMS__URL='mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base' go run .

# 前端 dev（另一个终端）
cd frontend-admin && pnpm i && pnpm dev   # http://localhost:3001，/api 代理并改写为上游同源 Origin
```

> `app-admin` 是组合入口服务，会依赖启动 `app-admin-api`；API 依赖 MySQL、app-auth（用户/RBAC 表）和 app-cloud（审核列 migration）。app-auth/app-cloud 会启动各自的 Redis/MinIO 依赖。确保根目录 `.env`（含 `APISIX_CONSUMER_KEY` 等 Compose 必需值）和 `secrets/api_key_encryption_key` 已配置；首次启动等待 migration 完成后再登录。app-cloud 完成首次审核列 migration 后，admin API 的请求仍是直接操作 MySQL。

## 部署（deploy/docker 与 k8s）

- 两机 compose：`deploy/docker/96-app-admin.yml`（启动 UI + API；共享数据库与 app-auth/app-cloud 仍由主栈提供）；浏览器经 SSH 隧道 `ssh -L 3001:127.0.0.1:3001 <server2>`。
- k8s：`deploy/k8s/30-apps/app-admin.yaml`（ClusterIP，无 Ingress；访问用 `kubectl -n mind-base port-forward svc/app-admin 8016:8016`）。
- 镜像 `atoncooper/mind-base-app-admin`；CI `.github/workflows/ci-app-admin.yml`（gofmt/vet/test/build）+ docker-build 矩阵。

## 测试

```bash
cd app-go/app-admin && go test ./...   # 纯 httptest/内存，无需真实 MySQL
cd frontend-admin && pnpm build        # tsc --noEmit + vite build
```

覆盖：配置覆盖优先级、迁移守护（只建三张自有表）、登录/限流/会话、角色闸门、分页参数校验、审核 reason 必填、审计写入、CORS/安全头、内容预览审计与非分享范围 404 语义。

> 完整契约与验收清单：[plan/1.0.16-ShareModeration](../plan/1.0.16-ShareModeration/1.0.16-ShareModeration.md)。后端架构与红线见根 `AGENTS.md` §2.21。

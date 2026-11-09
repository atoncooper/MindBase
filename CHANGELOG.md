# Changelog

本文件记录 MindBase 各版本的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] — 2026-11-08

### Changed

- **内容域 MCP 合并：app-board-mcp + app-note-mcp + app-quiz-mcp → app-content-mcp**：三个 Go MCP server 合并为单一模块 `app-go/app-content-mcp`（单 Go module / 单镜像 `atoncooper/mind-base-app-content-mcp` / 单容器 `mind-base-app-content-mcp` / **单端口 8019** / 单 `/mcp` 端点，streamable-http）。**工具面与协议零改动**：board 6 + note 4 + quiz 2 共 12 个工具的名称/参数/返回文案不变，board 的 3 个 resources（`board://{uuid}`）与 3 个 prompts 一并保留；app-ts 的 prompt 契约、前端、SSE 协议、APISIX 路由全部零改动。上游仍经 APISIX key-auth 三条 internal 路由（`board_internal`/`note_internal`/`quiz_internal`，零改动）到 app-content:8004。端口取 8019（避开 app-kg health 的 8014）；双模式鉴权（外部宿主 Bearer + 固定 uid / app-ts 服务模式 apikey + 每请求 X-Uid）与「uid 永不出现在 LLM 可写参数」红线不变。
- **工程形态**：**按 MCP 原语组织**——`internal/mcp/tools`（12 工具）、`internal/mcp/resources`（board 模板 + 动态 list）、`internal/mcp/prompts`（3 prompts）、`internal/mcp/kit`（原语无关的 wrap/结果/未配置守卫）；上游按域 `internal/upstream/{board,note,quiz}` 隔离，唯一组合根 `main.go`；共用 `internal/{identity,logger,serve,certs,config}`；env 前缀 `BOARDMCP__`/`NOTEMCP__`/`QUIZMCP__` → **`CONTENTMCP__`**（三域共用一份配置）；日志卷 `app_content_mcp_logs` / 日志前缀 `[CONTENTMCP]`；证书目录 `app-go/app-content-mcp/certs`；compose profiles `["", "content-mcp", "full"]`（默认栈启动）。
- **测试布局**：`app-go/app-content-mcp` 全部测试迁入 `tests/` 独立 `package tests`（黑盒；经官方 in-process MCP client 调 tools/resources/prompts），`internal/**` 下不再保留 `_test.go`。
- **安全加固二（2026-11-09）**：① APISIX 密钥模板化——新增 `apisix/apisix.yaml.template` + `apisix/render-config.sh`，容器启动时从 env 渲染（compose/swarm entrypoint、k8s initContainer），仓库不再保存 consumer/internal key 明文，产物 gitignore；`apisix.dev.yaml` 同步改为模板。② app-ts 风险工具收口：`delete_board` 不再桥接给 AI（board agent 仅 5 工具），删除只保留给界面/外部宿主白名单。③ MCP 增加鉴权后 per-uid 限流（`CONTENTMCP__SERVER__RATE_LIMIT_PER_UID_RPS/_BURST`，0=关闭）：全局桶防打爆、按 uid 桶防单租户吃满。
- **MCP 工具 schema 修正**：`create_board`/`update_board` 的 `content` 改为 `anyOf: [object, string]`，与工具描述/实现一致；开启 `WithInputSchemaValidation` 后 JSON 字符串 content 不再被误拒（协议级测试覆盖 string 通过、number 拒绝）。
- **MCP 安全加固**：① 外部 Bearer token 支持工具白名单 `CONTENTMCP__SERVER__BEARER_ALLOWED_TOOLS`（空=全部 12 个；服务模式不受限），把合并后「单 token 触达 12 工具」的面收窄到最小权限；② 开启 mcp-go `WithInputSchemaValidation`，工具参数类型/必填不符直接以 tool error 返回（模型可自纠，不进 handler）；③ 工具调用日志增加 `auth_mode`/`uid` 审计字段（仍不记录正文/标题）。
- **部署/CI 一次性切换**：compose（含 client compose）删除 3 个 MCP 服务与 3 个日志卷、新增 `app-content-mcp`；`deploy/{docker,k8s,swarm}` 三份 manifest → 一份（`38-app-content-mcp.yml` / `app-content-mcp.yaml` / stack 单服务）、cert-gen 证书路径与 leaf 名同步；`.github/workflows/docker-build.yml` 矩阵 14 → 12 镜像；`scripts/gen-certs.sh` 默认 `MCP_DIR=app-go/app-content-mcp/certs`；`.env.example` 的 `BOARD_MCP_UID/AUTH_TOKEN`、`NOTE_MCP_*`、`QUIZ_MCP_*` → `CONTENT_MCP_UID` / `CONTENT_MCP_AUTH_TOKEN`，新增宿主调试口 `APP_CONTENT_MCP_PORT`（默认 8019）；NO_PROXY 服务名同步。APISIX 三条 internal 路由与 consumer 零改动（只同步注释里的服务名）。
- **app-ts 接入**：`config/default.yaml` 的 `noteMcp`/`quizMcp`/`boardMcp` 三段 → 一段 `contentMcp`（`url=http://127.0.0.1:8019/mcp`、`apiKey`/`bearerToken`/`completionModel`），`src/config/index.ts` 类型与 `test/config-loader.test.ts` 同步；`src/bootstrap/container.ts` 只建**一个** `McpClient`：note/quiz 手写 wrapper 复用，board 经 `registerMcpTools` 动态桥接**仅 5 个工具**（`includeToolNames` 过滤；`delete_board` 不桥接给 AI，删除只留给界面/外部宿主白名单），`BoardCompletionService` 复用同一 client；`enabled=false` 时三域工具全部不注册（降级语义不变）。

### Documentation

- **规范**：AGENTS.md 目录树（`mcp/` 三条 → `app-go/app-content-mcp`）、§2.6 问题定位索引、§2.11 重写为 `app-content-mcp`（三域 12 工具 + resources/prompts、8019 端点、双模式鉴权、APISIX 三路由、TLS、部署与 profile、红线）、§2.12 board agent MCP 客户端/工具路径、§2.15/§2.17 的 MCP 行、§2.18 内网先例措辞；`app-ts/AGENTS.md` 的 `src/mcp` 说明改为 contentMcp 单端点。
- **服务文档**：`docs/app-board-mcp.md` → **`docs/app-content-mcp.md`**（合并动机/拓扑、12 工具表、resources/prompts、双模式鉴权与 uid 红线、上游三条 internal 路由、`CONTENTMCP__` 配置、TLS、部署、从旧三服务的迁移与回滚、测试冒烟、红线）；删除旧文件名并更新索引与全部引用链接。`docs/{architecture,configuration,deployment,getting-started,features,setup-guide,project-structure,client-compose,vscode-setup,service-key-auth,README,app-content,app-kg}.md` 同步新服务名/端口/env。`plan/1.0.19-Content-Domain` 追加状态注记（MCP 收口已在 1.0.20 执行）。

## [Unreleased] — 2026-11-07

### Changed

- **内容域合并：app-note + app-quiz + app-board → app-content**：三个 Go 服务合并为单一模块 `app-go/app-content`（单 Go module / 单镜像 / 单容器 / 单进程），三域挂在同一个 Gin 引擎、**单进程 / 单端口 8004（HTTPS+TLS rotator）**上（一个 `*http.Server`；路径 /board、/notes、/quiz、/tasks、/internal/* 共用），对外路径 / wire 契约 / DB schema / MCP 协议不变；配置收敛为一个 `default.yaml`（board/note/quiz 三段），env 前缀兼容 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__`；全局单 logger；MySQL/Mongo/Redis 连接按域隔离复用。MCP server（app-note-mcp / app-quiz-mcp / app-board-mcp）保持独立，仅上游服务名改为 app-content。
- **编排/网关/部署一次性切换**：compose（含 client compose）新增 `app-content`（镜像 `atoncooper/mind-base-app-content`，profiles `["", "content", "note", "quiz", "board", "full"]`，日志卷 `app_content_logs`，board TLS 证书挂载沿用 `./app-board/certs`，depends_on cert-gen+mysql+mongo+redis）、删除 `app-note`/`app-quiz`/`app-board` 服务；APISIX 改为 `upstream-app-content-note/-quiz/-board` 三个 upstream（端口/协议语义不变）；nginx 注释与 CI（新增 `ci-app-content.yml`、docker-build 矩阵 16→14 镜像）同步；`deploy/{docker,k8s,swarm}` 与启动脚本同步；旧 `app-go/app-note|app-quiz`、根 `app-board/` 目录删除。
- **文档/规范**：AGENTS.md §2.15 重写为 app-content 内容域权威章节（§2.17 改为合并说明），目录树/定位索引同步；docs/{architecture,configuration,getting-started,deployment,client-compose,api,project-structure,README,features,faq,notes,sharing,vscode-setup,service-key-auth,app-board-mcp} 同步为 app-content，新增 docs/app-content.md 替代 docs/app-board.md；archive 文档加历史注记。

### UI

- **思维导图画布 UI（参考 Google Docs/Material）**：顶栏收敛为白色 app bar + 分组图标按钮，视图/导出/更多改为下拉菜单（大纲、小地图、图形库、版本历史、快捷键、彩虹连线、适应画布；PNG/SVG/PDF/MD/XMind/HTML；存模板/转白板）；画布增加点阵底纹（平移时淡出）；右下缩放改为胶囊形图标控件；空画布增加轻量引导卡；小地图移至左下并统一圆角/阴影/强调色。

### Security / Fixed

- **配置体系升级（企业级高级配置）**：`default.yaml` 重写为进程级 `app/server/security/log/observability` + 域级 `board/note/quiz` 两层；新增 TLS 1.2/1.3 与 client_auth、HTTP/2、trusted_proxies、优雅关停、分级超时、可配置安全头/HSTS、CORS methods/headers/expose/max-age、令牌桶限流（rps/burst/key/排除路径）、三域 body limits、日志 add_source/轮转、Prometheus `/metrics` 与可选 pprof；`CONTENT__SECTION__KEY` env 覆盖 + 旧 `APPBOARD__` 兼容。

- **DTO 分层 + 企业级安全校验**：新增 `internal/dto/{board,note,quiz}`（请求 DTO 带 `binding` 校验 + 响应 DTO/mapper），router 只做绑定/映射；新增 `internal/middleware` 统一 request-id、安全头（含 HSTS）、CORS、body limit、X-Uid 校验；`/internal/*` 增加 `X-Internal-Key` 服务令牌二次校验（fail-closed，APISIX 注入），未配置返回 503。
- **HTTPS 强制**：单 listener 默认 TLS，启动校验拒绝明文（仅 `CONTENT__ALLOW_INSECURE_HTTP=true` 本地调试可用）；APISIX 三 upstream / k8s 探针 / compose 全链路 HTTPS。

- **安全防护基线补齐（review 修复）**：note/quiz 增加请求体上限（2 MiB / 4 MiB）与完整 HTTP server 超时（原为无超时 slowloris 面）；board 增加安全响应头与 `/health` MySQL 探测（503 拉出 APISIX 节点）；三面认证失败统一 401（board 原 400）；note 面 500 不再返回驱动/Mongo 错误原文，统一「内部错误」/503；`X-Request-Id` 截断 64 字符并注入日志上下文；`*__CORS__ALLOW_ORIGINS` 改为替换语义（可收窄），启动校验拒绝 `*`（credentials 模式下不安全）；gin 的进程级 mode 收敛到组合根设置一次。
- **架构可读性**：`internal/app/{board,note,quiz}` 更名 `internal/bootstrap/{board,note,quiz}`（明确是进程内组装函数，唯一 main 在 `cmd/app-content`）；域间仅允许 service 接口跨域，新增 `tests/architecture_test.go` 守护（单一 main + 禁止跨域 repo/router/model/infra import）。
- **单端口 / 单进程返工**：`internal/bootstrap` 收敛为一个组合根（唯一 `*http.Server` / 唯一 `ListenAndServe`），移除三套 per-domain listener；APISIX 三个 upstream 节点统一指向 `app-content:8004`（scheme https），compose/k8s/swarm/启动脚本/文档同步为单端口；`tests/architecture_test.go` 新增「唯一 listener」守护。
- **单 Gin 实例收口**：组合根创建唯一 `gin.New()` 并统一 `middleware.Apply` 一次，board/note/quiz 改为 `Register(e, deps)` 在同一 engine 上注册路由（删除每域自建 engine + `http.ServeMux` 前缀挂载）；`/health`、`/metrics`、pprof、404/405 兜底也挂同一 engine；三域不同请求体上限改为 middleware 按路径前缀选取；`tests/architecture_test.go` 新增「唯一 `gin.New()` / 无 `ServeMux`」守护。
- **数据源收口（一个进程 = 一组连接）**：新增进程级 `database` 配置（MySQL 池 / Mongo client / Redis client 各一个）与 `internal/infra/{mysql,mongo,redis}`，board/note/quiz 全部改为接收共享 handle（删除三个包级 `var DB` 单例、三个 MySQL 池、三个 Mongo client、两个 Redis client）；`default.yaml` 删除 board/note 段（仅保留唯一 `database` + quiz 配额/超时）；旧 `APPBOARD__`/`APPNOTE__`/`APPQUIZ__` 数据源 env 仍兼容但**取值冲突会拒绝启动**（防止一个进程连到多个库）；`.env` 只在组合根加载一次；board 历史 Mongo 库 `MindBase` 与共享 `mind_base` 显式分开（`database.mongo.board_database`，迁移后可置空统一）。
- **board internal 鉴权补齐**：board 新增真实 `/internal/board/*` 路由组（`InternalAuth` + `RequireUID`），APISIX `board_internal` 只注入 `X-Internal-Key` 不再 rewrite 路径，与 note/quiz 的纵深防御一致。
- **分层收口（第二批）**：错误模型统一为 `internal/apperr` + `middleware.RespondError`（board 哨兵/note typed/quiz APIError 三套收敛）；DTO 包不再依赖 service/repo/model（映射下沉到 controller，`tests/layering_test.go` 新增 dto 依赖守护），quiz 公开响应改为 typed DTO（History/WrongAnswers/QuizDetail/Share/Delete/Rename，router `renderTyped` 转换）；quiz repo/service 全部补 `context.Context`（Rw/统计/分享/状态机查询），消除 `context.Background()`；board 迁移由 `AutoMigrate` 改为 CREATE-ONLY DDL，与 note/quiz 一致并新增 DDL 守护测试。
- **分层收口（第三批）**：repo 统一为「struct 持有连接句柄 + ctx-first 方法」——note `NoteRepo{DB}`、quiz 新增 `Repo{DB, Mongo}` 全量方法化（board 已同构），service 不再持有 `*gorm.DB`/`*mongo.Database`（quiz `Store.Repo`、note `NewNoteService(repo, content)`）；quiz 全部内部/公开响应补 typed DTO（`GradingPayload`/`TaskQuizDetail`/`TaskQuizSubmitResult`/`AgentWriteResult`/`SignalsResponse`/`WrongAnswers`），router 统一 `renderTyped`，HTTP 边界不再直出 `map[string]interface{}`；quiz repo/service 全部 query 走 `WithContext`，移除残留 `context.Background()`。
- **数据层正确性修复**：MySQL DSN 统一 `loc=UTC`（board 原 `loc=Local`，容器 TZ 非 UTC 时与 note/quiz 差 8 小时）；board 创建改为「正文先写 + 元数据失败补偿」，不再出现 201 但正文丢失；note 删除改为单事务（软删 + 撤销分享），不再出现已删笔记仍有有效分享链接；health 聚合 MySQL + Mongo + Redis（Mongo/Redis 故障不再 200）；`tests/architecture_test.go` 新增「唯一 MySQL/Mongo/Redis client、无包级 DB 全局」守护。
- **测试目录统一**：全部 Go 测试从各 `internal/**` 包迁入 `app-go/app-content/tests` 独立 `tests` 包（20 个测试文件，含分层/架构守护）；`internal/**` 下不再有任何 `_test.go`；CI 改为 `go test -race -coverpkg=./... ./tests/`（当前总覆盖率约 35%，门槛 25%）。
- **单元测试补齐**：新增 board/quiz router 安全契约测试（401/403、安全头、CORS、请求体上限、未知路由 JSON）、logger（request-id 上下文 + 文件 sink + 级别）、bootstrap 配置 fail-fast、config 默认值/CORS env/通配符拒绝、架构守护；CI 增加 `-race` 与 25% 覆盖率门槛（当前 26.9%）。
- **k8s 加固**：pod `runAsNonRoot/runAsUser/runAsGroup/fsGroup=65532`（emptyDir `/app/logs` 可写）、容器 `allowPrivilegeEscalation: false` + `capabilities.drop=[ALL]`；删除无效的 `APPNOTE__/APPQUIZ__LOG__OUTPUT`（单 logger 由 board 段驱动）。
- 文档：`docs/app-content.md` 新增「安全边界与防护」章节（信任模型、已实施基线、剩余风险），并明确单二进制/单进程语义。

## [Unreleased] — 2026-11-06

### Changed

- **用户域合并：app-auth + app-bili + app-settings → app-user**：三个 Go 服务合并为单一模块 `app-go/app-user`（单 Go module / 单镜像 / 单容器 / 单进程），保留三个独立 Gin engine 与三个监听口（8006=auth/forward-auth、8010=bili/ASR、8015=settings），对外路径/鉴权语义/事件契约/DB schema 全部不变；域间禁止互相 import，唯一跨域契约为 `internal/contracts.BiliCredentialProvider`（bili 不再直接读 `user_oauth`、不再持有 AES 解密）；共享单 MySQL 连接（loc=UTC）、单 logger、单日志卷 `app_user_logs`；全部 Go 测试迁入 `app-go/app-user/tests/` 独立 `tests` 包（arch/ownership/routes golden/config/HTTP smoke + AES/bcrypt/token/雪花/WBI/DDL guard）。顺带修复 app-auth `APPAUTH__INTERNAL__API_KEY` 未注入导致 `/internal/auth/user/{uid}` 恒 401（app-ts task-quiz 邮箱查询失效）。
- **编排/网关/部署一次性切换**：compose（含 client compose）、app-admin `depends_on`、APISIX（3 个 upstream + 23 处 forward-auth）、nginx `auth_request`、app-ts 两个 BASE_URL、`deploy/{docker,k8s,swarm}`、启动脚本全部改指 `app-user`（三端口语义不变）；删除 `app-go/app-auth|app-bili|app-settings` 目录、`ci-app-bili.yml`/`ci-app-settings.yml` 与三个旧镜像矩阵项（新增 `ci-app-user.yml`、镜像 `atoncooper/mind-base-app-user`）。
- **文档/规范**：AGENTS.md §2.13 重写为 app-user 用户域权威章节（§2.16/§2.19 改为合并说明），目录树/定位索引同步；docs/{architecture,configuration,getting-started,deployment,client-compose,api,project-structure,README,app-admin,app-cloud,app-kg,features,setup-guide,sharing,academic-agent,service-key-auth}.md 同步为 app-user；archive 文档加历史注记。

## [Unreleased] — 2026-11-04

### Added

- **云盘智能化 P0**：图片/截图/扫描 PDF 走 vision OCR 入库（pdfcpu 提取页图，`pipeline.ocr.*` 可配）；文档 L1 摘要新增可执行待办并通过 `GET /cloud/video/{uuid}/summary` 暴露；新增文件夹范围的 `GET /cloud/search/semantic` 与 `GET /cloud/video/{uuid}/similar`；云盘详情页展示 AI 摘要/标签/关键点/待办/可回答问题与相似文件，支持「问这份文件」（`/chat?upload_uuid=`）；聊天来源支持云盘文件深链；app-ts 新增 `cloud_doc_summary` 工具（经 `/internal/cloud/summary`，uid 由会话注入）。摘要模型默认 `z-ai/glm-5.3-flash`，OCR/摘要均复用 Higress embedding 网关连接。

### Changed

- 非音视频云盘文件初始 `asr_status` 改为 `not_supported`（不再永远显示转写中）；OCR/摘要/语义检索失败按可重试与永久不支持分流。

## [Unreleased] — 2026-11-03

### Changed

- **支付后台并入统一管理后台**：独立服务 `app-pay-admin`（Go + SSR WebUI，:8003，profile `pay-admin`）退役，支付运营能力（订单 / 会员 / 权益事件 / 回调流水 / SKU 查询、会员补偿开通、退款复核）并入 `app-admin`（`app-go/app-admin` API + `frontend-admin` SPA）。统一账户 `admin_user` / `admin_session` / `admin_audit`、统一角色 admin/viewer、统一入口 :3001（API :8016，均仅回环）。app-admin 新增第二 GORM 连接直连 `app_pay`（只读 + 会员补偿开通，唯一资金写）；退款复核经 APISIX pay-ops consumer 调 app-pay internal 端点执行。配置迁移 `PAYADMIN__*` → `APPADMIN__PAY_*` / `APPADMIN__PAY__*`；资金审计 JSONL 统一为 `logs/pay-audit.jsonl`（哈希链，365 天）。旧 `payadmin_user` 账户不迁移（运维在「账户」页重建）。
- **部署/CI 同步退役**：compose 删除 `app-pay-admin` 服务与 `app_pay_admin_logs` 卷、移除 `--profile pay-admin`；删除 `deploy/docker/95-app-pay-admin.yml`、`deploy/k8s/30-apps/app-pay-admin.yaml`、`.github/workflows/ci-pay-admin.yml` 与 docker-build 矩阵条目；`deploy/docker/96-app-admin.yml`、k8s `app-admin`、swarm stack 的 app-admin 注入支付库 / ops key / 资金审计路径。
- **文档**：`docs/app-admin.md` 重写为统一后台（分享审核 + 支付运营 + 沙箱 + 统一账户/审计 + 配置/API/启动/迁移说明/红线）；删除 `docs/app-pay-admin.md`；同步更新文档索引、架构、配置、部署、功能、API、FAQ 等引用。
- **管理后台登录安全加固**：所有管理端请求携带 `X-Device-Id`，登录会话绑定设备指纹（SHA-256，strict/id/off 可配）；会话 IP 绑定（exact/subnet，IPv4 /24、IPv6 /64）；可信代理白名单解析真实客户端 IP；IP 级 + 账户级双限流，登录失败/新设备/新 IP/会话设备或 IP 不匹配全部写入审计；CORS 仅接受同源/精确 Origin（拒绝 `*`/`null`，放行 `X-Device-Id`），并增加 CORP/COOP 安全头。

### Documentation

- **根 README 重写为项目介绍**：从「功能清单 + 目录索引 + 接口表」改为定位、核心能力、架构一览、快速开始与文档导航；结构、API、FAQ 分别迁入独立文档，避免与代码漂移。
- **新增文档**：`docs/features.md`（功能全景：问答/科研/沙箱/KG/笔记/云盘/测验/会员/管理台）、`docs/project-structure.md`（目录、代码落位、依赖方向、测试矩阵）、`docs/api.md`（请求入口、鉴权、前缀、SSE 帧、错误约定）、`docs/faq.md`（运行环境、数据、AI 密钥、科研沙箱、管理台、开发）。
- **重写过期文档**：`docs/setup-guide.md`（普通用户 Docker 上手：密钥文件、必填项、Higress 控制台配置供应商、验证与排错，移除「把 DashScope key 填进 .env」的旧流程）、`docs/getting-started.md`（当前 Node 22.17 / Go 1.25 / compose 技术栈，含 `.env` 必填项、APISIX 9080 override、逐服务本地启动与测试）、`docs/deployment.md`（入口/密钥、profiles 真实语义、HTTPS、监控、备份恢复、扩容、沙箱与 K8s、升级回滚）、`docs/code-execution.md`（run_code → app-sandbox → OpenSandbox 链路，替代 Python/Daytona 描述）。
- **架构文档补齐**：`docs/architecture.md` 增加 app-sandbox / opensandbox-server 服务与端口、`/academic` 与 `/internal/sandbox` 路由、沙箱 5 表数据归属、app-sandbox 配置入口、CI 现状（app-cloud/app-sandbox 无独立 workflow、docker-build 19 镜像）。
- **文档索引与链接清理**：重写 `docs/README.md` 索引（覆盖全部现行文档与归档）；移除指向 `plan/`（不入 git）、`app-mobile`、根 `AGENTS.md`（不入 git）的失效链接，修正 archive 相对路径与 `deploy/` 下两处失效链接；`api/README.md` 标注为 Python 时代历史存档，`deploy/china/README.md` 标注为历史快照（仅镜像加速器配置仍适用）。

### Removed

- **桌面端拆分为独立仓库**：`mind-base-desktop/`（Tauri 2 + Rust + React）迁至 [atoncooper/mind-base-desktop](https://github.com/atoncooper/mind-base-desktop)（含全部 git 历史；该仓库新增 README、MIT LICENSE 与 CI/Release workflow）。本仓删除桌面端源码、`docs/{mind-base-desktop,desktop-cross-platform,desktop-rust-architecture,automation}.md` 四篇文档、`.github/workflows/{ci-desktop,desktop-release}.yml`，并同步清理 README / architecture / features / faq / project-structure / docs 索引 / vscode 配置中的相关引用。

## [mind-base-desktop 0.2.0] — 2026-11-01

桌面端「科研工作台 + SSH 远程 + 对话体验」版本：科研控制台补齐 repositories 数据层、AI 选刊与 AI 计划、论文导入与原生 Word/PDF 展示、Google Docs 风格写作；SSH 升级为独立包，支持主机管理、交互终端、SFTP、本地端口转发、会话日志与跨平台凭据；对话新增思考过程、消息排队、DeepSeek 官方搜索，并修复工具参数泄漏与空回复。完整介绍见 [mind-base-desktop/RELEASE_NOTES_0.2.0.md](mind-base-desktop/RELEASE_NOTES_0.2.0.md)。

### Added

- **科研工作台**：repositories 数据层；AI 推荐期刊；AI 研究计划（生成/持久化/勾选/AI 执行）；论文导入（PDF/DOCX/MD/TXT/TeX/HTML）与原生 Word/PDF 优先展示；DOCX 表格转 Markdown、OMML 公式转 LaTeX；导入时自动解析参考文献入库；文件导入与文件 tab 等高布局。
- **写作**：Google Docs 风格只读全文画布 + 阅读内编辑；文档选择 popover（搜索/类型筛选/新建/重命名/删除）；大纲抽屉；导出结果条；阅读整篇 + 目录 + 进度 + KaTeX。
- **SSH**：infra/ssh 子包；主机管理/连接测试/指纹固定；xterm 交互终端 + 高亮命令输入；SFTP；本地端口转发；会话日志；已知主机；keyring 跨平台凭据与 DPAPI 迁移。
- **对话**：思考过程展示与持久化；消息排队；DeepSeek Search/Fetch 优先；重新生成/重试 refresh 图标；AI 回复复制图标；科研侧栏收起。
- **跨平台**：macOS/Linux Python venv；跨平台 FFmpeg sidecar 脚本；docs/desktop-cross-platform.md。

### Changed

- 学术 agent 提示词：项目模式强制 academic_project / academic_literature / academic_manuscript 工作流；最终回答必须自然语言总结；正文避免过度加粗/标题化。
- 写作默认原生文档，Markdown 仅在原生渲染失败时作为回退；导入文件保留原文件。
- 分析脚本编辑器升级为 VS Code 风格（Prism 高亮/行号/Tab 缩进/IME）。

### Fixed

- 启动 panic（manuscript_sections.document_id 索引先于列迁移）；科研动态事件 payload/分页/时间戳；阶段切换器与侧边栏图标重复。
- 对话工具调用参数泄漏成正文、空回复、重新生成无说明；导入/脚本 textarea 溢出；新建项目输入框溢出与截止日期选择器；远程上传 base64 跨平台兼容。

### Packaging

- 版本号 0.1.16 → 0.2.0（package / tauri / Cargo 及 lockfiles）；desktop-release 读取 RELEASE_NOTES_0.2.0.md 作为 Release 正文。

## [mind-base-desktop 0.1.16] — 2026-10-31

桌面端「Agent 协同 + 学术工作流」版本：学术 agent 可实际检索/导入/核验文献、管理项目阶段、读写稿件、导入数据与跑分析脚本；主 agent 可创建自定义子代理；自动化长任务、token 统计、实时状态恢复与重新生成一并上线。完整介绍见 [mind-base-desktop/RELEASE_NOTES_0.1.16.md](mind-base-desktop/RELEASE_NOTES_0.1.16.md)。

### Added

- **Agent 协同**：chat → research 委托；academic/research → search/memory 二层委托；create_agent / list_agents 自定义 agent（SQLite 持久化、角色提示词、保留内置名）；AgentRun 事件（耗时/步数/token）。
- **学术工具**：academic_literature（Crossref 检索/导入/导出/核验/PDF 下载）、academic_project（列表/简报/阶段/保存建议）、academic_manuscript（章节读写）、academic_evidence（数据集导入、分析脚本、实验记录）；research_ask 升级 ReAct。
- **自动化与成本**：长任务 supervisor + 日志分区 + 报告调度（8 个 automation 工具）；llm_usage token 账本与 usage_stats 工具；缓存命中字段；输入框下方会话用量条。
- **对话体验**：后端 live 快照 + 前端轮询恢复（切会话/切视图/刷新不丢实时状态）；最后一条回答重新生成（后端替换、不重复写 user）；DSML 工具调用兜底解析。
- **工程**：Rust 新增 toolkit / sandbox / automation 包；测试迁入 tests 分包；VS Code 工作区/任务/扩展配置。

### Changed

- 科研控制台不再把每条回答自动写成「阶段建议」，只有 AI 显式 save_advice 才落库；文献/数据/稿件操作只更新对应数据。
- 主 agent 对用户透明（聊天不再显示身份）；科研上下文引用纪律收紧（只引用项目已登记证据，无关知识库素材不得引用）。
- OpenCode 系提供方请求自动携带 x-opencode-session + 自有 UA。

### Fixed

- 科研控制台建议不落库 / 文献导入后前端不刷新；聊天切走后实时步骤与 pending 消息丢失；API 设置长文本溢出与输入框边距；logging 死代码警告。

### Packaging

- 版本号 0.1.15 → 0.1.16（package / tauri / Cargo 及 lockfiles）；desktop-release 读取 RELEASE_NOTES_0.1.16.md 作为 Release 正文。

## [mind-base-desktop 0.1.15] — 2026-10-29

桌面端「Google 化」大版本：全站 Google 配色、Gemini 风格对话、Coding Plan / OpenCode 模型配置、科研工作台与项目信息编辑。完整介绍见 [mind-base-desktop/RELEASE_NOTES_0.1.15.md](mind-base-desktop/RELEASE_NOTES_0.1.15.md)（同时作为 GitHub Release 正文）。

### Added

- **模型配置中心**：目录驱动提供方（DeepSeek、GLM 编程套餐国际/国内、Kimi 编程套餐、MiniMax 国际/国内、Qwen Token 套餐国际/国内、小米 Token 套餐 AMS/国内、OpenCode Zen/Go、Anthropic/OpenAI/Moonshot 官方、DashScope/OpenRouter/自定义兼容端点）；协议感知的测试连接、模型列表拉取、设为默认。
- **Anthropic Messages 协议适配**：请求/流式/工具调用/图片/tool_result/token 用量双向翻译，Claude、MiniMax、Kimi Coding 等套餐可正常对话。
- **科研工作台**：六阶段步骤条、项目信息、阶段产物、动态、文献导入/核验/导出、数据画像/脚本、章节写作/DOCX 导出；项目信息支持内联编辑（名称/论文类型/领域/目标期刊/截止日期）。
- **Gemini 风格对话**：顶栏模式分段、空态问候与建议胶囊、两行 composer、模型药丸与加号附件/上箭头发送。

### Changed

- **全局 Google 配色**：页面 `#f8f9fa` / 卡片白 / 侧栏 `#f0f4f9` / 主色 `#0b57d0`（深色 `#131314` / `#1e1f20` / `#8ab4f8`）；主按钮、选中态、进度条、徽标统一蓝色；新增 `--page` 区分页面底色与卡片表面。
- 设置页改为 Google Workspace 风格（M3 tabs / 卡片 / 控件）；对话侧栏收起态不渲染文字。

### Fixed

- `.shell` 因 flex + `margin:auto` 退化为 shrink-to-fit，内容少时页面缩成窄条。
- 窄窗留白过大、滚动条导致的宽度跳动；长表格撑出横向滚动条。
- 设置页 scoped 样式压过 `[hidden]`，三个 tab 同时渲染。
- 对话侧栏收起时文字逐字竖排、窄窗出现点不动的「展开历史」控件。

### Packaging

- 版本号 0.1.14 → 0.1.15（`package.json` / `package-lock.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock`）；desktop-release 工作流优先读取 `RELEASE_NOTES_0.1.15.md` 作为 Release 正文。

## [mind-base-desktop 0.1.14] — 2026-10-26

桌面端首个「agent 能力对齐」版本；完整介绍见 [mind-base-desktop/RELEASE_NOTES_0.1.14.md](mind-base-desktop/RELEASE_NOTES_0.1.14.md)（同时作为 GitHub Release 正文）。

### Added

- **结构化交互 / 联网 / 多模态 / 成本与稳定性**：`ask_user` 交互卡片、`web_search` 联网搜索、主动图片输入、后台任务入口、exports 产物卡片、token 用量脚注、DashScope `gte-rerank` 精排、工具执行硬超时、文件工具沙箱。
- **academic agent 全链路可达**：delegate 目标、后台任务 `parse_agent`、`harness_tools` 归属补齐。

### Fixed

- 日志模块时间转换测试的纪元常量笔误；OCR 测试共用临时目录导致的并行 flaky。
- package-lock / Cargo.lock 版本字段同步（0.1.14）。

### Packaging

- 版本号 0.1.13 → 0.1.14（`package.json` / `tauri.conf.json` / `Cargo.toml` / lockfiles）；`desktop-release` 工作流发布时优先读取 `RELEASE_NOTES_<version>.md` 作为 Release 正文，缺失才回退自动生成。

## [Unreleased] — 2026-09-25
- **移除 `app-mobile`**：移动端不再纳入规划，删除 Flutter 客户端及其文档/工作区引用。
- **科研工作台 404 修复**：主 Nginx 缺少 `/academic` location，`/academic/*` 请求落到 Next SPA 返回 404；已加 `location /academic` 转发 APISIX（forward-auth 401 生效），并重建 app-ts 镜像（旧镜像缺少 academic REST 路由）。
- **科研工作台布局**：`/research` 改为 flex 纵向布局（header + `flex-1` 内容区），左侧项目列表 `flex-1` 与右侧详情同高、各自内部滚动；修复两栏高度不一致。
- **admin 登录 502 修复**：frontend-admin 的 Nginx 对 app-admin-api 使用静态 upstream，容器重建后 IP 变化导致 502；改为 Docker DNS 动态解析（`set $admin_api`），并重做登录页（品牌区 + 表单区、响应式）。
- **P0：沙箱配额档位静默降级为 free 修复**：`app-sandbox` 的 Docker Compose/K8s 清单未注入 `APP_PAY_BASE_URL`，`QuotaService.TierFor` 在 URL 为空时直接返回 free，导致 SVIP/VIP 用户按普通用户额度执行；已补 `APP_PAY_BASE_URL=http://apisix:9080/internal/pay` 与显式 `APISIX_CONSUMER_KEY`，并在 `NewQuotaService` 启动时对空 URL 打 WARN（不再静默）。实测 uid 233830818118639616 解析为 `svip`（academic_run=600、concurrent=5、cpu=10800、artifact=2GiB）。
- **OpenSandbox Docker 运行时兼容修复（实测）**：metadata 值按 OpenSandbox label 规则清洗（specHash 64→63 字符）；`/files/upload` 的 metadata part 增加 `filename`（execd 要求）；执行前 `mkdir -p /workspace` 并以 `/tmp` 为 cwd（基础镜像无 /workspace）；execd 实际返回 **JSON-line 流**（非 `data:` 前缀），解析器兼容两种格式并在缺少 `execution_complete` 时报错（避免假成功）；`/ready` 的 runtime 探针改走 lifecycle 根 `/health`（而非 `/v1/health`）。
- **app-ts MongoDB 引入 MikroORM（试点）**：新增 `@mikro-orm/core`/`@mikro-orm/mongodb` v7，学术 evidence 仓储（`academic_runs`）新增 MikroORM 实现（EntitySchema、同一集合/索引、uid+project 过滤、implicitTransactions=false、失败回退直接驱动）；配置 `MONGO__ORM=mikro|driver`；MikroORM 7 要求 Node >=22.17（`app-ts/package.json` engines 更新）；说明见 `docs/mikro-orm.md`。

### Changed

- **app-pay 升级 Java 21**：`java.version` 17→21（LTS），构建/运行镜像 temurin 17→21（`Dockerfile` + `Dockerfile.local`）、CI setup-java 同步。代码层扫描零不兼容（无内部 API / finalize / SecurityManager / 已移除 Thread API 依赖；`javax.sql`/`javax.xml` 为 JDK 自带模块不受影响），Boot 3.5 官方支持 21，BOM 管理的 Lombok/ByteBuddy 均兼容。JEP 400 下默认字符集已是 UTF-8，容器内 LANG/file.encoding 双保险保留无害。回滚 = revert 工具链四处，无 schema/数据影响。
- **镜像发布切换标准 Docker Hub**：CI（docker-build）由 GHCR 改为发布 `atoncooper/mind-base-*`，矩阵从 4 个服务扩到 7 个（新增 app-auth / app-cloud / app-board，构建上下文对齐 compose）；compose、k8s 清单与 `.env.example` 中全部 `ghcr.io/atoncooper/mind-base-*` 引用同步改为 Docker Hub。需在 GitHub 仓库配置 secrets `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 后生效。app-board-mcp 的 Dockerfile 位于 `mcp/app-board-mcp/`，随下条一并补入矩阵。
- **MinIO 镜像自托管（atoncooper/mind-base-minio）**：上游已将社区版 MinIO 从所有渠道下架——Docker Hub 仓库整体删除、`dl.min.io` 二进制全部 410、GitHub 仓库归档为"仅源码"，原固定 tag `minio/minio:RELEASE.2024-11-07T00-52-20Z` 永久无法拉取（全新主机 `docker compose up` 时这几个缺失镜像 pull 秒失败并连带取消其余镜像下载，报成一片 `No such image`）。新增 `scripts/minio.Dockerfile`，以最后一个仍发布官方二进制的 release（`RELEASE.2025-09-07T16-13-09Z`，GitHub release 资产直取）打包为 `atoncooper/mind-base-minio:latest`；compose/k8s/china/devops 四处引用同步替换。CI 矩阵扩至 9：另新增 certgen（`atoncooper/mind-base-certgen`，替代仅本地构建的 `mind-base-certgen`）。compose 全部自建镜像硬编码，`*_IMAGE` 环境变量包装移除（`.env.example` 同步）。

### Removed

- **frontend/ 目录移除**：第一代前端 `frontend/`（dock-modules 体系，2026-08 起废弃、compose/CI 早已切换 `frontendv2/`）从本仓删除；活跃用户前端为 `frontendv2/`（Next.js 16，`lib/api/` 按域分模块为唯一 API 调用入口）。AGENTS.md §2.4 的逐文件说明替换为 frontendv2 约束与 SSE 帧规范指针。
- **app-task 目录移除**：app-task 已拆分为独立仓库 [atoncooper/app-task](https://github.com/atoncooper/app-task)（2026-09-29 拆分时已停止追踪，本次删除本地嵌套 checkout 目录），并顺带清理 4 个 Python 时代遗留、早已失效的本地启停脚本（`scripts/start-task.*` / `stop-task.*`）。根 compose 的 `app-task` / `app-task-ha` 服务去掉 `build:` 块，镜像直接写死 Docker Hub 的 `atoncooper/app-task:latest`（不再走 `APPTASK_IMAGE` 环境变量间接；GHCR 镜像仍在）；容器内 TLS 证书持久化由 `./app-task/certs` 绑定挂载改为命名卷 `app_task_certs`（源目录已不存在，绑定挂载会在宿主机复活空目录）。运行方式不变：默认 profile 仍含 app-task；源码开发、独立部署、CLI 与集群文档见独立仓库。

### Fixed

- **桌面端文件工具越权写（write_file 可写任意绝对路径）**：`read_file`/`write_file`/`list_dir` 统一接入沙箱解析——相对路径锁定在 `<data_dir>/agent-files/<agent>/`（保留每 agent 隔离落点），绝对路径仅允许应用数据目录内，`..` 规约后越界统一拒绝；工具描述同步标注限制。
- **artifact 帧失配（Web 端产物永不渲染）**：后端发 `{type:"artifact",artifacts:[...]}`，frontendv2 只读 `data.artifact`。修复：前端兼容数组/旧单对象两种形态，并按 `kind` 渲染 quiz / quiz_grading / 文件型产物。
- **桌面端测试基线**：`logging::tests::epoch_civil_conversion_is_correct` 的纪元常量笔误（951897296→951827696，2000-02-29T12:34:56Z）；`ocr_server` 两个测试共用同一 pid 临时目录导致并行互删（flaky），改为每测试独立目录。
- **提示词漂移**：`app-ts/prompts/agents/main.md` 删除已关闭的 `list_videos`/`get_video_summaries` 指引；`vector_search` 空结果提示不再指向未注册工具。
- **锁文件版本同步**：`mind-base-desktop/package-lock.json` / `src-tauri/Cargo.lock` 版本字段对齐 0.1.13（此前分别滞后在 0.1.7 / 0.1.12）。
- **cert-gen 启动失败（exit 2）**：git autocrlf 把 `scripts/gen-certs.sh` 工作区副本转成 CRLF，容器内 `set -eu
` 报 illegal option 并连锁阻塞 mysql/app-pay-mysql 的启动依赖。修复：`.gitattributes` 对全部 `*.sh` 强制 LF + certgen 镜像构建期剥除 CR 双保险；存量 shell 脚本工作区已归一。
- **APISIX→app-pay https 上游 500**：APISIX 3.11 对带 `tls:` 块（即使仅 `verify: false`）的 https 上游在建立连接时 `parse_pem_cert(nil)` 崩溃，导致 `/internal/pay/*`（会员查询/补偿开通）自上线起不可用。修复：移除 `upstream-app-pay` 的 `tls:` 块（默认不校验上游证书，语义等价）；云盘配额的 VIP/SVIP 提额随之打通（SVIP grant→配额 60TB 已实测）。

### Added

- **桌面端 agent 能力补齐（mind-base-desktop）**：
  - `ask_user` 结构化交互（clarify 选项 / confirm 确认 / form 表单）：本轮结束等回答，作答作为下一条消息；程序化注入系统提示，老安装无需改 prompts md。
  - 产物卡片：`generate_resume`/`generate_slides` 等本轮写入 `exports/` 的文件通过 `ChatEvent::Artifact` 推送到消息内，可一键打开。
  - 后台任务入口：聊天顶栏「后台任务」派发给 6 个 agent（chat/memory/note/code/search/academic），Agent 状态页可查看/注入/停止（后端 spawn 命令此前无 UI 入口）。
  - `web_search` 联网搜索工具：SearxNG（`MIND_BASE_SEARXNG_URL`）→ Bing → Baidu 引擎链，带反爬识别与代理出口；chat/search agent 均绑定并附提示词指引。
  - academic agent 全链路可达：delegate 目标枚举、后台任务 `parse_agent`、`harness_tools` agent 归属。
  - 检索精排：`vector_search` 在 RRF 融合后增加可选 DashScope `gte-rerank-v2` 精排（有 DashScope key 即生效，`MIND_BASE_RERANK=off` 关闭，`MIND_BASE_RERANK_MODEL/URL` 可覆盖；网络/解析失败自动回退融合顺序，不阻断检索）。
  - 主动图片输入：聊天输入框支持粘贴 / 拖拽 / 选择图片（≤4 张、单张 ≤5MB、合计 ≤15MB，data URL 校验），仅视觉模型可用（非视觉模型给出中文提示）；图片随本轮请求发送、不落库。
  - token 计量：`llm_chat` 解析流式/非流式 usage（`stream_options.include_usage`，`MIND_BASE_STREAM_USAGE=off` 可关），`ReactOutcome` 汇总全部 ReAct 轮次 + 成功委托的子代理；新增 `ChatEvent::Usage`、`chat_messages.usage` 列（旧库 PRAGMA 守护幂等补列）与消息底部 tokens 脚注。
  - 工具执行硬超时：`AgentRuntime` 每工具独立线程 + `recv_timeout`（`MIND_BASE_TOOL_TIMEOUT_SECS`，默认 180s），超时降级为可读错误且本轮继续；配合 `Db` 内部 Arc 化、`ToolContext` 去生命周期（owned + Clone）、工具注册表 `Arc<dyn LocalTool>`，panic 也按单工具隔离。
- **Web 端 agent 能力补齐（app-ts + frontendv2）**：
  - 长期记忆持久化：新增 `MongoMemoryStore`（`memory_entries`，索引 uid+createdAt），Mongo 不可达时回落内存并告警；`save_memory` 与召回链路不变。
  - 板聊上下文：chat 路由解析 `board_uuid`/`board_anchor_text`（截断+清洗+模板化），经 `ChatService → harness.extraSystem` 注入主 agent 系统提示，文案落在 `prompts/chat/board-context.md`。
  - plan 工具与计划面板：app-ts 新增 `plan`（create/update/revise；按 chatSessionId 进程内状态，TTL 2h、上限 500 会话），SSE 新增 `plan` 帧（每次变更在 step 边界实时推送），frontendv2 渲染步骤状态面板；主 agent 绑定工具并补提示词。
  - 学术 agent（Phase 1，plan/1.0.17）：新增 `academic` 子 agent（`delegate_to_agent` 可达）与三组仓储化工具——`academic_project`（项目/六阶段/计划/建议）、`academic_literature`（Crossref/OpenAlex/arXiv 检索、BibTeX·CSL 导入、单条入库、DOI 核验、BibTeX 导出）、`academic_manuscript`（文档/章节/大纲/Markdown·LaTeX 导出）；Mongo `academic_*` 集合持久化（不可达时内存降级并告警），文献检索走礼貌池 UA/mailto + 超时；无前端改动（经既有 delegate/step 帧即可用；学术 artifact 已产出，前端渲染留待 Phase 2）。详见 `docs/academic-agent.md`。
  - 学术 agent（Phase 1.5，plan/1.0.17）：内容/性能/文档——项目 brief 增加「文献 N 篇 / 稿件 M 篇」（`count`/`countDocuments` 计数投影，不读正文）、文献库列表分页（默认 30 / 上限 100，先取总数再渲染前 N 篇）、BibTeX·CSL 导入改单次 `addMany`（一次批查 + 一次批量写，批内重复以首条为准）；Mongo 文献新增持久化 `dedupeKey` + `{uid, projectId, dedupeKey}` 非唯一索引、项目更新改 `findOneAndUpdate` 点路径原子 `$set`；文献检索/DOI 核验增加进程内 TTL 缓存（search 5 分钟 / 100 条、DOI 1 小时 / 200 条，空结果与「未收录」null 也缓存，命中返回副本）；`docs/academic-agent.md` 重写为完整开发/运维文档（架构、三工具全 action、数据模型与索引、配置、性能、运维与故障排查、Phase 2 路线，含基准数据）；复核后加固：单条 `add` 去掉整库预读（citeKey 由仓储写时索引派生）、citeKey 批量唯一化批内复用 taken 集合（O(M+N)）、memory `findByDoi` 走 DOI 索引、Mongo 对无 `dedupeKey` 旧行用 DOI 索引兜底判重、索引 DDL 失败仅记 error 不再降级内存。
  - 学术 agent（Phase 2，plan/1.0.17）：新增 `/academic/*` REST 与科研工作台后端——`AcademicService` 统一项目/文献/文档/事件编排、uid 归属与参数校验、文献 DOI 核验、Markdown/LaTeX/BibTeX 导出；`/academic` 经 APISIX 新路由 `academic_ts`（forward-auth 注入 X-Uid）转发 app-ts；服务与路由离线测试 20 例；`defaultManuscriptSections()` 提升为契约纯函数（agent 工具与 REST 共用）。前端 `/research` 科研工作台（项目列表 / 六阶段步骤条 / 概览·文献库·写作·动态四 Tab；`lib/api/academic.ts` 为唯一请求入口，导航「更多→科研」）按同一契约落地，`frontendv2` `npx tsc --noEmit` 通过。
  - 学术 agent P0 修复（2026-11-01）：委派链路透传子 agent 的 `usage`/`artifact`/`plan`/`interact`（子 agent token 计入本轮计量、产物不再丢失）；academic agent 增加 `vector_search`、长期记忆召回与 skills 注入；聊天请求新增 `academic_project_id` 项目上下文（净化 + 归属校验 + 受控 prompt 段落，`/research` 详情头「在对话中继续」）；新增 `agent.maxStepsByAgent`（note 5 / code 4 / quiz 12 / board 6 / academic 12，主 agent 仍 10）。
- **沙箱控制层 app-sandbox（Go，plan/1.0.18 M1）**：OpenSandbox 之上的产品控制层——租约复用（uid+project+purpose+specHash，TTL/回收）、按会员档位配额（academic_run/并发/CPU·秒/产物字节）、审计（uid/项目/镜像/耗时/exitCode/产物 hash）、准入队列、执行超时/取消/sweeper、SSE 事件；HTTP `/v1/executions` + `/internal/leases` + `/health /ready /metrics`。app-ts 侧新增 `HttpCodeExecution`（`sandbox.enabled=true` 时启用，不可达诚实降级为 `sandboxAvailable=false`）与 `academic_evidence` 工具（Mongo `academic_runs`：数据集/run 记录、脚本 sha256、产物元数据）；学术 agent 工具面新增 `academic_evidence` + `run_code`；APISIX 新增 `sandbox_internal`（`/internal/sandbox/*` key-auth）+ compose `app-sandbox` 服务（profile sandbox/full）。M1 验证：Go `build/vet/test` 通过（56 pass + 1 skip）、app-ts 全量 654 通过。
- **OpenSandbox 最小 Docker Compose 部署（plan/1.0.18）**：新增 Compose 资源上限（server 0.5–1 CPU / 512–768M，app-sandbox 0.5 CPU / 256M，单 sandbox 250m / 256Mi，均可通过 env 调整）；
新增 `deploy/docker/opensandbox/`（`config.toml` Docker runtime + `docker-compose.yml` 单服务：Docker socket/execd 注入/SQLite/健康检查）；root compose 新增 `opensandbox-server`（profile sandbox/full），`app-sandbox` 默认切到 `runtime.type=opensandbox`（显式 fake 才演示），通过 `extra_hosts: host.docker.internal` 访问 sandbox execd 端口，sandbox 基础镜像可用 `OPEN_SANDBOX_SANDBOX_IMAGE` 覆盖。
- **OpenSandbox Kubernetes 部署（plan/1.0.18）**：新增 `deploy/k8s/40-sandbox/`（官方 umbrella chart release-1.2.0 的**生产化**安装包：`install.sh` 支持 dev/prod profile、`--dry-run`、`--smoke`、`--with-policy`；`preflight.sh`/`uninstall.sh`；`values/` 三档覆盖（HA gateway、controller metrics、资源/反亲和/拓扑分布）；`manifests/` 含命名空间、`pool-python` 热池、PDB、NetworkPolicy、ServiceMonitor/PodMonitor、端到端 smoke Job；base→controller→ingress-gateway→server，禁用 fast-sandbox/node-agent）与 `deploy/k8s/30-apps/app-sandbox.yaml`（runtime=opensandbox、lifecycle ClusterIP DNS、execdPort 44772、poolRef、API Key Secret、单副本 Recreate）；app-admin 接入 `APPADMIN__SANDBOX_ADMIN__*`；compose/.env.example 增加 `OPENSANDBOX_API_KEY`，APISIX 沙箱路由收窄为 `/internal/sandbox/v1/*`；适配器支持无 scheme 的 gateway endpoint、`extensions.poolRef`；app-sandbox `/ready` 新增 runtime 探针（lifecycle `/health`），K8s 清单加固为非 root/只读根文件系统/drop ALL/seccomp/PDB。
- **沙箱管理面板（app-admin + frontend-admin，plan/1.0.19）**：app-sandbox 新增 `/internal/admin/*`（`X-Admin-Token`，未配置 503/错误 401）——overview、执行/租约分页过滤、执行详情（截断预览+产物元数据+审计）、取消执行、强制回收、配额、审计、运行时配置；管理查询走 uid/state/created_at 索引，写操作落 `actor=admin` 审计。app-admin 新增 `/api/sandbox/*` 代理（viewer 读/admin 写，4xx 透传、5xx→502、未配置→503，写成功写 `admin_audit`），配置 `APPADMIN__SANDBOX_ADMIN__{BASE_URL,TOKEN}`；frontend-admin 新增 `/sandbox` 页面（概览/执行/租约/配额/审计 + 详情 Drawer + admin 取消/回收确认，viewer 只读）；compose 与 `.env.example` 增加共享 `SANDBOX_ADMIN_TOKEN`。验证：app-sandbox 67 PASS/2 SKIP、app-admin 全绿、frontend-admin `npm run build` 通过。
- **移动端 app-mobile（Flutter）首次入库（🚧 测试阶段，尚未开发完成）**：B站收藏知识库的 Flutter 客户端，零后端改动、走同一套 APISIX 路由。已具备：聊天（SSE 流式 / 抽屉会话 / reasoning / 来源 / artifact，帧语义对齐 frontendv2）、收藏夹、笔记（Markdown + If-Match 乐观并发）、云盘、测验、会员中心（Google 式扁平 UI）、设置与登录（B站扫码 + 密码）。工程面：全平台 MiSans 字体统一（斜体/等宽链/字重映射守护测试 + `ext.app.fontProbe` 运行时探针）、组件主题 TextStyle 从 textTheme 派生（修复 ListTile 字体继承断裂）、侧边栏边缘右滑 + 半屏宽度 + push 不关抽屉、输入框桌面 Enter 发送与拍照/相册/文件附件、金样回归（侧边栏/笔记/会员中心）与 20 项测试全绿。**请勿用于生产**：推送通知、云盘后台上传等未完成，iOS 未实测，详见 `app-mobile/README.md`。
- **云盘服务迁移（app-go/app-cloud）**：云盘整体迁至独立 Go 服务（:8007），并完善为对标百度网盘的能力面——**存储配额**（免费 10GB / VIP 6TB / SVIP 60TB，init 上传即校验超限 413，用量条上屏）、**百度式分享**（token 链接 + 可选 4 位提取码（哈希存储）+ 有效期 + 下载上限 + 查看/下载计数，公开页 `/cloud/s/{token}` 免登录可达，访问发放 15 分钟短时效预签名 URL）、**回收站**（删除改软删，MinIO/Mongo/Milvus 数据保留 30 天供恢复，后台 sweeper 自动清理；新增恢复/彻底删除端点）、**文件搜索**。**文档解析+向量化管线全部 Go 重写**（PDF/docx/xlsx/pptx/markdown/html/文本提取 → 语义分块 → Higress 网关 embedding → Milvus cloud_drive（启动 schema 守护）→ Mongo 全文 → 三层一致性校验），同一 bucket/key 零数据迁移，RAG 混合检索无缝命中 Go 写入的向量。backend 云盘代码全量删除（cloud router / upload/processing/cleanup 服务 / cloud 仓储 / doc_parser，保留笔记转化用的只读 document_text），APISIX 新增 `/cloud/*` 兜底路由直达 app-cloud——云盘请求在代码与网关两个层面都不再经过 Python backend；WS 状态经 Redis pub/sub 桥接保持前端推送不变。
- **SVIP 档位**：app-pay SKU 种子新增 SVIP 月/季/年（占位价），`MembershipService.extend` 支持 tier（订单 SKU 前缀 `SVIP_*` 自动判定），运营补偿开通（API + PayAdmin 界面）可选档位；云盘配额按 membership tier 自动生效。

- **app-task 控制台 v0.12（标识治理 + Bootstrap 3 UI 体系）**：四项治理——①**script_id 系统生成**：控制台新建脚本不再要求手填 ID（服务端生成 UUID，编辑只读保留；`/scripts` API 保留显式 id 供自动化 upsert）；②**API 密钥名称全局唯一**：`api_key.name` 加 DB 唯一索引（含已吊销，存量重名行启动时自动 `-dupN` 迁移），引导密钥改按名称 upsert（env 轮换重启即生效，不覆盖用户行）；列表页补 `key_id` / `secret_id` 列，密钥库更新/删除改为按 `secret_id` 寻址（创建时即生成 UUID，修复运行期新建行 ID 为空导致按 ID 操作失效的隐患）；③**任务属主自动化**：控制台建任务不再手输 uid，自动归属当前登录用户（webui_user id；`/api/tasks` 省略 uid 时同样回填，显式 uid 与 master token 行为不变）；④**WebUI 迁移到 Bootstrap 3.4.1**（vendor 进 assets，MIT）：全部页面模板重写为 navbar/nav-tabs/panel/table/form/label/alert/modal/pagination 组件体系 + MindBase 主题层，modal/dropdown 用原生 JS 开关（不引 jQuery），提交 loading 与代码编辑器保留。生效需重建 app-task 容器。

- **app-task 脚本编辑器升级 CodeMirror 5**：替换原「透明 textarea 叠加高亮 pre」手写编辑器，vendor CodeMirror 5.65.16（MIT，进 go:embed，无构建步骤）：Lua mode（官方词法）+ JSON mode、括号匹配与自动补全、活动行高亮、Ctrl-/ 行注释（`--`）、Ctrl/Cmd+S 保存（requestSubmit 走完整提交链，保证 CodeMirror 内容同步与 loading 态）、行号 + Ln/Col/行数状态栏；手写 overlay 的高亮器/行号/缩进逻辑全部删除。新建任务页 payload、脚本试运行 payload、任务详情/脚本详情/运行结果只读视图统一换用同一引擎渲染；`AppTaskEditors` 注册表供页面脚本读写编辑器实时值（lua 任务提交注入 script_id 不再怕被提交同步覆盖）。vendor 资源加载失败时优雅降级为普通 textarea。
- **app-task CLI（`at` 命令，docker 风格）**：单二进制双角色——无参数/`at serve` 启动服务端（完全向后兼容旧 `go run ./app-task`），其余为客户端命令：`at info`（docker info 式概览）、`at ps`/`at task ls|create|inspect|logs`、`at script ls|upload|inspect|run`、`at logs`、`at email ls|retry`。cobra 命令树 + 全局 `--url/--token`（env 回退链 AT_URL/AT_TOKEN/APPTASK__WEBUI__TOKEN，默认 127.0.0.1:8001），双凭据头（X-WebUI-Token → /api/*、X-API-Key → 服务面），tabwriter 表格 + 全线 `--json`；`task create` 属主默认自动归属当前凭据、`--trigger-time` 接受本地时间格式并转 UTC RFC3339、`--script-id` 自动注入 payload；`script upload` 省略 id 时服务端生成 UUID。main.go 瘦身为 CLI shim（//go:embed 保留），服务端逻辑移入 internal/cli/serve.go。
- **app-task 调度器并发化 + 集群化（无主多实例）**：①**并行派发**——每个 tick 认领一批到期任务（`ClaimTasksBatch`：事务 + MySQL `FOR UPDATE SKIP LOCKED`，多实例读到互不相交候选集，正确性由事务内 status 过滤保证）并由独立 goroutine 并行派发，并发受全局 worker 池（`scheduler.workers`，默认 16）与按 executor_url 并发闸（默认 8）两级限制，饱和任务释放认领下个 tick 再试；新增瞬态 `dispatching` 状态（owner/claimed_at 可溯源），超时（默认 120s）被任意实例回收重派（at-least-once，执行器契约本就要求幂等）；优雅停机等待在飞派发。②**集群管理**——无主对称架构，多实例零选主组件：认领互斥（条件更新）、dispatching 回收、cron 延展去重、running 超时判定全部条件更新天然多实例安全；tick 随机抖动错峰；`/api/stats` 暴露 workers/inflight；控制台任务列表加 dispatching 筛选与认领实例展示。③**控制台状态可外置**——`webui.session_store: redis`（配 `redis.url`，共享主 app/app-auth 的 `REDIS__URL`）将会话/密钥一次性展示/每 IP 失败节流/每密钥限流计数迁 Redis（节流与限流 fail-open，对齐 app-auth 语义），默认 memory 单实例零依赖。出站 HTTP transport 调 `MaxIdleConnsPerHost` 匹配池宽。验收：并行派发 10×300ms 任务单 tick 完成；双实例并发 tick 20 任务不重不漏；优雅停机等待在飞。**集群排查补漏**：邮件投递 worker 原本无认领语义（裸 SELECT + 无条件更新，双实例必重复投递）——补齐同款模式：`ClaimEmail`（pending→sending 条件认领）+ sending 超 2 分钟回收重发 + Mark 系列按 sending 态守卫，EmailMessage 补 updated_at 列；双 worker 并发 8 邮件恰好各投一次、稳态零重复。**部署配置**：根 compose 与独立 compose 各加 `app-task-ha` 服务（profile=ha 显式启用，端口 8011，INSTANCE_ID 已设，调度态全在 MySQL 无需共享组件）。**一致性加固（fencing + cron 原子延展）**：①每次认领铸造 `claim_token`，finalize/release 按 token 栅栏——卡顿超 TTL 的陈旧持有者无法覆盖新认领（孤儿结果丢弃并记 WARN），把 at-least-once 执行收敛成 exactly-once 状态转换；②cron 延展改「条件占用链接 + 插入」单事务，消灭并发延展下输家已插入孤儿 next occurrence、导致周期任务多跑一次的竞态；③批量认领结果改为事务内按 claim_token 回读（不再信任候选列表与影响行数相等），正确性从"依赖锁子句"解耦为"只依赖 status 过滤 + token 回读"；④**权重分摊**：`scheduler.weight`（默认 1）按 `weight/集群内最大存活权重` 缩放各节点认领上限——manager 等兼职节点调低权重即自动少拿任务，最大权重节点宕机后其余节点自动回满；权重经心跳进名册，仪表盘/API/`at node ls` 展示。⑤**配置占位符**：`default.yaml` 支持 `${VAR}` / `${VAR:默认}` 占位符（加载时从环境展开，godotenv 先行加载 .env——与主 app loader 语义一致）；`rdbms.url`/`email.api_key`/`webui.token`/`redis.url`/`tls.cert/key`/`http_executor.ca_file` 已改为占位符引用（未设时为空，字面量默认值不受影响），`.env` 继续只放密钥。原 `APPTASK__` env 覆盖通道保留，两通道结果一致。**MySQL/Redis 连接配置补全**：MySQL——`conn_max_idle_time`（空闲回收）、`dial/read/write_timeout_seconds`（go-sql-driver 读/写默认无超时，hung DB 会冻结 worker，现强制有界）、`tls`（true/skip-verify，配合集群 mTLS/X509 方案）、`prepare_stmt`（GORM 预编译缓存）、`slow_threshold_ms`（慢查询 WARN）；池默认上调 max_open 25/max_idle 10（匹配 16 worker 并发）。Redis——`pool_size`/`min_idle_conns`/`dial|read|write_timeout_seconds`/`max_retries`（0=库默认；rediss:// 走 TLS；故障时限时失败配合 fail-open）。构建重构：`db.Init(db.Options{...})`、DSN 参数由 config 组装（toGormDSN 参数注入+缺 host 报错，测试钉死）、`newRedisClient`（ParseURL+池/超时覆盖）。加入节点流程（Web/CLI）：控制台「集群」页（名册/待接入/加入表单/指引展示）+ `POST /api/cluster/join`（admin）+ `at node join`——预登记 node_id/weight（幂等刷新、active 冲突 409、登记人留痕）并即时生成加入指引（RDBMS 连接串永不经 API 回显）；新节点首次心跳自动转正（joined_via=auto/cli/web 溯源）。**准入闸门**：`cluster.admission: pre_approved`（默认 open）时未预登记节点 fail-closed 拒绝启动（Manager.Start 返回错误→serve 退出），指引文本按服务端准入模式自动附提示；威胁模型已在 README 明示（防误配置，不防持库凭据者）。**安全审查补漏**：①集群名册/`/api/cluster`/控制台集群页从 member 可见提升为 **admin 门**（主机名/版本/拓扑属内部信息）；②node_id 加字符集校验 `^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$`（流向 slog/task.owner/重定向——防日志注入与标识符污染，API/表单/CLI 三处共用）；③weight 上限 1–1000 + 调度器钳制 ≤10000（防加权算术溢出）；④测试：member 403/字符集 400/超重 400/溢出钳制。**基准测试（`app-task/bench/`，独立于 internal 的黑盒包）**：5 组 benchmark 覆盖认领热路径——批量认领事务（backlog 10/1k/10k）、并发认领竞争（1/4/8 claimants，claim+give-back 往返）、认领+fencing finalize 往返、邮件认领+栅栏标记、**黑盒整管道排空吞吐**（种子 1000 任务→真实调度器 1ms tick 排空，自定义 tasks/s 指标，workers 8/16/32 扫描）；内存 SQLite（诚实注释：绝对值非生产数，用于路径对比与回归），种子/清理经 StopTimer 排除在测量外；运行方式 `go test -bench . -benchmem -run '^$' ./bench/`。**并发与一致性测试并入**（bench/concurrency_test.go，6 项不变量：认领排他性/栅栏 finalize/混合负载排空完整性/邮件认领唯一/cron 原子/死节点接管，黑盒导出 API + 内存 SQLite 证明不变量，MySQL 行锁语义另行覆盖）；**DB 路径基准扩充**（db_bench_test.go：单行认领往返/释放往返/回收清扫/候选扫描/task_log 插入；cluster_bench_test.go：心跳 upsert/预登记 upsert）。测试与基准均未运行（按用户要求只交付代码供 review），编译+vet 通过。**文档体系**：新增 app-task/docs/（cluster.md=集群与分布式一致性权威文档：架构论证/派发生命周期/fencing/权重/加入流程/runbook/一致性模型/FAQ；cli.md=at 命令行完整参考：双角色/认证链/全部命令/脚本化/常见错误），README 相应章节挂链接。⑥**`internal/cluster` 集群管理包**：节点名册（cluster_node 表）+ 心跳（10s，3 次失联判死）+ 优雅注销 + 死节点快速接管（调度器每 tick 先接管失联节点的 dispatching 认领，不等 TTL；fencing 保证安全）+ 24h 溯源清理；可观测三件套=控制台仪表盘「集群节点」面板 / `GET /api/cluster` / `at node ls`。⑤README 新增「一致性模型」章节（保证性质/显式取舍/时钟容忍度）。生效需重建 app-task 容器。
- **app-task 品牌标重绘（T 字 monogram）**：弃用旧「蓝弧 + 白勾」渐变贴，改为 MindBase M 字标的同族语言（`mind-base-desktop/dist/mb-icon.svg`：墨贴 #141413 + 纸白 #fafaf8 单字，字重 2.4、字位 y10–22、右下小方块光标点）绘制 **T** 字标；光标点用 app-task 蓝 #5b8dff 作子品牌区分。深色背景（导航栏/登录侧栏/插画中心徽标）自动反转为纸贴墨字，浅色（favicon/登录表单）用墨贴原版；登录页大插画中心徽标同步替换。

- **认证服务迁移（app-go/app-auth）**：身份认证整体迁至独立 Go 服务（Gin + GORM，:8006），成为全栈认证权威——session token 签发/校验、4 种登录方式（B站扫码（Go 原生 passport 客户端）/微信/邮箱密码/手机短信）、账户/资料/设备/会话管理、验证码体系（Resend + 阿里云短信）、RBAC。auth 表（users/user_tokens/user_oauth 等 9 表）schema 所有权移交 app-auth（同库接管，只建表不改表，守护测试钉死）；token/bcrypt/AES-GCM/雪花 ID 四项与 Python 侧字节级兼容（fixture 测试钉死），存量用户与前端零感知切换。认证面完成四层限流加固：nginx `/auth`（1r/s burst3 + 每IP并发5）→ APISIX `auth_user` 路由 limit-req（10r/s burst20）→ app-auth 每 IP 全局 5rps + **16 条 per-endpoint 规则**（per-IP/per-identifier/per-uid 三维，默认值对齐原 Python `rl_*`，配置可覆盖）→ 登录节流（5 次失败锁 15min）+ 单次图形验证码。**生效需重建 backend、app-auth、apisix、nginx 容器（已执行）。**

### Changed

- **认证切换 X-Uid 信任模型**：APISIX forward-auth 权威改为 app-auth `/internal/auth/verify`（宽验证：无凭证放行、坏凭证 401、有效注入 X-Uid/X-Roles）；catch_all、/chat、/ws 新挂 forward-auth，所有 forward-auth 路由剥离客户端伪造身份头；backend 21 个 router 的 `get_current_uid`/`require_admin` 改读网关注入头（不再查库）；nginx `/cloud/`（大上传直连路径）经 auth_request 子请求接入 app-auth。backend 旧登录端点与 `services/auth/` 暂保留一个发布周期作回滚余量。


### Added

- **聊天·按轮重写与编辑**：任意一轮回答可重新生成（服务端截断该轮及其后历史再重问，历史与 LLM 上下文保持一致）；自己发的消息支持 ChatGPT 式内联编辑后重发（`DELETE /chat/history/from/{msg_id}` 新端点支撑）。
- **聊天·体验打磨**：loading 指示与头像同水平线（波浪点 + 流光动画）；失败消息带重试按钮；停止生成不再留下空白泡；滚动贴底跟随（上翻阅读不被拽回，提供"回到底部"悬浮按钮）；消息操作栏移动端常显。
- **代码块折叠**：聊天中超过 200 行的代码块默认折叠为约 24 行预览（展开/折叠切换，复制始终全量）。
- **首页 Apple 式交错展示**：首屏 Hero 之下新增 6 段「文字 ⇄ 动画演示」交错展示（智能问答 / 收藏夹→知识库 / 笔记+思维导图 / 练习+定时出题 / 云盘 / 知识图谱），未登录落地页与登录后首页共用；动画为纯 CSS/framer-motion 手工 mockup，离屏自动暂停、循环淡出衔接、尊重 reduced-motion。
- **统一 TLS 证书供给**：新增 `scripts/gen-certs.sh` + compose `cert-gen` 一次性 init 服务，fresh clone 直接 `docker compose up` 即可获得全栈可用证书（nginx / app-board / app-board-mcp / app-pay 共享单一 CA，标准主题 `C=CN/ST=Sichuan/L=Chengdu/O=MindBase`，CN 一律为产品名）；幂等（到期前 30 天自动重签）。

### Changed

- 登录后首页重构：移除与顶部导航重复的快捷入口网格，改为与未登录页一致的功能展示页（各段 CTA 直达对应功能）。
- 顶栏移除头像旁的设置齿轮图标（设置页仍可经个人中心进入）。

### Removed

- **用量计费（/billing）与任务监控（/tasks）前端暂时下线**：路由页、API 模块、导航入口与个人中心入口按钮一并移除（后端端点保留；恢复可从 git 历史找回）。

### Fixed

- `/task-quiz` 页面预取 301→404：nginx 对无斜杠裸路径的规定性 301 使页面预取落进 API 通道；双精确钉死页面路由后实测四态全对。
- TLS 供给脚本两处健壮性：Git Bash 下 `-subj` 被路径转换、busybox date 解析不了证书日期导致每次运行全部重签（改用 `openssl x509 -checkend`）。

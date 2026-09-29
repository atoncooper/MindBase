# Changelog

本文件记录 MindBase 各版本的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] — 2026-09-25

### Fixed

- **cert-gen 启动失败（exit 2）**：git autocrlf 把 `scripts/gen-certs.sh` 工作区副本转成 CRLF，容器内 `set -eu
` 报 illegal option 并连锁阻塞 mysql/app-pay-mysql 的启动依赖。修复：`.gitattributes` 对全部 `*.sh` 强制 LF + certgen 镜像构建期剥除 CR 双保险；存量 shell 脚本工作区已归一。
- **APISIX→app-pay https 上游 500**：APISIX 3.11 对带 `tls:` 块（即使仅 `verify: false`）的 https 上游在建立连接时 `parse_pem_cert(nil)` 崩溃，导致 `/internal/pay/*`（会员查询/补偿开通）自上线起不可用。修复：移除 `upstream-app-pay` 的 `tls:` 块（默认不校验上游证书，语义等价）；云盘配额的 VIP/SVIP 提额随之打通（SVIP grant→配额 60TB 已实测）。

### Added

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

# Changelog

本文件记录 MindBase 各版本的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] — 2026-09-25

### Fixed

- **cert-gen 启动失败（exit 2）**：git autocrlf 把 `scripts/gen-certs.sh` 工作区副本转成 CRLF，容器内 `set -eu` 报 illegal option 并连锁阻塞 mysql/app-pay-mysql 的启动依赖。修复：`.gitattributes` 对全部 `*.sh` 强制 LF + certgen 镜像构建期剥除 CR 双保险；存量 shell 脚本工作区已归一。
- **APISIX→app-pay https 上游 500**：APISIX 3.11 对带 `tls:` 块（即使仅 `verify: false`）的 https 上游在建立连接时 `parse_pem_cert(nil)` 崩溃，导致 `/internal/pay/*`（会员查询/补偿开通）自上线起不可用。修复：移除 `upstream-app-pay` 的 `tls:` 块（默认不校验上游证书，语义等价）；云盘配额的 VIP/SVIP 提额随之打通（SVIP grant→配额 60TB 已实测）。

### Added

- **云盘服务迁移（app-go/app-cloud）**：云盘整体迁至独立 Go 服务（:8007），并完善为对标百度网盘的能力面——**存储配额**（免费 10GB / VIP 6TB / SVIP 60TB，init 上传即校验超限 413，用量条上屏）、**百度式分享**（token 链接 + 可选 4 位提取码（哈希存储）+ 有效期 + 下载上限 + 查看/下载计数，公开页 `/cloud/s/{token}` 免登录可达，访问发放 15 分钟短时效预签名 URL）、**回收站**（删除改软删，MinIO/Mongo/Milvus 数据保留 30 天供恢复，后台 sweeper 自动清理；新增恢复/彻底删除端点）、**文件搜索**。**文档解析+向量化管线全部 Go 重写**（PDF/docx/xlsx/pptx/markdown/html/文本提取 → 语义分块 → Higress 网关 embedding → Milvus cloud_drive（启动 schema 守护）→ Mongo 全文 → 三层一致性校验），同一 bucket/key 零数据迁移，RAG 混合检索无缝命中 Go 写入的向量。backend 云盘代码全量删除（cloud router / upload/processing/cleanup 服务 / cloud 仓储 / doc_parser，保留笔记转化用的只读 document_text），APISIX 新增 `/cloud/*` 兜底路由直达 app-cloud——云盘请求在代码与网关两个层面都不再经过 Python backend；WS 状态经 Redis pub/sub 桥接保持前端推送不变。
- **SVIP 档位**：app-pay SKU 种子新增 SVIP 月/季/年（占位价），`MembershipService.extend` 支持 tier（订单 SKU 前缀 `SVIP_*` 自动判定），运营补偿开通（API + PayAdmin 界面）可选档位；云盘配额按 membership tier 自动生效。

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

# app-admin — 统一管理后台（分享审核 + 支付运营 + 沙箱 + 账户 + 审计）

> 管理后台由 `app-admin`（Nginx 静态 UI，`:3001`，仅回环）+ `app-admin-api`（Go + Gin，`:8016`，仅回环）组成；UI 经同源 `/api` 代理到 API，不经过主站公网 Nginx/APISIX。
> **2026-11-03 起支付域合并**：原独立服务 `app-pay-admin`（Go + SSR WebUI，:8003，profile `pay-admin`）已退役，支付运营能力（订单/会员/权益事件/SKU 查询、会员补偿开通、退款复核）并入本服务；统一账户（`admin_user`）、统一会话（`admin_session`）、统一角色（`admin`/`viewer`）、统一审计（`admin_audit` + 资金 JSONL）。
> 业务域 = 云盘分享**先分享后审核**（plan/1.0.16）+ 支付域**只读运营查询 + 两类资金写**（会员补偿开通、退款复核审批）+ 沙箱控制层管理面 + 控制台账户管理。
> 内容能力 = **受控预览**（Issue #154）：admin 角色可依法预览分享内文件（用户创建分享时已单独确认告知）；**无下载、绝不直连 MinIO**。

## 定位与红线

- **数据访问（主库）**：直连共享 bilirag MySQL（`RDBMS__URL` 同 app-user/app-cloud）。读 `users` / `user_profile` / `rbac_user_role` / `rbac_role` / `cloud_shares` / `cloud_files` / `cloud_folders`；**写** = `cloud_shares` 的 `moderation_status/moderation_reason/moderation_time/moderation_by`（与 `admin_audit` 同事务）。
- **数据访问（支付库）**：第二 GORM 连接直连 `app_pay`（`app-pay-mysql` 实例）。只读 `pay_order` / `pay_membership` / `pay_membership_event` / `pay_callback_log` / `pay_product` / `pay_refund_approval`；**唯一资金写** = 会员补偿开通（直写 `pay_membership` + `pay_membership_event`，同事务）；退款复核**不直写**，经 app-pay internal 端点执行。`pay_*` schema 归 Java（app-pay/Flyway）所有，**本服务绝不 AutoMigrate**（守护测试锁定：只建三张自有表，DDL 禁列包含 `pay_*`）。
- **支付模块关闭条件**（任一）：未配置 `pay_rdbms.url`，或 PayDB 初始化失败 → 所有 `/api/pay/**` 返回 503 `{"detail":"支付管理未配置"}`；分享审核/用户/沙箱/账户/审计不受影响。
- **受控内容预览（Issue #154，审核员可查看）**：仅 admin 角色；app-admin 校验分享存在 + 文件在分享范围（文件分享 = 目标文件；文件夹分享 = 子树存活成员）并落 `admin_audit`（action=`preview_content`），再调 app-cloud `GET /internal/cloud/admin-review/shares/{id}/files/{fid}/preview`（Bearer 共享令牌 `APP_CLOUD_ADMIN_REVIEW_TOKEN`，两边同值）。**审核员可查看任意已存在的分享**（含 banned / 已撤销 / 已过期 / 历史未确认告知的分享）；app-cloud 只校验分享存在与文件归属范围，不校验公开可访问性。预览返回：pdf / 图片 / 音视频 → 短时效内联 URL（`/minio-proxy/...`，admin UI 内置 Nginx 同源代理到 MinIO，PDF 以 `X-Frame-Options: SAMEORIGIN` 允许同源 iframe 展示）；docx / xlsx / pptx / html / markdown / txt 等 → 后端提取的纯文本（`viewMode:"text"`，不生成对象 URL、不渲染 HTML，防存储型 XSS）；暂不支持类型 / 无文本 / 过大文件返回 422/413 并带原因。viewer 角色一律 403。
- **app-cloud 关系**：admin API **直接查/写 MySQL**，请求不转发给 app-cloud。Compose 启动 app-cloud 是为了让其 schema owner migration 创建/补齐 `cloud_shares` 审核列；这些列已迁移后，admin 的日常查询不依赖 app-cloud 业务 API。全新库首次启动时仍需 app-cloud 完成迁移。
- **自有表**（本服务 `Migrate` 只 `CREATE TABLE IF NOT EXISTS` 这三张，守护测试锁定）：`admin_user`（控制台账户）/ `admin_session`（DB 会话）/ `admin_audit`（操作审计）。
- **绝不** `AutoMigrate`/ALTER 共享表与 `pay_*` 表；**绝不** 触碰 `is_revoked`（属主撤销语义独立，admin 只改审核列）。
- **对象存储边界**：GORM 模型连 `bucket`/`object_key` 都不映射，app-admin 不持有任何 MinIO 凭证；列表/详情只出 name/size/mimeType/path 元数据（受控预览除外）。
- **端口/暴露**：UI `3001`、API 调试口 `8016` 都只绑定 `127.0.0.1`；用户浏览器访问 UI，由同源 Nginx 代理 `/api`。后台不经主站 APISIX/nginx。
- **包结构**：`router`（参数解析/鉴权/错误体）→ `service`（业务规则 + DTO 组装）→ `repo`（SQL）；响应 DTO 独立在 `internal/dto`（纯 JSON 契约、无依赖，service 与 router 共用），不放在 service 包里。

## 页面（frontend-admin）

| 路由 | 说明 |
|------|------|
| `/login` | 登录；`mustChangePassword=true` 时**强制先改密**（POST `/api/me/password`）再进后台 |
| `/shares` | 分享审核：筛选（审核状态 / 属主 uid / 关键词 / 是否已撤销 / **内容状态**）+ 元数据表格 + **每行「查看」详情抽屉**（元数据 + 分享内文件列表 + 受控预览入口）+ **放行 / 封杀 / 解封**（reason 弹窗，封杀必填）。**默认只看「目标内容存在」的可审核分享**，目标已删除的存量记录需切到「内容：全部/目标已删除」查看（仅审计，无可审核内容）；预览与审核操作仅 admin |
| `/users` | 用户只读：uid / email / phone / nickname / status / 角色 Tag；行点击抽屉看角色明细。查询框**自动识别** UID（数字）/ 11 位手机号（1[3-9] 开头）/ 邮箱（含 @），前端正则校验 + 后端二次校验，非法输入不发起请求 |
| `/sandbox` | 沙箱控制层面板：概览 / 执行 / 租约 / 配额 / 审计（详见下文「沙箱管理」） |
| `/pay/orders`、`/pay/orders/:orderNo` | 支付订单列表（订单号/UID/交易号/状态/渠道/创建时间范围）与详情（Descriptions + 回调流水 Table） |
| `/pay/memberships`、`/pay/memberships/:uid/events` | 会员（UID 查询 + 全量分页；行操作「权益流水」→ 单人事件流） |
| `/pay/events` | 全局权益事件流（uid/type 筛选，ADMIN_GRANT 审计用） |
| `/pay/products` | SKU 商品（只读；改价走 app-pay 运营改库流程） |
| `/pay/grants` | 补偿开通（admin）：表单 + 结果 Alert + 最近 ADMIN_GRANT 列表 |
| `/pay/refunds` | 退款复核（admin）：status 筛选 + approve/reject 弹窗；未配置时显示「未配置」提示 |
| `/accounts` | 控制台账户（admin）：列表 / 新建 / 重置密码 / 删除；非 admin 显示 403 Alert 且不发请求 |
| `/audit` | 审计日志倒序；操作下拉筛选 + 管理员精确筛选；操作中文标签/颜色，详情按动作格式化（封杀/解封/放行原因、预览文件与模式、登录 IP/客户端、自助改密、支付/账户动作）；「分享 #ID」可跳转并自动打开分享详情抽屉 |

前端请求层 `src/api/client.ts` 统一：带 cookie、`{detail}` 错误透传、401 清态踢回登录；uid 为 bigint（可 > 2^53），解析时保留为字符串防精度丢失（**支付域 uid 一律 string**，金额 `amountCents/priceCents` 为整数分）。

**查看分享内容**：列表行「查看」→ 详情抽屉；文件行「预览」→ 受控预览（admin）。**审核员可查看任意分享的内容**（包括已撤销、已过期、封杀中、以及创建时用户未确认《管理员内容审核告知》的历史分享），用户告知状态仅作展示、不阻断预览。每次预览后端写 `preview_content` 审计；除受控预览外不提供下载/导出/URL 复制。

## 鉴权（统一账户体系）

| 机制 | 说明 |
|------|------|
| 账户 | `admin_user` + bcrypt；种子账户 **`admin` / `app-admin`**（`APPADMIN__SEED__USERNAME` / `APPADMIN__SEED__PASSWORD` 可覆盖，**只插缺失不覆盖**），首登强制改密（`must_change_password=1`） |
| 会话 | DB 会话 `admin_session` + **HttpOnly cookie `admin_session`**（SameSite=Lax；TLS 下自动 Secure）；**滑动 12h**（每个认证请求续期），登出只删当前会话 |
| 角色 | `admin`（全部写：审核 / 补偿开通 / 退款复核 / 账户管理 / 沙箱写）/ `viewer`（只读）；改密对所有登录账户开放 |
| 设备指纹 | 所有 `/api/*` 请求必须带 `X-Device-Id`（16–128 位 `[A-Za-z0-9_-]`，浏览器在 localStorage 生成并持久化）。登录会话绑定 `SHA256(v1|deviceId|UA|首选语言)`；`APPADMIN__SESSION__DEVICE_BINDING=strict|id|off`（默认 strict）。设备不一致/缺失 → 删除会话 + 审计 `session_device_mismatch` + 401 |
| IP 绑定 | 会话记录登录 IP，并按 `APPADMIN__SESSION__IP_BINDING=subnet|exact|off`（默认 subnet；IPv4 /24、IPv6 /64，前缀可配）校验；不一致 → 删除会话 + 审计 `session_ip_mismatch` + 401 |
| 可信代理 | `APPADMIN__SECURITY__TRUSTED_PROXIES`（IP/CIDR 列表）内的 TCP peer 才采信 `X-Forwarded-For/X-Forwarded-Proto`；真实客户端 IP 用于限流、审计与会话绑定。空 = 永不信任转发头 |
| 登录限流 | IP 级 10 次失败/分钟 + 账户级 10 次失败/15 分钟（均可配），超限 429 + `Retry-After`；失败写 `login_failed` 审计，新设备/新 IP 写 `login_new_device`/`login_new_ip` |
| IP 访问控制 | 可选精确 IP/CIDR 白名单（`APPADMIN__SECURITY__IP_ALLOWLIST`，**按 TCP peer 判断**，不采信 XFF）；空列表时仍依赖 loopback / 防火墙 / VPN / ClusterIP；`/health` 为探针豁免 |
| 浏览器来源 | CORS 仅允许同源或显式配置的精确 Origin；不允许 `*` / `null`；预检只接受 GET/POST/DELETE 与 Content-Type / Authorization / X-Request-Id / **X-Device-Id**；浏览器非安全方法必须带允许的 Origin（CSRF 防护） |
| 加固 | nosniff / `X-Frame-Options: DENY` / CSP `frame-ancestors 'none'` / CORP `same-origin` / COOP `same-origin` / `/api/*` no-store |

IP 白名单检查应用实际看到的 TCP 对端地址，**不读取 `X-Forwarded-For`**；登录限流、会话 IP 绑定和审计则使用可信代理链路解析出的真实客户端 IP。Compose 默认把 UI 容器所在 Docker 网段（`172.16.0.0/12`）设为可信代理；两机/swarm/k8s 分别使用 overlay/pod 网段。**若改成直连 API（不经 UI Nginx）或代理网段不同，必须同步调整 `APPADMIN__SECURITY__TRUSTED_PROXIES`**，否则 API 只能看到代理地址、IP 绑定退化为代理地址。不要把管理员电脑 IP 写成 API allowlist（应用看到的是代理/隧道地址）。

**统一账户管理**（`/api/console/users`，admin）：列表 / 新建（username 2..64、password 8..128、role 默认 viewer）/ 重置密码（重置后强制改密并删除该账户全部会话）/ 删除（不能删自己、不能删最后一个 admin）。原 `app-pay-admin` 的 `payadmin_user` 账户**不迁移**，运维在本页重建。

## API 速览

错误体统一 `{"detail": ...}`；分页 `page` 从 1 起、`pageSize` ≤100、缺省 20；时间输出 RFC3339。

### 分享审核 / 用户 / 审计

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| GET | `/health` | — | 探活（主库不可用 503；配置了支付库但 PayDB 不可用 → 503 `pay database unavailable`；否则 `{"status":"healthy","service":"app-admin","pay":"ok"\|"disabled"}`） |
| POST | `/api/login` | — | 登录（session 闸门外）；**必须带 `X-Device-Id`**，服务端校验设备指纹并绑定会话 |
| GET | `/api/me`；POST `/api/me/password` | 登录 | 会话回显（含 `mustChangePassword`）/ 自助改密（旧密校验 + 新密 ≥8 位） |
| GET | `/api/users?q=&mode=uid\|phone\|email&page=&pageSize=` | viewer+ | 用户列表：q **精确匹配** UID / 11 位手机号 / 邮箱；`mode` 前后端双重校验；响应 `queryMode` 回显 |
| GET | `/api/users/:uid` | viewer+ | 详情 + 角色明细，**不含任何文件/存储信息** |
| GET | `/api/shares?status=active\|approved\|banned&uid=&revoked=0\|1&available=0\|1&q=&page=&pageSize=` | viewer+ | 分享列表：文件/文件夹；文件夹用一条递归 CTE 聚合 fileCount/totalSize；`contentAvailable` 标记目标是否仍存在 |
| GET | `/api/shares/:id` | viewer+ | 详情 + `files: [{name,size,mimeType,path}]`（上限 2000，`truncated`） |
| POST | `/api/shares/:id/ban` | admin | `reason` 必填 → `banned` + audit；**不触碰 is_revoked** |
| POST | `/api/shares/:id/unban` | admin | → `active`（清 reason/time/by）+ audit |
| POST | `/api/shares/:id/approve` | admin | → `approved` + audit |
| GET | `/api/shares/:id/files/:file_id/preview` | admin | 受控内容预览（短时效内联授权；非分享范围/已删除 404；未配置 500；每次审计 `preview_content`） |
| POST | `/api/logout` | 登录 | 登出当前会话 |
| GET | `/api/audit?action=&admin=&page=&pageSize=` | viewer+ | 审计倒序（含登录失败/新设备/新 IP/会话不匹配、`pay_grant` / `pay_refund_approve` / `pay_refund_reject` / `account_*` / 沙箱写动作） |

### 支付运营（`/api/pay/**`；支付模块关闭时整组 503）

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| GET | `/api/pay/orders?uid=&status=&channel=&sku=&orderNo=&tradeNo=&createdFrom=&createdTo=&page=&pageSize=` | viewer+ | 订单列表（`ORDER BY id DESC` 主键序）；uid 输出 string；金额为整数分 |
| GET | `/api/pay/orders/:orderNo?tradeNo=` | viewer+ | 订单详情；orderNo 查不到时 tradeNo 兜底；找不到 404 `order not found` |
| GET | `/api/pay/orders/:orderNo/callbacks?page=&pageSize=` | viewer+ | 回调流水（脱敏报文 + 验签/处理结论） |
| GET | `/api/pay/memberships?uid=` / `?page=&pageSize=` | viewer+ | 带 uid → 单个会员（无记录 `null`）；不带 uid → 分页列表（`active` 懒过期 = expireAt>now） |
| GET | `/api/pay/memberships/:uid/events?page=&pageSize=` | viewer+ | 单人权益事件流 |
| GET | `/api/pay/events?uid=&type=&page=&pageSize=` | viewer+ | 全局权益事件流（ADMIN_GRANT 审计用） |
| GET | `/api/pay/products` | viewer+ | SKU 目录（只读；sort ASC,id ASC） |
| POST | `/api/pay/grants` | admin | 会员补偿开通（见下节「资金写红线」） |
| GET | `/api/pay/refunds?status=PENDING\|APPROVED\|REJECTED\|ALL&page=&pageSize=` | admin | 退款复核列表（直读 `pay_refund_approval`，id DESC）；未配置整组 404 `refund review not configured` |
| POST | `/api/pay/refunds/:orderNo/approve` | admin | 经 app-pay internal 端点执行退款（`confirm=true`，operator=登录用户名）；上游失败 502 |
| POST | `/api/pay/refunds/:orderNo/reject` | admin | 驳回（同上通路） |

### 控制台账户（`/api/console/users`，admin；不依赖支付库）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/console/users` | 账户列表（username ASC；`mustChangePassword`/最后登录/创建时间） |
| POST | `/api/console/users` | 新建（409 `username already exists`） |
| POST | `/api/console/users/:id/password` | 重置密码（强制改密 + 删会话；404 不存在） |
| DELETE | `/api/console/users/:id` | 删除（不能删自己 / 最后一个 admin；级联删会话） |

> 既有 `GET /api/users`（业务用户只读）保持不变；账户管理路径固定为 `/api/console/users`，避免冲突。

## 支付运营：资金写红线

### 会员补偿开通（grant）

`POST /api/pay/grants`（admin）：`{"uid": <number|string>, "durationDays": 1..3650, "reason": 必填, "tier"?: "VIP"|"SVIP"}`。校验：uid>0；reason trim 非空；`"[操作人] reason"` 总长 ≤ 200 rune（列宽）。

Go 侧**复刻** app-pay `MembershipService.extend` 语义：事务内 `SELECT ... FOR UPDATE` 会员行（sqlite 测试跳过）→ 无记录则新建（默认 tier=VIP）→ 未到期从 `expire_at` 顺延、已过期从 now 起算 → 同事务写 `pay_membership` + `pay_membership_event(type=ADMIN_GRANT)`；`last_order_no` 保留不清。

**审计三留痕**：

1. `pay_membership_event.reason` 以 `[操作人]` 前缀记录（Java 表无 operator 列，schema 不漂移）；
2. 资金审计 JSONL `logs/pay-audit.jsonl`（事件 `MEMBERSHIP_EXTENDED`，哈希链，365 天，lumberjack 轮转）；
3. `admin_audit` action=`pay_grant` targetType=`membership`（跨库无法同事务，失败仅告警日志，不返回失败——资金已落库）。

**日额度熔断**（对齐 app-pay）：`pay.grant.daily_max_count` / `daily_max_days`（按 `type=ADMIN_GRANT AND created_at>=本地当天0点` 的 COUNT/SUM 判定；0=不限）；超限 429 并写 JSONL `GRANT_DAILY_COUNT_EXCEEDED` / `GRANT_DAILY_DAYS_EXCEEDED`；统计失败 fail-open + 告警。

### 退款复核（未配置 → 整组 404 隐身）

配置 `pay.ops.base_url` + `pay.ops.key` 且 `pay.ops.refund_review_enabled=true` 才启用。approve/reject 经 APISIX pay-ops consumer（`PAY_OPS_KEY`）调 app-pay internal 端点执行：

- `POST {base}/internal/pay/orders/{orderNo}/refund` `{"reason":..., "operator": 登录用户名, "confirm":true}`
- `POST {base}/internal/pay/orders/{orderNo}/refund/reject` `{"operator":...}`

**operator 由服务端注入**（替代 curl 自报身份），maker != checker 由 app-pay 强制。成功后写 `admin_audit`（`pay_refund_approve` / `pay_refund_reject`）+ JSONL（`REFUND_CONFIRMED` / `REFUND_REJECTED`）；上游失败 502。timeout 默认 5s。

**禁止**在本服务实现退款/关单/SKU 改价等其余资金写操作（需先在 app-pay 侧建端点保证审计一致）；**禁止**绕过 app-pay 直写 `pay_*` 表。

## 登录安全（设备指纹 / IP / 跨域）

- **设备指纹**：浏览器首次访问生成随机 `deviceId` 存 localStorage，并在所有请求带 `X-Device-Id`；服务端不落原始值，只存 `SHA256(v1|deviceId|UA|首选语言)` 到 `admin_session.device_hash`。换浏览器/清存储/UA 变化（strict 模式）会要求重新登录；会话被复制到其他设备时因指纹不符立即失效。
- **IP 绑定**：登录时记录真实客户端 IP，后续请求按 `subnet`（IPv4 /24、IPv6 /64）或 `exact` 校验；跨网段/换 IP 会失效并写 `session_ip_mismatch`。
- **可信代理**：只有 `APPADMIN__SECURITY__TRUSTED_PROXIES` 内的 peer 才能通过 `X-Forwarded-For/X-Forwarded-Proto` 提供真实 IP；直连 API 的 `X-Forwarded-For` 一律忽略。Compose 默认信任 UI 容器网段，其他部署按实际网段配置。
- **限流与审计**：IP 级 + 账户级双预算（默认 10 次/分钟/IP、10 次/15 分钟/账户）；失败写 `login_failed`，首次出现的新设备/新 IP 写 `login_new_device` / `login_new_ip`；会话设备/IP 校验失败写 `session_device_mismatch` / `session_ip_mismatch` 并删除会话。
- **跨域**：CORS 只接受同源或 `APPADMIN__SECURITY__CORS__ALLOW_ORIGINS` 的精确 Origin（不允许 `*` / `null`）；预检仅放行 GET/POST/DELETE 与白名单请求头（含 `X-Device-Id`）；非安全方法必须带允许的 Origin（CSRF 纵深防御）。生产建议 UI 与 API 同源（Compose 已通过 UI Nginx 反代实现）。
- **脚本/API 调用**：先 `POST /api/login`（带 `X-Device-Id`）拿 `admin_session` cookie，之后每次请求同时带 cookie 与相同 `X-Device-Id`；换机器/脚本需使用新的设备 ID 并重新登录。

```bash
DEVICE_ID="$(openssl rand -hex 24)"
# 非安全方法必须带同源 Origin（CSRF 防线）；X-Device-Id 必填。
curl -c cookies.txt -H "Origin: http://127.0.0.1:8016" -H "X-Device-Id: $DEVICE_ID" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}' http://127.0.0.1:8016/api/login
curl -b cookies.txt -H "X-Device-Id: $DEVICE_ID" http://127.0.0.1:8016/api/me
```

```text
设备/IP 不匹配统一返回 401 {"detail":"login required"}（不区分原因，避免探测）；具体原因只落审计。
```

## 审核如何生效

- 公开访问 `GET /cloud/s/{token}` 由 app-cloud `ResolveShare` 判定：`moderation_status=banned` 与 `is_revoked` **同等统一 404** → admin 写共享库后**即时生效**（无需回调/重载）。
- 引用面（`cloud_refs` 解析）同时校验来源分享未 banned/revoked/过期 → 封杀后已保存引用也立即失效。
- 属主列表返回审核三元组（status/reason/time），属主可见审核结果。

## 配置

三层合并（后者覆盖前者）：`default.yaml`（go:embed 嵌入）← `-config` 覆盖层 ← `APPADMIN__` 环境变量（最高）；另经 godotenv 读项目根 `.env`。时区固定 Asia/Shanghai（DSN `loc=Local`）。

```bash
APPADMIN__RDBMS__URL=mysql+aiomysql://mind_base:mind-base@mysql:3306/mind_base
APPADMIN__SEED__USERNAME=admin          # 种子账户（只插缺失）
APPADMIN__SEED__PASSWORD=app-admin      # 生产务必覆盖
APPADMIN__SESSION__TTL_MINUTES=720      # 会话滑动 TTL（默认 12h）
APPADMIN__SESSION__DEVICE_BINDING=strict # strict | id | off（默认 strict，设备指纹绑定）
APPADMIN__SESSION__IP_BINDING=subnet     # exact | subnet | off（默认 subnet）
APPADMIN__SESSION__IPV4_PREFIX=24       # subnet 模式 IPv4 前缀
APPADMIN__SESSION__IPV6_PREFIX=64       # subnet 模式 IPv6 前缀
APPADMIN__SECURITY__TRUSTED_PROXIES=172.16.0.0/12 # 可信代理 CIDR（采信 X-Forwarded-*）
APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_IP=10
APPADMIN__SECURITY__LOGIN__IP_WINDOW_SECONDS=60
APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_ACCOUNT=10
APPADMIN__SECURITY__LOGIN__ACCOUNT_WINDOW_SECONDS=900
APPADMIN__SECURITY__IP_ALLOWLIST=        # 可选，逗号分隔 IP/CIDR
APPADMIN__SECURITY__CORS__ALLOW_ORIGINS= # 可选，逗号分隔精确 Origin
# 内容审核预览（与 app-cloud 共享令牌，两边同值 = 预览开启）
# APPADMIN__CLOUD_REVIEW__BASE_URL=http://app-cloud:8007
# APPADMIN__CLOUD_REVIEW__TOKEN=<openssl rand -hex 32>
# 沙箱管理面（与 app-sandbox SANDBOX__ADMIN__TOKEN 同值）
APPADMIN__SANDBOX_ADMIN__BASE_URL=http://app-sandbox:8017
APPADMIN__SANDBOX_ADMIN__TOKEN=<与 SANDBOX__ADMIN__TOKEN 相同>
# 支付运营（原 app-pay-admin）：第二 GORM 连接直连 app_pay 库
APPADMIN__PAY_RDBMS__URL=mysql+aiomysql://app_pay:app-pay@app-pay-mysql:3306/app_pay
# 退款复核：经 APISIX pay-ops consumer 调 app-pay internal 端点
APPADMIN__PAY__OPS__BASE_URL=http://apisix:9080
APPADMIN__PAY__OPS__KEY=<与 PAY_OPS_KEY 同值；留空 = 退款复核 404 隐藏>
# 资金审计 JSONL（补偿开通/退款确认哈希链，365 天）
APPADMIN__PAY__AUDIT_FILE=/app/logs/pay-audit.jsonl
APPADMIN__LOG__LEVEL=info               # debug|info|warn|error；format: text|json
APPADMIN__LOG__OUTPUT=both              # stdout|file|both（compose 置 both，落 /app/logs）
APP_ADMIN_WEB_PORT=3001                 # compose 宿主机 UI 端口（默认 3001，仅回环）
APP_ADMIN_PORT=8016                     # API 调试映射端口（默认 8016，仅回环）
```

普通配置（端口/时区/连接池/日志轮转/日额度阈值）在 `app-go/app-admin/default.yaml`；`pay.ops.refund_review_enabled`、`pay.grant.daily_max_count` / `daily_max_days` 亦可在 YAML 调整。

## 启动

```bash
# 一条命令启动完整管理后台入口及依赖：UI + API + MySQL + auth/cloud schema owner
docker compose up -d --build app-admin
# 浏览器打开 http://127.0.0.1:3001；默认种子账户 admin / app-admin，首登强制改密
# app-admin UI 同源代理 /api -> app-admin-api:8016；API 调试口仅回环 127.0.0.1:8016

# 仅启动 API（不启动后台 UI）
docker compose up -d --build app-admin-api

# 本地（Go 模块模式；连宿主 MySQL + 宿主 app-pay MySQL）
cd app-go/app-admin
APPADMIN__RDBMS__URL='mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base' \
APPADMIN__PAY_RDBMS__URL='mysql+aiomysql://app_pay:app-pay@127.0.0.1:3307/app_pay' go run .

# 前端 dev（另一个终端）
cd frontend-admin && pnpm i && pnpm dev   # http://localhost:3001，/api 代理并改写为上游同源 Origin
```

> `app-admin` 是组合入口服务，会依赖启动 `app-admin-api`；API 依赖 MySQL、app-user（用户/RBAC 表，auth 域）、app-cloud（审核列 migration）与（可选）app-pay-mysql。支付库/ops key 未配置时支付页显示未配置/503，其余功能正常。首次启动等待 migration 完成后再登录。

## 部署（deploy/docker、k8s、swarm）

- 两机 compose：`deploy/docker/96-app-admin.yml`（启动 UI + API；共享数据库与 app-user/app-cloud 仍由主栈提供）；浏览器经 SSH 隧道 `ssh -L 3001:127.0.0.1:3001 <server2>`。支付运营读 `25-app-pay-mysql.yml` 起的库，退款复核需 `.env` 的 `PAY_OPS_KEY`。原 `95-app-pay-admin.yml` 已删除。
- k8s：`deploy/k8s/30-apps/app-admin.yaml`（ClusterIP，无 Ingress；`kubectl -n mind-base port-forward svc/app-admin 8016:8016`）；支付库地址由 `mindbase-defaults` 的 `APPADMIN__PAY_RDBMS__URL` 注入，ops key 取 `mindbase-env` 的 `PAY_OPS_KEY`（可选）。原 `app-pay-admin.yaml` 已删除。
- swarm：`deploy/swarm/docker-stack.yml` 的 `app-admin-api` + `app-admin`（UI 发布 3001，需防火墙限源或改 SSH 隧道）；原 `app-pay-admin` 服务已移除。
- 镜像 `atoncooper/mind-base-app-admin` / `atoncooper/mind-base-app-admin-ui`；CI `.github/workflows/ci-app-admin.yml`（gofmt/vet/test/build）+ docker-build 矩阵。原 `ci-pay-admin.yml` 已删除。

## 从 app-pay-admin 迁移（2026-11-03）

| 旧（app-pay-admin） | 新（app-admin） |
|---|---|
| 独立进程 :8003 + profile `pay-admin` + SSR WebUI + 可选 TLS/自签证书 | 并入 :8016 API + :3001 SPA（回环，前置入口负责 TLS）；8003 / profile / TLS / certgen 全部退役 |
| `payadmin_user` / `payadmin_session` | 统一 `admin_user` / `admin_session`（**不迁移旧账户**，在「账户」页重建） |
| `PAYADMIN__*` 环境变量 | `APPADMIN__PAY_*` / `APPADMIN__PAY__*`（见「配置」） |
| 可选 master API token（`PAYADMIN__WEBUI__TOKEN`，X-WebUI-Token/Bearer） | 退役：统一走 `admin_session` 登录会话（脚本先 `POST /api/login` 再用返回的 cookie） |
| `logs/pay-admin-audit.jsonl` | `logs/pay-audit.jsonl`（与 app-pay 资金审计同名，哈希链） |
| SSR 页面 `/orders` `/memberships` `/grants` `/users` | SPA `/pay/orders` `/pay/memberships` `/pay/grants` `/accounts` |
| `/api/orders` `/api/grants` `/api/users`（payadmin） | `/api/pay/orders` `/api/pay/grants` `/api/console/users` |
| grant 日额度 `PAYADMIN__GRANT__DAILY_MAX_*` | `pay.grant.daily_max_count` / `daily_max_days`（同名语义） |

## 沙箱管理

> app-admin 兼作**沙箱控制层（app-sandbox）的管理面板**。app-admin 不直连 sandbox_* 表：所有数据经 app-sandbox 的 `/internal/admin/*` 内部 API 获取，沙箱状态以控制层为唯一真相。

**角色**：`viewer` 只读（页面按钮禁用）；`admin` 可执行「取消执行」「强制回收租约」。真正的门禁在 app-admin `requireAdmin()`（403 兜底）。

**代理端点**（app-admin `/api/sandbox/*`，session 登录后）：

| 方法 | 路径 | 角色 | 上游 app-sandbox |
|---|---|---|---|
| GET | `/api/sandbox/overview` | viewer+ | `GET /internal/admin/overview` |
| GET | `/api/sandbox/executions` | viewer+ | `GET /internal/admin/executions` |
| GET | `/api/sandbox/executions/:id` | viewer+ | `GET /internal/admin/executions/:id` |
| POST | `/api/sandbox/executions/:id/cancel` | admin | `POST /internal/admin/executions/:id/cancel` |
| GET | `/api/sandbox/leases` | viewer+ | `GET /internal/admin/leases` |
| POST | `/api/sandbox/leases/:id/release` | admin | `DELETE /internal/admin/leases/:id` |
| GET | `/api/sandbox/quota` | viewer+ | `GET /internal/admin/quota` |
| GET | `/api/sandbox/audit` | viewer+ | `GET /internal/admin/audit` |
| GET | `/api/sandbox/config` | viewer+ | `GET /internal/admin/config` |

**错误映射**：未配置 → 503 `{detail:"sandbox 管理未配置"}`；上游 4xx → 原状态 + detail；上游 5xx/不可达/非法 JSON → 502 `{detail:"sandbox 服务不可用"}`。写操作成功后写 app-admin 审计（`sandbox.execution.cancel` / `sandbox.lease.release`），审计失败则整次操作返回 500。

**配置**（两边同时设置才启用；半配置自动清空并告警）：

```bash
# app-sandbox 侧：/internal/admin/* 的共享令牌
SANDBOX__ADMIN__TOKEN=$(openssl rand -hex 32)
# app-admin-api 侧：同一令牌 + 控制层地址
APPADMIN__SANDBOX_ADMIN__BASE_URL=http://app-sandbox:8017
APPADMIN__SANDBOX_ADMIN__TOKEN=<与 SANDBOX__ADMIN__TOKEN 相同>
```

**页面（frontend-admin `/sandbox`）**：概览（租约/执行状态、24h 失败、运行时配置摘要）；执行（过滤 + 分页表格 + 详情 Drawer：stdout/stderr 截断预览、产物元数据、审计时间线 + admin 取消执行）；租约（过滤 + admin 强制回收）；配额（uid/日期 → 档位与 4 个 kind 用量/限额）；审计（uid/action/时间过滤）。

**安全**：不展示代码正文与完整 stdout/stderr（仅控制层 `previewBytes` 截断预览）；产物只给元数据（name/size/sha256/type），不展示 objectKey、不提供下载；`/config` 不返回任何密钥；写操作双审计（app-admin 操作审计 + app-sandbox `sandbox_audit`，actor=admin，request_id 贯通）。

## 测试

```bash
cd app-go/app-admin && go test ./...   # 纯 httptest/内存（含 sqlite），无需真实 MySQL
cd frontend-admin && pnpm build        # tsc --noEmit + vite build
```

覆盖：配置覆盖优先级、迁移守护（只建三张自有表，禁建 pay_*）、登录/限流/会话、角色闸门、分页参数校验、审核 reason 必填、审计写入、CORS/安全头、内容预览审计与非分享范围 404 语义、支付查询过滤与 DTO（uid string / 金额分）、grant 语义三例（新建/活跃顺延/过期起算）+ 日额度熔断、退款复核代理与未配置 404、控制台账户规则（不能删自己/最后一个 admin）。

> 后端架构与红线见根 `AGENTS.md` §2.21（本地开发规范，不入 git）；原 `app-pay-admin` 设计文档（`plan/1.0.9-PayAdmin`）与 `docs/app-pay-admin.md` 已随服务退役删除。

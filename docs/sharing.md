# 公开分享体系（分享链接 / 设备证明 / 提取码）

> 三条公开分享链路：**笔记**（notes）、**云盘文件**（cloud）、**测验**（quiz）。本文覆盖它们的页面、后端、链接域名策略、防护体系（限流 / 带宽帽 / 设备证明）与提取码管理。

## 一、三条链路总览

| 链路 | 公开页（免登录） | 元数据/内容端点 | 后端 | 内容形态 |
|------|------|------|------|------|
| 笔记 | `/notes/shared/[token]` | `GET /notes/shared/{token}`（camelCase） | app-note | Markdown 正文（无答案泄露面） |
| 云盘文件 | `/cloud/s/[token]` | `GET /cloud/s/{token}`（元数据+挑战）+ `POST /cloud/s/{token}/attest` + `POST /cloud/s/{token}/access`（预签名） | app-cloud | 图片/视频/音频/PDF/文本/Markdown 在线预览；其余"无法展示"+下载 |
| 测验 | `/quiz/shared/[token]` | `GET /quiz/shared/{token}` | app-quiz（Redis L2 缓存 60s） | 题目（**不含答案/解析**） |

共同约定：

- 页面导航（无 `X-Requested-With` 头）→ nginx 分发到 **frontend** 渲染公开页；页面的 API XHR（带该头）→ 分发到后端。双用途前缀靠这一个头区分（见 `nginx/locations.conf` 各块与 `/apisix-xhr`、`/sharenotes-xhr`、`/sharecloud-xhr` 内部分发目标）。
- token 均为 **256-bit** 随机（43 字符 url-safe），枚举不可行；无效/过期/撤销统一 404（不泄露存在性）。
- 公开页的数据请求一律**同源相对路径**（访客来自任意域名/IP，`request()` 的 `API_BASE_URL` 是构建期固化的部署地址，会打错地方）。

## 二、分享链接的域名链

分享链接要发给**别人**，不能写死创建者当前访问的地址（localhost）。统一由前端运行时解析，优先级：

1. `.env` 的 `SHARE_DOMAIN`（如 `minbase.top`，可带 `https://` 前缀）→ `https://<域名>`
2. `SHARE_PUBLIC_IP`（手工覆盖）或自动探测部署机公网 IP（api.ipify.org / ifconfig.me，10 分钟缓存）→ `https://<IP>`
3. 全部不可达 → 空串 → 回退**当前访问地址**（本地测试语义）

实现：`frontendv2/app/api/share-base/route.ts`（返回 `baseUrl` + `candidates`）+ `frontendv2/lib/api/deployment.ts`（解析器）+ `frontendv2/lib/api/share.ts`（分享链接组装）。

- **API 请求**（浏览器 → 后端）用同一候选链，但多一层「同源优先」：当前访问地址命中候选时直接用相对路径（零跨域）；否则逐候选做 `no-cors` 可达性探测后选取。
- **nginx CORS**：反射式放行（带 Origin 才回显，后端已发则透传避免重复头）+ 双用途路径的 OPTIONS 预检分发——混合访问场景（浏览 localhost、API 走域名）也能工作。

### 本地启用域名（三步）

1. `.env`：`SHARE_DOMAIN=minbase.top` → `docker compose up -d frontend`（运行时读取，无需重建；cert-gen 会把域名纳入证书 SAN）。
2. hosts 指向本机（需管理员）：`127.0.0.1 minbase.top`；或配置真实 DNS。
3. 系统代理用户：把域名加入**代理绕行列表**（浏览器走代理时 DNS 由代理解析，hosts 会被绕过）；TUN/全局模式需在代理客户端加 DIRECT 规则。

> 远端设备（无 hosts/DNS）打开分享链接时，前端自动回退到公网 IP 候选——这是设计好的兜底，不是 bug。

## 三、防护体系

### 限流（nginx，按 IP）

| 区 | 速率 | 覆盖 |
|----|------|------|
| general | 10r/s | 分享页导航、`/api/share-base` |
| api | 20r/s | 业务 XHR（`/apisix-xhr`）、notes 分享 XHR（`/sharenotes-xhr`） |
| auth | 1r/s | **云盘分享 access（提取码校验+预签名，防爆破）**、登录类 |

- 超限返回 **429**（`limit_req_status 429`；不要用默认 503——那会把限流伪装成服务故障）。
- 下载通道 `/minio-proxy/`：`limit_conn 8/IP` + 按方法限速（PUT 上传不限，GET 8MB/s/连接）——知道提取码的脚本最多打满这个帽，**服务器不会瘫**。

### 设备证明（云盘分享 access 闸门）

流程：`GET info` 返回签名挑战（token 绑定 + 10 分钟）→ 页面计算**挑战绑定指纹**（UA/语言/时区/屏幕/canvas → SHA-256，每次访问不同 → **非跨站追踪标识**）→ `POST attest` 换 15 分钟票据（绑定 token+指纹）→ access 必须带 `X-Fp` + `X-Ticket`，否则 412。

**诚实边界**：指纹算法在公开前端代码里，这是**成本分层**（裸 curl/默认无头浏览器过不去），不是安全边界；对抗者读源码或用定制 headless 仍可通过，此时服务器健康由带宽帽/限流无条件兜底。自动化环境（`navigator.webdriver`）直接拒绝。登录/注册发码端点（`/auth/register/email/send-code`、`/auth/phone/send-code` 公开路径）使用同一套用途绑定的证明（app-auth `internal/service/attest.go`），与图形验证码（人机层）互补。

### 提取码（云盘分享）

- 存储演进：legacy = SHA-256+pepper 单向哈希（不可查看）；v1 = **AES-256-GCM 密文**（`enc:v1:` 前缀），密钥为部署级共享密钥文件（`SECURITY__API_KEY_ENCRYPTION_KEY_FILE`，与 app-auth 同源，**不进数据库**）——DB 泄露依然不暴露可用提取码。
- 属主可**随时查看明文**（列表接口解密返回）；legacy 哈希行不可逆，前端提供**重设提取码**（`PATCH /cloud/shares/{id}/code`，链接/token 不变只换码）。
- 可选下载上限 `max_downloads`（弹窗可填），超限后 access 直接 404。

### 审核（云盘分享，先分享后审核）

- 分享创建后默认 `active`（进管理台待审核列表）；管理员在 **app-admin** 后台放行 / 封杀 / 解封。
- **封杀 = 公开访问统一 404**（app-cloud `ResolveShare` 把 `banned` 与 `is_revoked` 同等处理），已保存的「引用」也立即失效；`is_revoked` 只属主可改，两者语义独立。
- 审核为**受控内容预览**（Issue #154）：用户创建分享时须单独确认「管理员可依法查看分享内容用于审核」（app-cloud 后端强制，缺 → 422；确认时间/文案版本留档）。**审核员可查看任意分享的内容**（含撤销/过期/banned/历史未确认告知的分享），仅内联预览分享内文件（pdf/图片/音视频/文档纯文本），不提供下载，每次查看落 `preview_content` 审计。
- 审核后台 UI 仅回环（`http://127.0.0.1:3001`，API 调试口 `127.0.0.1:8016`；独立账户体系）；详见 [app-admin.md](app-admin.md)。

## 四、部署检查清单

- [ ] 改了 `frontendv2/**` 或 `app-go/**` 源码 → 必须 `docker compose build <服务>`（源码编译进镜像，**restart 无效**）；nginx 配置是 bind-mount → 改完 `nginx -s reload` 即可。
- [ ] 改 `SHARE_DOMAIN` → `up -d frontend`（运行时读取）+ hosts/DNS 同步 + `docker compose run --rm cert-gen` 重签证书。
- [ ] 提取码查看依赖密钥文件挂载（app-cloud 的 `SECURITY__API_KEY_ENCRYPTION_KEY_FILE`）——未挂载时优雅降级为不可查看的哈希模式。
- [ ] 体积型 DDoS（带宽打满）属于基础设施问题：需要云安全组 / CDN 前置，应用层限流只防应用层滥用。

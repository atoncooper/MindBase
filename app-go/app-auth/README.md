# app-auth —— 身份认证服务（Go + Gin）

> 全栈唯一认证权威：B 站扫码登录、注册/登录、token 签发与校验、RBAC 角色管理。
> nginx `auth_request` 与 APISIX forward-auth 共用本服务的 verify 面，注入 `X-Uid`/`X-Roles`，
> 下游服务（app-note/app-bili/app-quiz/app-cloud/…）一律信任网关注入头、不自验凭据。

## 端口与路由（:8006）

| 路由 | 说明 |
|------|------|
| `/auth/*` | 登录/注册/账户管理（含 B 站扫码会话代管） |
| `/internal/auth/verify` | 网关验 token → 200 + X-Uid/X-Roles（宽验证：无凭据 200、非法 401） |
| `/health` | 探活 |

## 数据所有权（共享 bilirag MySQL）

`users` / `user_tokens` / `rbac`；**中心密钥库** `secret` 表（AES-256-GCM，
密钥 `SECURITY__API_KEY_ENCRYPTION_KEY` 与 app-cloud/app-bili 共用）。

## 运行

```bash
go run ./app-go/app-auth        # 读项目根 .env；default.yaml 嵌入二进制
docker compose up -d app-auth   # compose 默认 profile
```

配置入口 `default.yaml`（`APPAUTH__` env 覆盖）。规范详见 AGENTS.md §2.13。

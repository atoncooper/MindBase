# app-settings —— 用户设置服务（Go + Gin）

> 用户偏好（设置面）权威 + 壁纸/头像存储。BYOK（用户自带 API Key）已于 2026-10-07 整体退役
> ——本服务不再承载任何 Key 配置面，AI 能力统一走 Higress 平台网关。

## 端口与路由（:8015）

| 路由 | 说明 |
|------|------|
| `/preferences/*` | 用户偏好读写 |
| `/wallpaper/*` | 自定义壁纸（MinIO 存储；nginx `/wallpaper/file/` 24h 缓存） |
| `/avatar/*` | 头像 |
| `/health` | 探活 |

## 数据所有权（共享 bilirag MySQL）

偏好/壁纸元数据表（服务启动自建 schema，禁 ALTER）。壁纸/头像二进制在 MinIO
`drive-videos` bucket。BYOK 三表（user_credentials/user_embedding_configs/user_asr_configs）已废弃，不得复活。

## 运行

```bash
go run ./app-go/app-settings
docker compose up -d app-settings
```

配置入口 `default.yaml`（`APPSETTINGS__` env 覆盖）。规范详见 AGENTS.md §2.19。

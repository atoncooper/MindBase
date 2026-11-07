# app-content — 内容域服务（Go）

> 合并自 app-board（思维导图/白板）+ app-note（笔记）+ app-quiz（测验存储）。
> 单 Go module / 单镜像 / 单进程；三个 Gin engine 分别监听 8004 / 8008 / 8011，
> 对外路径、APISIX upstream 语义保持不变（只改服务名与 upstream 地址）。

## 端口

| 端口 | 承载 | 说明 |
|------|------|------|
| 8004 | board | HTTPS（TLS rotator，证书目录 /app/certs；APISIX upstream 仍 scheme https） |
| 8008 | note | HTTP；宿主调试口沿用 8018→8008 |
| 8011 | quiz | HTTP |

## 结构

```
default.yaml                 # ★ 唯一配置（board/note/quiz 三段，embed）
cmd/app-content/main.go      # 组合根：config → 单 logger → 三个 Run(ctx) 并发 → 优雅退出
internal/
├── config/                  # 一个配置入口；config/{board,note,quiz} 保留原 env 前缀
├── logger/                  # ★ 全局 logger（slog + Gin/GORM 适配 + request-id context）
├── app/{board,note,quiz}/   # 每个域的 Run(ctx, cfg)
├── model/{board,note,quiz}/
├── repo/{board,note,quiz}/
├── service/{board,note,quiz}/
├── router/{board,note,quiz}/
├── infra/
│   ├── db/{board,note,quiz}/        # CREATE-only DDL（owner）
│   ├── mongo/board/  mongostore/{note,quiz}/
│   ├── redisstore/quiz/
│   ├── cache/board/  tls/board/
└── ...
```

## 配置

- 唯一文件 `app-go/app-content/default.yaml`（board/note/quiz 三段）。
- env 继续兼容 `APPBOARD__` / `APPNOTE__` / `APPQUIZ__`；compose 合并三套变量。
- 共享 env：`RDBMS__URL`、`MONGO__URI`、`REDIS__URL`、`MINIO__*`（如有）、`APISIX_CONSUMER_KEY`。

## 运行

```bash
cd app-go/app-content && go run ./cmd/app-content
go test ./...
docker compose up -d app-content
```

> 从旧三服务升级：旧 app-note/app-quiz/app-board 容器会占用 8008/8011/8004，
> 必须先删除（`docker compose up -d --remove-orphans app-content` 或先 stop/rm 旧容器）。

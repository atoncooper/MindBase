# app-content — 内容域服务（Go）

> 合并自 app-board（思维导图/白板）+ app-note（笔记）+ app-quiz（测验存储）。
> 单 Go module / 单镜像 / 单进程 / **单端口 8004（HTTPS）**：三个域挂在同一个
> Gin 引擎与同一个 *http.Server 上（/board、/notes、/quiz、/tasks、/internal/*）；
> 对外路径不变，APISIX 三个 upstream 节点统一指向 app-content:8004。

## 端口

| 端口 | 承载 | 说明 |
|------|------|------|
| 8004 | 全部（三域） | HTTPS（TLS rotator，证书目录 /app/certs；唯一 listener） |

## 结构

```
default.yaml                 # ★ 唯一配置（board/note/quiz 三段，embed）
cmd/app-content/main.go      # 组合根：config → 单 logger → bootstrap.Run（唯一 listener）
internal/
├── config/                  # 一个配置入口；config/{board,note,quiz} 保留原 env 前缀
├── dto/{board,note,quiz}/   # HTTP 边界 DTO（binding 校验 + 响应 mapper）
├── middleware/              # 统一安全链：request-id/安全头/CORS/body limit/X-Uid/内部密钥
├── logger/                  # ★ 全局 logger（slog + Gin/GORM 适配 + request-id context）
├── bootstrap/                # 唯一组合根：Run + mux + *http.Server；setup{Board,Note,Quiz}
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

> `internal/bootstrap` 是唯一组合根：一个 `Run(ctx,cfg)`、一个 mux、一个 `*http.Server`（一个端口），**不是三个独立服务/二进制**；整个模块只有一个 `main`。域间目前无调用；未来跨域只能经对方 service 接口，禁止跨域 import repo/router，也禁止进程内 HTTP 回环自调用。全部 Go 测试在 `tests/` 包（`tests/architecture_test.go` 守护唯一 listener 与测试目录）。

## 配置

- 唯一文件 `app-go/app-content/default.yaml`：进程级 `app/server/security/log/observability` + 域级 `board/note/quiz`（连接池、业务限制）。
- 高级项：TLS 1.2/1.3 + client_auth、HTTP/2、trusted_proxies、优雅关停、安全头/HSTS、CORS、令牌桶限流、三域 body limits、日志轮转/add_source、Prometheus `/metrics`、可选 pprof。
- env：进程级 `CONTENT__SECTION__KEY`；域级继续兼容 `APPBOARD__` / `APPNOTE__` / `APPQUIZ__`。
- 共享 env：`RDBMS__URL`、`MONGO__URI`、`REDIS__URL`、`APISIX_CONSUMER_KEY`、`CONTENT__INTERNAL_API_KEY`（/internal/* 二次校验，fail-closed；与 APISIX consumer key 同值）。
- 仅 HTTPS：默认 8004 TLS；本地调试如需明文，显式 `CONTENT__ALLOW_INSECURE_HTTP=true`。

## 运行

```bash
cd app-go/app-content && go run ./cmd/app-content
go test ./...
docker compose up -d app-content
```

> 从旧三服务升级：旧 app-note/app-quiz/app-board 容器会占用 8008/8011/8004，
> 必须先删除（`docker compose up -d --remove-orphans app-content` 或先 stop/rm 旧容器）。
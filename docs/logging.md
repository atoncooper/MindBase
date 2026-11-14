# app-ts 日志规范（结构化 / 请求关联 / 脱敏 / 轮转压缩）

> 适用：`app-ts`（AI 域服务）。实现见 `app-ts/src/logger.ts`、`app-ts/src/transport/http/server.ts`、`app-ts/src/bootstrap/process-errors.ts`；配置见 `app-ts/config/default.yaml` 的 `log:` 段。测试：`app-ts/test/logging.test.ts`。

---

## 1. 两个 sink

| sink | 内容 | 开关 |
|---|---|---|
| stdout | pino JSON 单行（容器日志采集的权威来源） | 始终开启 |
| 文件 | 同一批 JSON 行，写入 `log.dir`/`log.fileName`，按大小/时间轮转 + gzip | `log.fileEnabled` |

- 容器内 `log.dir` 由 compose 注入 `LOG__DIR=/app/logs`，挂命名卷 `app_ts_logs`；镜像已预建 `/app/logs` 且属主为 `node`。
- 文件 sink 用 `rotating-file-stream`（v4，本地类型声明在 `app-ts/src/types/rotating-file-stream.d.ts`）。流报错只写 stderr，不会让进程退出。
- 优雅关停时 `closeLogger()` 会 `end()` 文件流，确保最后一批日志落盘。

## 2. 结构化字段

每条记录都是单行 JSON，公共字段如下（`pino` 默认字段 + 本项目注入）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `time` | pino `isoTime` | ISO-8601 UTC 时间，如 `2026-11-13T16:22:01.256Z` |
| `level` | pino | 数值级别：10 trace / 20 debug / 30 info / 40 warn / 50 error / 60 fatal |
| `service` | `log.service`（默认 `app-ts`） | 逻辑服务名，多服务日志集中采集后用于区分来源 |
| `env` | `NODE_ENV`（缺省 `development`） | 运行环境 |
| `pid` / `hostname` | 进程 | 多副本/多容器排查 |
| `module` | `createLogger("HTTP")` 等 | 模块名（等同旧文本前缀 `[HTTP]`） |
| `msg` | 调用点 | 人类可读的一句话（保留 `[MODULE]` 前缀，便于 grep） |
| `request_id` | 请求上下文（ALS） | 仅请求内日志；同时回写响应头 `x-request-id` |
| `uid` | 请求上下文（ALS） | 仅已认证请求；字符串形式（int64 精度） |
| `err` | `pino.stdSerializers.err` | 错误对象：`{type,message,stack,...}`，禁止把堆栈拼进 `msg` |

访问日志（`onResponse`，每个请求一条）额外字段：

| 字段 | 说明 |
|---|---|
| `method` / `path` | HTTP 方法 + **已脱敏**的 URL（query 敏感值掩码、分享 token 掩码、长度 ≤512） |
| `route` | Fastify 路由模板（如 `/chat/sessions/:id`），便于按端点聚合 |
| `status` / `duration_ms` | 状态码 / 耗时（毫秒） |
| `ip` / `user_agent` | 客户端 IP / UA（截断 120 字符） |
| `content_length` | 响应长度（有则记录） |
| `slow_request` | 仅慢请求时为 `true` |
| `err` | 5xx 时附带错误对象 |

> 红线：访问日志**不记录**请求体、响应体、Authorization/Cookie/token 等凭证。

## 3. 级别约定

| 级别 | 用法 |
|---|---|
| `error` | 5xx、工具/外部服务失败、未处理异常；必须带 `err` |
| `warn` | 4xx、慢请求（`slow_request=true`）、可恢复降级（memory fallback 等） |
| `info` | 生命周期（启动/关停/装配摘要）、请求完成、业务关键节点 |
| `debug` | 排障细节，生产默认关闭（`log.level: info`） |
| `fatal` | 未捕获异常等不可恢复状态，随后走优雅关停 |

进程级兜底（`installProcessErrorHandlers`）：`unhandledRejection` → `log.error({ err })` 后继续服务；`uncaughtException` → `log.fatal({ err })` 后优雅关停并 `exit(1)`。

## 4. 请求关联

- HTTP `onRequest` 生成/透传 `x-request-id`，写入 AsyncLocalStorage 请求上下文；agent/tools/下游客户端在同一异步链上自动继承。
- 日志 `mixin()` 在每条记录上注入 `request_id`/`uid`；无请求上下文（启动、后台任务、事件桥）时不注入这两个字段。
- 跨服务排障：app-ts 响应头 `x-request-id` 与下游服务的 `X-Request-Id` 对齐后，可用同一个 id 串起整条链路。

## 5. 脱敏规则

### 5.1 字段级（pino redact，censor 固定为 `[REDACTED]`）

- 请求头：`req.headers.authorization`、`req.headers.cookie`、`req.headers["set-cookie"]`
- 任意层级字段：`*.authorization`、`*.apiKey`/`*.api_key`/`*.apikey`、`*.password`、`*.secret`、`*.token`、`*.accessKey`/`*.secretKey`/`*.privateKey`、`*.credential`
- 顶层同名平铺字段同样脱敏（`password`/`secret`/`token`/`apiKey`/…）。

### 5.2 URL 级（`sanitizeUrl`）

- query 中以下参数（大小写/连字符/下划线不敏感）值替换为 `[REDACTED]`：`token`、`access_token`、`key`、`apikey`/`api_key`、`signature`/`sig`、`code`、`password`、`secret`、`session`、`ticket`、`authorization`、`credential` 及 `X-Amz-*` 预签名参数。
- 路径中的分享 token：`/notes/shared/<token>`、`/cloud/s/<token>` → 掩码。
- `/minio-proxy/...` 预签名代理 URL：整个 query 丢弃，只保留路径。
- 最终长度截断到 512 字符，防止恶意超长 URL 撑爆日志。

## 6. 轮转、压缩与保留

配置（`app-ts/config/default.yaml`）：

```yaml
log:
  service: app-ts
  level: info
  fileEnabled: true
  dir: logs
  fileName: app-ts.log
  rotation:
    enabled: true
    size: 20M      # 单文件 20MB 触发轮转
    interval: 1d   # 或每天轮转一次（先到先转）
    maxFiles: 14   # 只保留 14 个已轮转文件（按大小轮转时）
    compress: gzip # 轮转文件压缩为 .gz
  accessLog:
    enabled: true
    slowRequestMs: 3000
```

- 当前日志：`/app/logs/app-ts.log`；轮转文件形如 `/app/logs/app-ts.log.1.gz`、`app-ts.log.2.gz`…（按时间轮转时带时间戳后缀），历史清单文件 `/app/logs/app-ts.log.history`。
- 保留策略：`maxFiles` 由 rotating-file-stream 按轮转历史裁剪，超出即删除最旧文件；`compress: gzip`（或 `true`）压缩，`none`/`false` 关闭压缩。
- 磁盘粗估：`size × maxFiles` ≈ 20MB × 14 ≈ 280MB 上限（压缩后更小）。
- `fileEnabled: false` 时只用 stdout；`rotation.enabled: false` 时退化为普通单文件（无轮转/压缩）。

环境变量覆盖（`SECTION__KEY`，YAML 普通配置优先，密钥才进 `.env`）：

```bash
LOG__LEVEL=info
LOG__SERVICE=app-ts
LOG__FILE_ENABLED=true
LOG__DIR=/app/logs
LOG__FILE_NAME=app-ts.log
LOG__ROTATION__ENABLED=true
LOG__ROTATION__SIZE=20M
LOG__ROTATION__INTERVAL=1d
LOG__ROTATION__MAX_FILES=14
LOG__ROTATION__COMPRESS=gzip
LOG__ACCESS_LOG__ENABLED=true
LOG__ACCESS_LOG__SLOW_REQUEST_MS=3000
```

## 7. 访问日志与慢请求

- 每个请求一条 `[HTTP] request completed`：2xx/3xx → info，4xx → warn，5xx → error（带 `err`）。
- `duration_ms > slowRequestMs`（默认 3000ms）时记录 `slow_request: true`；成功但慢的请求额外输出一条 `[HTTP] slow request` warn。
- 5xx 错误处理器（`setErrorHandler`）另有一条 `[HTTP] unhandled error`，同样结构化并保留 `x-request-id` 响应头；4xx 为 `[HTTP] request rejected`（warn，带 `detail`）。

## 8. 运维命令

```bash
# 实时看 stdout（容器日志）
docker compose logs -f --tail=200 app-ts

# 卷内文件（宿主机侧可直接读命名卷路径，或进容器）
docker compose exec app-ts ls -lh /app/logs
docker compose exec app-ts sh -c 'zcat /app/logs/app-ts.log.*.gz | tail -n 200'

# 按关键词搜已压缩历史（zgrep 直接读 .gz）
docker compose exec app-ts sh -c 'zgrep -h "unhandled error" /app/logs/app-ts.log.*.gz | tail -n 50'

# 用 jq 结构化过滤：只看 5xx
docker compose exec app-ts sh -c 'cat /app/logs/app-ts.log | jq -c "select(.status >= 500)"'

# 只看某个 request_id 的完整链路（stdout 适合直接管道）
docker compose logs app-ts | jq -c 'select(.request_id == "REPLACE_ME")'

# 慢请求 top
docker compose exec app-ts sh -c 'cat /app/logs/app-ts.log | jq -c "select(.slow_request == true) | {time,path,status,duration_ms}" | tail -n 50'

# 错误聚合（按 err.message）
docker compose exec app-ts sh -c 'cat /app/logs/app-ts.log | jq -r "select(.level >= 50) | .err.message" | sort | uniq -c | sort -rn | head'
```

> `jq`/容器内无 jq 时：`docker compose logs app-ts | grep '"level":50'` 可先粗筛，必要时把日志导出到宿主机再处理。压缩文件注意先 `zcat`/`zgrep`。

## 9. 容器日志卷

| compose | app-ts 卷 | 说明 |
|---|---|---|
| `docker-compose.yml`（服务端） | `app_ts_logs:/app/logs` | 与 app-go/app-pay 各服务同模式；`LOG__DIR=/app/logs` |
| `docker-compose.client.yml`（单用户） | `app_ts_logs:/app/logs` | 同上，同样启用文件 sink |

- 卷随 `docker compose down` 保留，`down -v` 会删除（生产严禁随意清理）。
- 需要集中采集时以 stdout 为准；文件卷用于容器重启后仍可查历史、以及无日志驱动环境下的兜底。
- 备份/排障不要直接改卷内文件；如需长期归档，把 `.gz` 复制到备份目录即可。

## 10. 测试

```bash
cd app-ts && npx vitest run test/logging.test.ts
```

覆盖：URL 脱敏（敏感 query / 分享 token / 预签名路径 / 长度截断）、pino 选项（redact/mixin/base/timestamp/err 序列化）、JSON 行断言（`service`/`module`/`request_id`/`uid` 与密码脱敏）、轮转（极小 size 触发 `.gz` 并可 gunzip、`maxFiles` 保留上限）、无轮转时的单文件降级。

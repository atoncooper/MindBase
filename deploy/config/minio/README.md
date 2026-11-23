# MinIO — env-only component (no config file)

MinIO 没有配置文件：所有服务端配置都通过 `MINIO_*` 环境变量提供，因此本目录
只记录契约，实际值写在 `docker-compose*.yml` 的 `environment:` 字面量里。

| 配置 | 位置 | 说明 |
|------|------|------|
| 端口 / 控制台 | compose `command:` + `ports:` | `server /data --console-address :9001` |
| 浏览器控制台 | compose env `MINIO_BROWSER=off` | 省一个常驻进程 |
| 对象事件 → Redis | compose env `MINIO_NOTIFY_REDIS_*` | clouddrive bucket 事件驱动向量化 |
| 未完成分片清理 | compose env `MINIO_API_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS` | 断传清理 |
| 根凭据 | `.env`（`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`） | 密钥，禁止进 git |
| TLS | `secrets/certs/minio` 挂载 + compose `--certs-dir` | 证书由 cert-gen 生成 |

需要改 MinIO 行为时改对应 compose 字面量（提交进 git），不要新增 `.env` 变量。

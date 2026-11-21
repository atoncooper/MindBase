# APISIX 配置维护

APISIX 使用 **standalone 模式**，路由与消费者全部由声明式 YAML 定义：

- `apisix.yaml.template`：**唯一标准配置**（service 名 upstream，HTTPS；
  Docker / 生产 / 单人客户端共用，不维护 dev/client 变体）。
- `config.yaml`：APISIX 进程配置（standalone yaml provider、9443 内部 TLS 等）。
- `render-config.sh`：启动时把 `__APISIX_*` / `__PAY_*` 占位符替换为环境变量，
  并把 9443 监听证书 PEM 注入 `ssls` 块；**渲染产物不提交**。

> Standalone 模式下 dashboard / Admin API 的修改不会持久化。  
> 任何变更都必须改模板 + 重启 APISIX，不要改 dashboard。

## 路由分类

| 类别 | 示例 | 鉴权 |
|---|---|---|
| 用户 API | `/cloud/*`、`/notes/*`、`/pay/*` | `forward-auth` → app-user，注入 `X-Uid` |
| 用户认证 API | `/auth/*` | app-user 自校验 Bearer，不 forward-auth |
| 公网渠道回调 | `/pay/callback/*` | 渠道验签，不 forward-auth |
| 内部 M2M | `/internal/*` | `key-auth` + consumer-restriction |
| 服务任务路由 | `/tasks/register`、`/scripts*` | `key-auth` |
| 公共 CORS 预检 | `board_preflight` | 无身份，仅 OPTIONS |

所有 `forward-auth` 路由都必须先移除客户端伪造的 `X-Uid` / `X-Roles`，
再由 forward-auth 注入验证后的值。

## 修改流程

1. 只改 `apisix.yaml.template` 一份（所有部署形态共用同一路由面）。
2. 本地渲染冒烟（需要 `APISIX_CONSUMER_KEY`，不依赖 Python 或额外包）：

   ```bash
   APISIX_CONSUMER_KEY=dev-only \
     sh apisix/render-config.sh apisix/apisix.yaml.template /tmp/apisix.yaml
   ```

3. 重启 APISIX：

   ```bash
   docker compose up -d --force-recreate apisix
   ```

4. 验证：

   ```bash
   docker compose logs --tail=100 apisix
   curl -k -I https://localhost/_edge/health
   ```

## 一致性约定（评审/启动冒烟时逐条确认）

仓库不包含 Python 检查器；以「渲染冒烟 + APISIX 启动日志 + 人工评审」为准，需确认：

- 渲染后的 `apisix.yaml` 能被 APISIX 正常加载（启动日志无 schema 错误），route id / upstream id 唯一；
- 所有 `upstream_id` 存在；
- `/internal/*` 必须有 `key-auth`；
- 用户路由必须有 `forward-auth`，除非在显式 public/service allowlist；
- 所有 `forward-auth` 路由必须 remove `X-Uid` / `X-Roles`；
- 禁止 `catch_all`；
- 模板必须包含核心用户路由：
  `auth_user`、`cloud_user`、`workspaces_user`、`notes_user`、`pay_user`。

修改路由时请按上述清单自检（没有自动化的 Python 检查步骤）。

## 已知边界

- 需要更长 read timeout 的 SSE 路由单独声明，避免套用普通 API 的 30s。
- 上传字节、HLS、媒体对象由 OpenResty 直连 MinIO，不经过 APISIX。
- 公开分享 `/cloud/s/*` 也是 OpenResty 直连 app-cloud 的例外。
- 修改 upstream TLS 校验策略前，先确认内部 CA 已挂载到 APISIX。

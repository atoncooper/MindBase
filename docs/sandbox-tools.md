# 沙箱命令与 workspace

## 原生执行

app-sandbox 的 `POST /v1/executions` 现在接受：

```json
{ "language": "bash", "code": "grep -rn TODO /workspace" }
{ "language": "sh",   "code": "..." }
{ "language": "pwsh", "code": "Get-ChildItem" }
```

- 命令在 app-sandbox 的隔离容器里执行，不在 app-ts 宿主机；
- lease 按 `(uid, project, purpose)` 复用，`/workspace` 在 TTL 内持久；
- bash/sh 由镜像提供；pwsh 只有镜像安装 PowerShell 7 时可用，否则明确失败；
- 原有 `run_code` 的 python/javascript 路径不变。

## app-ts 工具

```text
sandbox_bash   AI 填写 bash 命令
sandbox_pwsh   AI 填写 PowerShell 命令（能力探测）
sandbox_grep   结构化 grep/rg，默认搜索 /workspace
```

## 工程结构（2026-11-12 重构）

- `internal/dto/`：HTTP wire 层（`execution.go` / `admin.go` / `lease.go` / `common.go`），router 不再拼 `gin.H`，响应结构集中在此并有 `tests/dto_test.go` 守护键集/空数组语义；
- `internal/router/`：按动作拆文件（`executions_create/read/events`、`admin_{auth,query,overview,executions,leases,quota,audit,config}`、`ops`），`executions.go`/`admin.go` 只做注册；
- `internal/service/`：`execution.go` 拆为 create（execution.go）/ run（execution_run.go）/ state（execution_state.go）/ stream（execution_stream.go）/ support（execution_support.go）；`admin.go` 拆 read/write；
- 行为与 JSON 契约不变，现有 `tests/` black-box 用例未改一行。

## 独立面板（2026-11-12）

用户可在导航「更多 → 沙箱」进入 `/sandbox`：

- app-sandbox 新增 `GET /v1/executions?limit=`（uid 维度，`X-Uid` 鉴权，缺省 20 / 上限 50，新到旧）；
- app-ts 以 `/chat/sandbox/executions`、`/chat/sandbox/executions/:id`、`/chat/sandbox/executions/:id/cancel` 代理（`sandbox.enabled=false` 时返回 `{ enabled:false, executions:[] }`）；
- 面板展示执行状态/耗时/退出码/stdout-stderr 预览/artifacts，queued|running 可取消，运行中 5s 轮询；
- 启用条件：app-ts 容器 `SANDBOX__ENABLED=true`（compose 已接 `SANDBOX_ENABLED`）且 app-sandbox 可达。

## 已验证

`language: "sh"` + `echo hi && pwd && ls /workspace` 通过 app-sandbox 原生执行，stdout = `hi\n/workspace\n`。

## 边界

- 当前没有独立文件 read/write/edit 工具，命令通过 shell 操作 /workspace；
- 大文件/产物仍走 app-sandbox artifact 收集与 app-cloud M2M 文件接口；
- 命令安全策略（allow/deny/审批）仍是下一步。


## PowerShell 镜像复用

OpenSandbox 每次创建沙箱都使用同一个 `SANDBOX__RUNTIME__IMAGE`，镜像层由 Docker/OpenSandbox 缓存，**不会每次执行都安装 PowerShell**。

仓库提供：

```bash
docker build -f app-go/app-sandbox/images/pwsh.Dockerfile -t mindbase/sandbox-pwsh:7.4 .
```

然后设置：

```bash
OPEN_SANDBOX_SANDBOX_IMAGE=mindbase/sandbox-pwsh:7.4
```

新沙箱从该镜像创建，镜像内已含 `pwsh` / `python3` / `git` / `rg` / `jq`。  
控制层 app-sandbox 仍是 distroless，不需要 PowerShell。

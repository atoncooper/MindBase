# 沙箱命令与 workspace

## 原生执行

app-sandbox 的 `POST /v1/executions` 现在接受：

```json
{ "language": "bash", "code": "grep -rn TODO /workspace" }
{ "language": "sh",   "code": "..." }
{ "language": "pwsh", "code": "Get-ChildItem" }
```

- 命令在 app-sandbox 的隔离容器里执行，不在 app-ts 宿主机；
- lease 按 `(uid, project, purpose, networkPolicyHash)` 复用，`/workspace` 在 TTL 内持久；
- app-ts 现在把 `projectId` 与 `purpose`（chat / experiment）传给 app-sandbox，不同科研项目不会共享 lease；
- 项目永久删除会调用 `DELETE /v1/leases?projectId=` 释放该项目 lease；
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

## 文件读取（offset 分页）

新增两个工具：

- `sandbox_read_file(path, offset?, limit?)`
- `sandbox_write_file(path, content)`

大文件不会一次性塞给模型：读取响应固定带

```
offset / bytes / total_bytes / has_more / next_offset
```

- `has_more=true`：继续调用 `sandbox_read_file`，`offset=next_offset`；
- `has_more=false`：已到文件末尾；
- `offset` 是 **UTF-8 字节偏移**，服务端会回退到字符边界，不会切坏中文；
- 默认单次 32KiB，最大 128KiB；只读 `/workspace` 下的文本文件；
- 写入覆盖单个文本文件，自动创建父目录，单次 ≤1MB。

## 执行输出分页

`run_code` / `sandbox_bash` 的终态结果会提示：

```text
output_truncated: true (total 12345 bytes; use sandbox_execution_output execution_id=exec-...)
```

`sandbox_execution_output(execution_id, stream?, offset?, limit?)` 读取完整 stdout/stderr：

- 返回 `has_more` / `next_offset`，用法与 `sandbox_read_file` 一致；
- 返回 `source_bytes`（程序真实输出字节数）与 `truncated`（capture 上限是否截断）；
- 默认单次 32KiB，最大 128KiB；
- timeout / cancel 也会保留已捕获的部分输出；
- 当前单次执行完整捕获上限为 1MiB，超过部分标记 `truncated=true`。

## 输入文件 / 云盘文件 / 产物读取

- `run_code` 支持 `files: [{path, content}]`（执行前写入 /workspace，最多 20 个、单个 1MB）与
  `artifactGlobs`（额外产物路径，必须在 /workspace/analysis/outputs 下）。
- `sandbox_write_file` 支持 `encoding: utf8 | base64`，可写二进制文件（单次 ≤8MB）。
- `sandbox_import_cloud_files` 将当前对话选中的云盘文件（`scope.uploadUuids`）导入
  `/workspace/analysis/data`，单文件 ≤8MB；云盘正文由 app-cloud M2M 下载，不在 app-ts 解析。
- `sandbox_read_artifact(execution_id, name, offset?, limit?)` 读取产物内容：
  - 文本返回 `encoding: utf8`；
  - 二进制返回 `encoding: base64`、`binary: true`；
  - 同样带 `has_more` / `next_offset`。

## 能力发现 / 超时 / 幂等

- `sandbox_info`：返回当前镜像、CPU/内存、网络策略、app-sandbox 接受的 language；
  AI 在写代码前应先确认镜像是否包含 bash/node/pwsh。
- 执行创建带 `Idempotency-Key`，网络重试不会重复创建 execution。
- app-ts 本地等待预算会按请求的 `timeoutMs` 延长（+15s HTTP 余量，上限 620s）；
  本地超时/用户取消时会向 app-sandbox 发送 `POST /v1/executions/{id}/cancel`，
  避免远端继续空转。
- 当前部署的 `mindbase/sandbox-pwsh:7.4` 镜像包含 bash 5.2、PowerShell 7.4、Python 3.11；node/科学计算包仍需自定义镜像（旧 `python:3.12-alpine` 镜像只有 sh）。

## 超时与重试预算

- `run_code` 的 `timeoutMs` 由模型显式传入，默认 130s，最长 1h；
- 同一份完整代码版本（`language + code + files` 哈希不变）最多执行 **6 次**
  （首次 + 5 次重试）；输出会带 `retry_budget: attempt n/6, remaining_retries=x`；
- 修改代码或输入文件即视为新版本，重试预算重置；
- 成功执行会清除该版本预算；未真正到达沙箱（配额/传输失败）会退还一次；
- 等待期间 app-ts 采用自适应轮询（500ms → 3s），不消耗 LLM token。

## 边界

- 默认 `network.egressDefaultAction=allow`：沙箱默认可访问外网；生产环境可改为
  `deny` + `SANDBOX__NETWORK__EGRESS_ALLOW=pypi.org,files.pythonhosted.org` 收紧；
- 当前 Docker 部署的 egress 为 DNS-only，直接连 IP/CIDR 仍可能绕过（OpenSandbox
  nftables 未启用）；
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

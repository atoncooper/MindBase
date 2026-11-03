# 代码执行（run_code 链路）

> 本文描述应用侧怎么把一段代码交给隔离沙箱、拿到什么结果、失败时如何降级。
> 控制层实现细节见 [features.md](features.md) §5 与 [academic-agent.md](academic-agent.md) §沙箱；部署见 [deploy/docker/opensandbox](../deploy/docker/opensandbox/README.md)。

---

## 一、工具契约

`run_code` 由 `code` 与 `academic` 子 agent 使用，输入：

| 字段 | 类型 | 说明 |
|------|------|------|
| `language` | `javascript` / `python` | 运行语言 |
| `code` | string，1–20000 字符 | 完整代码 |
| `timeoutMs` | 正整数，可选 | 单次执行预算，默认 10000 |

身份（`uid`）由工具运行时从 `ToolRunContext` 注入，**不是** LLM 可写字段；它经 `X-Uid` 头传给控制层，用于配额、租约与审计归属。

返回给模型的是中文纯文本：`exit` / `exit_code` / `execution_id` / 产物列表 / stdout（截断 4000 字符）/ stderr（截断 2000 字符）。

---

## 二、执行边界

工具层唯一沙箱边界是 `CodeExecutionPort`，组合根按配置选择实现：

```text
run_code ──► CodeExecutionPort
                ├── HttpCodeExecution   POST /v1/executions + 轮询（X-API-Key + X-Uid）
                └── NoopCodeExecution   sandbox.enabled=false 时的诚实降级
```

- `HttpCodeExecution`：向 app-sandbox 创建执行，轮询到终态；本地超时与取消信号都收敛为「不可用」。
- `NoopCodeExecution`：不执行任何代码，返回统一的可读错误。

**失败策略**：两种实现都**不允许抛出**到 ReAct 循环。任何失败都返回 `sandboxAvailable=false` + 中文 `error`，模型据此告诉用户「代码没有被实际运行」，绝不伪造成功结果。

---

## 三、调用链

```text
agent (run_code)
  │
  ▼
app-ts  CodeExecutionPort
  │  APISIX key-auth  /internal/sandbox/v1/*
  ▼
app-sandbox :8017（Go 控制层）
  │  租约复用 → 配额校验 → 准入队列 → 运行时执行 → 产物登记 → 审计
  ▼
OpenSandbox lifecycle + execd（隔离容器内执行）
```

控制层职责：

- **租约复用**：`uid + project + purpose + specHash → lease`，TTL 到期回收，避免每次执行新建沙箱；
- **配额**：`academic_run` / `sandbox_concurrent` / `sandbox_cpu_seconds` / `sandbox_artifact_bytes` × 会员档位；
- **准入**：全局与每 uid 并发上限、有界队列（满则 503 / 429）；
- **审计**：uid / 项目 / 镜像 / 耗时 / exitCode / 产物 hash / request_id 全生命周期落 `sandbox_audit`；
- **回收**：执行超时、租约 TTL、孤儿 sweeper。

---

## 四、结果与持久化

| 数据 | 位置 | 说明 |
|------|------|------|
| 执行记录 | MySQL `sandbox_execution` | 状态机、stdout/stderr 预览、exitCode、耗时、request_id |
| 租约 | MySQL `sandbox_lease` | 复用键、运行时 id、TTL |
| 产物元数据 | MySQL `sandbox_artifact` | name / size / sha256 / type / objectKey |
| 审计 | MySQL `sandbox_audit` | 全生命周期事件与 actor |
| 学术执行记录 | Mongo `academic_runs` | 脚本 sha256 / exitCode / 产物 / 耗时（`academic_evidence` 工具写入） |
| 产物对象 | MinIO | 预签名短时效 URL |

控制层对 stdout/stderr 只保留截断预览（`previewBytes`），管理台不展示代码正文与完整输出；产物只暴露元数据与短时效链接，不提供下载。

---

## 五、配置

`app-ts/config/default.yaml`：

```yaml
sandbox:
  enabled: false                 # true 时注册 HttpCodeExecution，否则 run_code 诚实降级
  baseUrl: http://127.0.0.1:9080/internal/sandbox
  apiKey: ""                     # 与 APISIX consumer key / app-sandbox X-API-Key 一致
  timeoutMs: 60000
  pollIntervalMs: 500
```

对应环境变量（loader 的 `SECTION__KEY` 机制）：`SANDBOX__ENABLED` / `SANDBOX__BASE_URL` / `SANDBOX__API_KEY` / `SANDBOX__TIMEOUT_MS` / `SANDBOX__POLL_INTERVAL_MS`。

app-sandbox 侧另有 `SANDBOX__RUNTIME__*`（运行时、镜像、资源上限）、`SANDBOX__QUOTA__*`、`SANDBOX__ADMISSION__*`、`SANDBOX__LEASE__*`，默认值见 `app-go/app-sandbox/default.yaml`；OpenSandbox 的 `OPENSANDBOX_API_KEY` 两侧必须一致。

---

## 六、部署

```bash
# 单机最小链路（OpenSandbox lifecycle + app-sandbox）
docker compose --profile sandbox up -d opensandbox-server app-sandbox

# 生产 K8s
kubectl apply -k deploy/k8s/40-sandbox     # OpenSandbox 控制面/运行时/热池（见该目录 README）
```

单机形态挂载 Docker socket 创建 sibling 沙箱容器，**仅适用于可信单机环境**；多租户生产请使用 K8s 运行时与网络策略。

---

## 七、已知限制

- 产物链路：执行产物登记接口已就绪；真实 execd 取文件 → MinIO 预签名仍在验证，未验证前以元数据为准。
- 取消：远端 exec 的取消语义依赖 OpenSandbox，当前以本地取消 + 超时兜底。
- sweeper 的 leader 选举、真实 MySQL DDL、K8s runtime 仍在验证。
- 历史说明：Python 时代的「Mongo `code_executions` 持久化 + Daytona」实现已随 backend 退役，执行记录改由 app-sandbox 承载（本文已按现状重写）。

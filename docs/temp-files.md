# agent 解析临时文件（下载 → 本地 → 解析 → 整轮结束删除）

> 面向：app-ts 后端 / agent 工具开发者、运维。
> 代码：[`app-ts/src/context/temp-workspace.ts`](../app-ts/src/context/temp-workspace.ts)（管理器）、
> [`app-ts/src/services/docx-inspect.ts`](../app-ts/src/services/docx-inspect.ts)（首个接入方）、
> [`app-ts/src/services/chat.ts`](../app-ts/src/services/chat.ts)（生命周期调用方）。
> 配置：`app-ts/config/default.yaml` 的 `tempFiles` 段。

## 1. 为什么有这一层

部分文档解析（当前 `docx_inspect`，后续 pdf/xlsx/pptx 同理）需要先把原件落成本地文件再交给解析器。
如果让工具自己「下载 → 解析 → 删除」，会带来三个问题：

1. **删除责任落在 agent 手里**：模型/工具可能忘记删、重复删，甚至被提示词诱导删掉别的文件；
2. **隔离缺失**：不同用户、不同轮次的文件混在同一目录，可能被跨用户读取；
3. **fd / 磁盘失控**：并发轮次 × 每轮文件数没有上限，极端情况下把文件描述符耗尽，整个进程被拖崩。

因此本设计把生命周期上移到**程序**：工具只能「创建」，删除只由 `ChatService` 在**整个 agent 回合结束时**执行；
再加用户/轮次隔离与预算/并发上限。

## 2. 生命周期时序

```
用户提问
  │
  ▼
HTTP 请求进入（server.ts 创建 RequestContext：requestId + uid，写入 AsyncLocalStorage）
  │
  ▼
ChatService.askStream()
  ├─ 捕获 getRequestContext()?.requestId（本轮唯一标识）
  ├─ harness.dispatchStream(...) ── ReAct 循环
  │     └─ 工具 docx_inspect
  │           ├─ 从会话上传 / 项目云盘取原件 bytes
  │           ├─ TempWorkspaceManager.materialize(requestId, uid, bytes, name, mime)
  │           │      → <root>/u-<hash(uid)>/turn-<requestId>/<uuid>.<ext>
  │           ├─ fs.readFile(临时文件)          ← 解析读的是磁盘文件
  │           ├─ parseDocxDetail(bytes) → 中文摘要文本
  │           └─ 返回文本（**不删文件**）
  ├─ 正常结束 / error / 客户端断开 / 整轮超时
  └─ finally: await tempWorkspaces.disposeRequest(requestId)
        → 递归删除本轮目录、释放全局计数（幂等；失败只 warn，不影响 SSE）
```

要点：

- **回合边界 = 清理边界**：一轮 SSE 请求内产生的所有临时文件在该轮 `askStream` 的 `finally` 里统一删除，
  覆盖正常 `done`、错误帧、客户端断开（generator `.return()` 也会走 `finally`）、整轮超时。
- **早退路径**（配额拒绝、排队失败）没有临时文件，`disposeRequest` 是空操作。
- **进程退出**：`container.ts` 的 shutdown 调 `TempWorkspaceManager.close()`（删所有已跟踪目录 + 清定时器）。
- **工具/模型没有任何删除接口**：工具拿到的是 `TempFileWorkspace`（只有 `enabled` + `materialize`），
  管理器实例本身只注入到 ChatService（`disposeRequest`）与 docx 解析服务（创建能力），从不出现在工具参数或 prompt 里。

## 3. 目录结构与隔离

```
<root>/                                  # 默认 os.tmpdir()/mindbase-agent，0700
└── u-<sha256(uid | "anon")[:16]>/       # 用户隔离：只存哈希，原始 uid 不落盘，0700
    └── turn-<requestId>/                # 轮次隔离：每个请求独立目录，0700
        ├── <uuid>.docx                  # 文件名 = randomUUID + 清洗后的扩展名，0600
        └── <uuid>.pdf
```

- `requestId` 来自请求上下文（uuid），uid 来自请求上下文/ToolRunContext，**绝不来自模型参数**。
- `requestId` 含特殊字符时会被哈希成安全路径段；`originalName`（如 `../../etc/passwd`）**只影响展示名**，
  绝不参与路径拼接（展示名还会剥掉路径分隔符与控制字符）。
- 目录 `0700`、文件 `0600`（Linux 生效；Windows 上 chmod 为尽力而为）。
- 同一 `requestId` 下不同 uid 也各自落在不同 `u-<hash>` 目录，互不可见。

## 4. 预算与 fd 上限

| 限制 | 默认值 | 作用 |
|---|---|---|
| 单轮文件数 `maxFilesPerTurn` | 4 | 一轮内最多 4 个临时文件 |
| 单轮总字节 `maxBytesPerTurn` | 64MB | 一轮临时文件总大小 |
| 单文件字节 `maxFileBytes` | 20MB | 与文档解析上限一致 |
| 全局文件数 `maxGlobalFiles` | 32 | **全进程同时存在的临时文件数**（跨轮次/跨用户） |
| 并发写入 `maxConcurrentWrites` | 8 | 同时打开写入的临时文件数（promise 信号量） |
| 残留过期 `staleTtlMs` | 6h | sweep 判定残留的阈值 |
| sweep 间隔 `sweepIntervalMs` | 10min | 定期清理（`unref`，不阻止进程退出） |

- 文件用 `fs.promises.open(path, "wx", 0o600)` → `writeFile` → `close`，**不长期持有 fd**；
  预算在写入前同步预留，写失败会回滚计数。
- 超限不抛异常：`materialize` 返回 `{ ok:false, error: "<中文 guidance>" }`，
  解析服务把它作为工具文本返回（例如「本轮临时文件数量已达上限（4 个），请缩小解析范围或分批提问」）。
- 全局上限按「文件数」而非「轮次数」计算：真正占用 fd/磁盘的是文件；一轮通常 1 个文件，32 个文件 ≈ 32 轮并发，
  远高于当前 `scheduling.maxConcurrent`（5），正常流量不会触顶，触顶说明有异常并发或未清理的残留。
- 并发写上限 8 同时约束「磁盘/对象存储抖动」与「进程打开文件瞬时峰值」；写入本身很短，排队时间可忽略。

## 5. 崩溃恢复与 sweep

- 进程被 kill -9 / 容器被杀后，内存里的 map 丢失，磁盘上可能残留 `turn-*` 目录。
- 启动时 `TempWorkspaceManager.start()` 先跑一次 `sweepStale()`，再挂 `sweepIntervalMs` 的定时器（`unref`）。
- sweep 直接扫描文件系统（`u-*/turn-*`），按目录 `mtime` 判断：
  `now - mtime > staleTtlMs`（默认 6h，远大于单轮 30min 硬超时）才删除，避免误删正在进行的轮次。
- 删除后同步释放全局计数（对 map 里已知的 turn）；空掉的 `u-<hash>` 目录会被尽力清除。

## 6. 配置

`app-ts/config/default.yaml`：

```yaml
tempFiles:
  enabled: true                    # false = 解析回退纯内存，不落任何本地文件
  dir: ""                          # 空 = os.tmpdir()/mindbase-agent
  maxFilesPerTurn: 4
  maxBytesPerTurn: 67108864        # 64MB
  maxFileBytes: 20971520           # 20MB
  maxGlobalFiles: 32
  maxConcurrentWrites: 8
  staleTtlMs: 21600000             # 6h
  sweepIntervalMs: 600000          # 10min；0 = 关定时器
```

环境变量覆盖（非敏感，放 YAML；env 仅用于部署差异）：

- loader 自动派生：`TEMP_FILES__DIR`、`TEMP_FILES__MAX_GLOBAL_FILES` …
- 兼容别名（文档/运维常用）：`TEMPFILES__DIR`、`TEMPFILES__MAX_GLOBAL_FILES` …（两者都支持，`TEMPFILES__*` 优先）

行为矩阵：

| 条件 | 解析路径 |
|---|---|
| `tempFiles.enabled=true` 且有请求上下文 | 落本地临时文件 → `readFile` → 解析（回合结束删除） |
| `enabled=false`、无请求上下文（脚本/后台任务）、`materialize` 超预算 | 回退内存解析（不落文件）；超预算时直接把 guidance 作为工具文本返回 |

## 7. 运维

查看残留（容器内 / 宿主机看卷都不落持久数据，重启即清）：

```bash
docker compose exec app-ts sh -c 'ls -la /tmp/mindbase-agent/*/ 2>/dev/null | head -50'
docker compose exec app-ts sh -c 'du -sh /tmp/mindbase-agent 2>/dev/null'
```

手动清理（生产谨慎：会删掉正在进行的轮次的临时文件，下一次解析会重新下载）：

```bash
docker compose exec app-ts sh -c 'rm -rf /tmp/mindbase-agent'
```

部署注意：

- **容器 `/tmp` 必须可写**（默认镜像即可；若设成 `read_only: true` 需给 `/tmp` 挂 tmpfs 或把 `TEMP_FILES__DIR` 指到可写卷）。
  `noexec` 无影响（只读写数据，不执行）。
- **文件描述符**：compose（root + client）的 app-ts 服务已设 `ulimits.nofile soft/hard = 8192`；宿主机建议同样
  `ulimit -n ≥ 8192`。本层把「同时存在的临时文件」限制在 32、「并发写入」限制在 8，所以稳态 fd 占用是有界的；
  8192 仍要留足 SSE 连接、Mongo/Milvus/gRPC 连接池等余量。
- 不建议把 `dir` 设为持久卷：临时文件是一次性的，持久卷反而会在进程反复重启后积累残留（虽有 sweep 兜底）。
- 多副本部署时每个副本各自管理自己的目录与计数（目录含随机 uuid，不会互相覆盖）。

## 8. 扩展新的解析工具

1. 工具/服务从会话上传或云盘取到 `Uint8Array`；
2. 依赖注入类型用 `TempFileWorkspace`（**只有** `enabled` + `materialize`，拿不到删除方法）；
3. `const requestId = getRequestContext()?.requestId`，有值且 `tempFiles.enabled` 时
   `materialize(requestId, uid, bytes, originalName, mime)`，然后 `fs.readFile(path)` 解析；
4. 不要在工具内删除文件，也不要缓存 path 跨轮次使用；
5. 预算超限把 `materialize` 返回的 `error` 原样作为工具文本返回（模型可自纠：缩小范围/分批）。

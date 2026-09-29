# app-task CLI（`at` 命令）参考

> `at` 是 app-task 的单二进制双角色命令行，规范对齐 docker：
> `<名词> <动词> [flags]`。总览见 [../README.md](../README.md)；
> 集群语义见 [cluster.md](cluster.md)。

## 1. 双角色

```bash
at                # 无参数 = 启动服务端（调度器 + API + 控制台）
at serve          # 显式服务端模式（与上一行完全等价）
at <名词> <动词>   # 客户端模式：HTTP 操作「运行中的」 app-task
```

服务端逻辑与旧的 `go run ./app-task` 入口完全一致；客户端命令不打扰服务进程。

## 2. 连接与认证（全局 flags + env）

| 来源优先级 | URL | 凭据 |
|-----------|-----|------|
| 1. 命令行 | `--url` | `--token` |
| 2. 环境变量 | `AT_URL` | `AT_TOKEN` |
| 3. 兼容回退 | 默认 `http://127.0.0.1:8001` | `APPTASK__WEBUI__TOKEN`（master token） |

**凭据两种皆可**：控制台 master token（`webui.token`，等价 admin，可调 /api/*）
或服务面 API 密钥（`at_` 前缀，「API 密钥」页生成）。请求同时携带
`X-WebUI-Token` 与 `X-API-Key` 两个头，服务端按凭据类型匹配端点面。

**注意权限边界**：`at` 的客户端凭据走的是管理/服务面——它看不到的东西
（例如他人会话、密钥明文）API 本来就不给。

## 3. 命令一览

```
at serve                          启动服务端
at info                           服务信息 + 统计（docker info 式）
at ps                             任务列表（= at task ls）
at task ls      [--status S] [--limit N] [--json]
at task create   （见 §3.2）
at task inspect  <task_id>        详情 + 最近日志（JSON）
at task logs     <task_id>        执行日志表格（--json 可选）
at script ls                     脚本列表
at script upload  --file f.lua [--name N] [--description D] [--id ID] [--disable]
at script inspect <script_id>     源码 + 版本历史 + 审计（JSON）
at script run     <script_id> [--payload P]
at logs          [--task-id T] [--limit N] [--json]
at email ls      [--status S] [--limit N] [--json]
at email retry   <email_id>
at node ls                       集群名册（存活/权重/认领数）
at node join      --name ID [--weight N] [--hostname H]    预登记新节点
at --version | --help
```

### 3.1 `task create`（最丰富的命令）

```bash
# 一次性 HTTP 任务（触发时间接受本地时区，自动转 UTC RFC3339）
at task create \
  --executor-url https://exec:9000/run \
  --trigger-time "2026-10-01 09:00:00" \
  --payload '{"order":"123"}' \
  --max-retry 3

# 周期 lua 任务（--script-id 自动写入 payload.script_id）
at task create --type lua --script-id <uuid> --cron "0 23 * * *" --async
```

- `--payload` 三种写法：内联 JSON / `@file.json` / `-`（stdin）；
- 属主 uid **默认不发送**（服务端自动归属当前凭据；master token = 0），
  `--uid` 显式给出才传；
- `--cron` 与 `--trigger-time` 至少一个；
- 成功输出新 `task_id`（一行，便于 `$(...)` 组合）。

### 3.2 `script upload`

```bash
at script upload --file notify.lua --name 通知脚本 --weight 描述可省略
```

- 省略 `--id`：服务端生成 UUID（新建）；传 `--id`：为既有脚本追加新版本；
- `--name` 默认取文件名去扩展名。

### 3.3 `script run`

```bash
at script run <script_id> --payload '{"n":1}'
```

同步执行，输出 `status=... run_id=... duration=...ms` 与 ctx.log 行；
非 success 退出码非零（可脚本化判断）。

### 3.4 `node ls` / `node join`（集群）

```bash
at node ls                        # 名册：node_id/主机/版本/权重/心跳/认领中/状态
at node join --name worker-3 --weight 4
```

- `node ls` 状态列：存活 / 失联（心跳 3 次未达）/ 待接入（已预登记未接入）；
- `node join`（admin）预登记节点并打印加入指引——**RDBMS 连接串永不经
  API 回显**（占位符 `<SHARED_DB_URL>`，真实 DSN 走密钥渠道）；
  集群 `admission: pre_approved` 时这是启动新节点的前置条件；
- 语义与限制详见 [cluster.md](cluster.md) §6。

## 4. 输出与脚本化

- 列表命令：tabwriter 对齐表格（人类阅读）；
- 全部 `ls`/`inspect` 支持 `--json`（机器消费，docker inspect 风格缩进）；
- `task create` / `script upload` 成功输出标识符一行，可直接回填下一步；
- 失败统一 `at: <原因>` 到 stderr，退出码 1；连接失败会提示
  「服务在跑吗？at serve」。

## 5. 常见错误

| 现象 | 原因 / 处理 |
|------|------------|
| `缺少 API 凭据` | 未提供 token：`--token` / `AT_TOKEN` / `APPTASK__WEBUI__TOKEN` |
| `HTTP 401: unauthorized` | token 错误或已吊销 |
| `HTTP 403: admin role required` | 该操作需 admin（node join 等） |
| `连接 ... 失败` | 服务未启动或 `--url` 不对 |
| `HTTP 409: 节点已在集群中` | join 的 node_id 已 active（换 id 或先处理旧节点） |

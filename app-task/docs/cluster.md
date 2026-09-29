# app-task 集群与分布式一致性

> 本文是 app-task 多实例（集群）部署与一致性的权威文档。总览见 [../README.md](../README.md)；
> 命令行用法见 [cli.md](cli.md)。

## 1. 架构总览：无主对称 + 单一权威存储

```
            ┌──────────────┐
            │  MySQL(自有) │  ← 唯一权威：任务/认领/fencing/名册 全在这
            └──┬───┬───┬──┘
       ┌──────┘   │   │└──────┐
   ┌───▼───┐  ┌───▼───┐ ┌──▼────┐
   │ node A │  │ node B │ │ node C │   ← 全部对称：每个实例跑完整 tick
   └───────┘  └───────┘ └───────┘
        │          │          │
        ▼          ▼          ▼
     executor_url（第三方执行器，HTTP，需幂等）
```

**刻意不做分布式共识/选主（Raft 等）**。理由：

- 调度状态的强一致权威已经存在（MySQL，ACID 事务）——互斥靠「条件更新 +
  fencing token」，不需要第二个协调层；
- Raft 只保证**日志复制**一致，从不保证**外部副作用**一致——上了 Raft，
  fencing 依然必须存在（被罢免的 leader 的迟到调用照样会发生）；
- 引入成本：raft 库 + WAL + 稳定成员列表 + ≥3 节点仲裁，与「单二进制、
  自带 MySQL、零额外组件」的形态冲突；
- 选主换来的只有「秒级 failover」和「follower 不空转」，而本调度器粒度是
  30s、空扫描 ~0.3 QPS——收益远小于成本。

**重新评估的触发条件**（满足其一再议）：调度状态搬出 MySQL（纯内存调度）、
failover 要求亚秒级、多区域 active-active 无法共享 MySQL。

## 2. 节点身份与名册（cluster 包）

- 每个实例启动时在 `cluster_node` 表注册一行：`node_id`（= `task.owner`，
  同一身份贯穿两处）、hostname、version、**weight**；
- **心跳**：每 10s（可扩展）upsert 一次 `last_heartbeat`；
- **存活是算出来的**：`now - last_heartbeat < 3 × 心跳间隔`（默认 30s）即存活；
  超时即「失联」，存活状态不落库；
- **优雅停机**主动注销名册行（活实例立刻看到它离开）；崩溃实例的行停更 →
  被判死 → **保留 24h 供溯源**后由每小时巡检清理；
- 预登记但从未接入的节点同样被 24h 清理兜底（可重新生成邀请）。

## 3. 任务派发生命周期

```
pending ──claim──► dispatching ──► completed        (同步 2xx)
                        │──► running ──► completed | failed   (异步 202+回调)
                        │──► pending            (失败且有重试额度，next_retry_at 退避)
                        └──► failed             (重试耗尽)
        ▲
        └── 回收：dispatching 超过 TTL(默认 120s) 或 所属节点被判死
```

每个 tick（默认 30s，实例间带 0–interval/10 随机抖动错峰）：

1. **cron 延展**：`ExtendCronTask` 单事务「条件占用 `cron_next_task_id`
   （预写 newID）+ INSERT 下一条」——并发延展绝不产生孤儿重复；
2. **死节点接管**：心跳失联节点的 `dispatching` 认领**立即**收回重派
   （不用等 120s TTL；fencing 保证卡顿未死节点的迟到结果按孤儿丢弃）；
3. **批量认领**：`ClaimTasksBatch` 在一个事务里读取候选
   （MySQL 上 `FOR UPDATE SKIP LOCKED`，并发实例读到互不相交的候选集）
   并整体翻转 `pending → dispatching`，每批铸造一个 fencing token；
   认领上限 = `min(batch_size, workers) × ceil(本机 weight ÷ 集群最大存活权重)`；
4. **并行派发**：每个已认领任务一个 goroutine，受两级闸门约束——
   全局池（`workers`，默认 16）+ 按 executor_url 的并发闸（`per_url_limit`，
   默认 8，坏掉的第三方执行器最多占自己的槽位）；池/闸饱和 → **释放认领**
   （`ReleaseClaim`，任务回 pending，下个 tick 再试，不算失败不计数）；
5. **finalize**：全部带 fencing（`WHERE status='dispatching' AND
   claim_token=本批 token`）并清空认领字段；执行结果写 `task_log` 溯源；
6. **超时兜底**：`running` 超 10 分钟无回调 → failed（迟到的回调幂等返回
   当前状态，不复活任务）。

### 3.1 为什么「同时读到」不会导致「同时执行」

- 普通 SELECT 是 MVCC 快照读，**读本身无锁、无副作用**——它只产生候选名单；
- 候选要变成执行，必须先通过认领 UPDATE；而 **UPDATE 是当前读**：InnoDB
  拿行锁、并按最新已提交版本复查 `WHERE status='pending'`——第一台改写
  状态后，第二台的 UPDATE 匹配 0 行，认领失败，任务不在它的执行集合里；
- 一句话：**读是匿名的候选提名，写才是唯一 counts 的动作**；
  系统里没有任何路径是「读到什么就执行什么」而不在写入瞬间重新验证的。

## 4. fencing token（认领栅栏）

每次认领铸造新 `claim_token`（uuid）。所有 finalize/release 都必须携带
token 且匹配当前认领才生效：

- **防陈旧持有者覆盖**：实例卡顿超过 dispatching TTL → 认领被回收重派 →
  旧持有者晚到的 finalize 匹配 0 行被拒，结果记
  `orphaned dispatch result discarded`（WARN）并丢弃——**状态转换恰好一次**；
- 副作用层面无法完全消除重复（旧持有者的执行器调用可能已在途）——这就是
  **执行器必须幂等**契约的由来：dispatch 携带 `X-Task-Id` 供执行器去重，
  app-pay 超时委托用 payload version 守卫。

邮件队列同一套模式：`pending → sending`（claim + token）→ sent/dry_run/failed，
`sending` 超 2 分钟回收重发（Resend 客户端内置 1 分钟超时 < 2 分钟窗口，
无悬空发送）。

## 5. 权重分摊（manager/worker 异构）

- 配置：`scheduler.weight`（默认 1；env `APPTASK__SCHEDULER__WEIGHT`）；
- 公式：`本 tick 认领上限 = min(batch_size, workers) × ceil(weight ÷ 集群最大存活权重)`；
- 权重经心跳写入名册（`cluster_node.weight`），是**集群动态感知**的：
  最大权重节点宕机 → 分母自动缩小 → 存活节点自动回满容量；
- 典型场景：4 台里 manager 设 1、worker 设 4 → manager 每 tick 只认领
  一个 worker 的 1/4；
- 边界：权重是**容量上限的相对缩放**（任务少时先到先得），不是严格公平
  队列——按流维度的严格公平是预留的 SCFQ 队列（`task.weight`，M4）的职责。

## 6. 加入节点（默认单节点 → ha → 扩容）

**默认部署 = 单节点**（compose 无 profile）；`--profile ha` 启动的第二实例
**预设为 manager（weight=1）**。

加入的唯一合法途径（两条入口，同一 API）：

| 入口 | 操作 | 认证 |
|------|------|------|
| Web 控制台「集群」页 | 「加入节点」表单（node_id/权重/主机名） | admin |
| CLI | `at node join --name worker-3 --weight 4` | admin 凭据 |

流程：

1. **预登记**：名册创建 `state=pending_join` 行（登记人/来源留痕；幂等刷新；
   已 active 的 node_id → 409）；
2. **生成指引**：API 即时返回可复制的 env 片段 + 启动/验证命令。
   ⚠ **RDBMS 连接串永不经 API 回显**——指引里是 `<SHARED_DB_URL>` 占位符，
   真实 DSN 走密钥分发渠道；
3. **接入转正**：新节点按指引启动（指向同一 MySQL），首次心跳自动
   `pending_join → active`（joined_via=auto/cli/web 溯源）；
4. **准入闸门（可选）**：`cluster.admission: pre_approved` 时，未预登记的
   节点**拒绝启动**（fail-closed）——防误配置/无序扩容。

> **威胁模型（务必读）**：节点加入的硬前提是持有共享 DB 凭据，而持有者本就
> 有全部读写权——预登记闸门防的是**误配置与无序扩容**（治理），不防持库
> 凭据的攻击者（那是 DB 凭据保管的职责）。join API/表单本身是 admin 门。

## 7. 共享状态与控制台

| 状态 | 默认（单实例） | 多实例 |
|------|--------------|--------|
| 控制台会话 | 进程内存 | `webui.session_store: redis` |
| API 密钥一次性展示 | 进程内存 | 同上（GETDEL 原子单读） |
| 每 IP 失败节流 / 每 key 限流 | 进程内存 | 同上（fail-open） |
| 调度态（任务/认领/名册） | MySQL | MySQL（天然共享） |
| Lua VM 池 / SCFQ 队列 | 每实例私有 | 无需共享 |

## 8. 安全模型：伪造节点能不能加入？（token / IP / 指纹）

把"伪造节点"分成两种威胁，控制手段完全不同：

### 8.1 威胁 A：没有 DB 凭据的伪造者 → 进不来（已保证）

加入集群的每一个动作（心跳写 `cluster_node`、认领改 `task`）都是对
app-task 自有 MySQL 的写入；没有 DSN 连名册都摸不到。暴露面也已收紧：
控制台/服务端口仅绑 127.0.0.1、MySQL 不出容器网络、服务面有 API key 门。

### 8.2 威胁 B：持有 DB 凭据的伪造者 → app 层校验全部无效，靠下沉

持有 DSN 的攻击者直接写库即可（改任务状态、插名册行），此时：

- **app 层 join token 校验 = 安全剧场**：校验逻辑读的是它可写的同一个库，
  它可以自己插入合法 token 行；
- **fencing 也拦不住**：fencing 约束的是遵守协议的诚实节点（卡顿/迟到），
  不约束无视协议直接写库者；
- 结论：对这类威胁，**认证必须发生在 app 进程之外**——即"谁能连上数据库"。

### 8.3 三层防线的正确归位

| 层 | 手段 | 防什么 | 状态 |
|----|------|--------|------|
| 治理层（app） | 预登记（admin）+ 留痕 + `pre_approved` 准入 | 误配置混入 / 无序扩容；审计"谁邀请的" | 已实现 |

**已实施的入册细节校验**（join API 与控制台表单共用）：

- **node_id 字符集**：`^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$` —— node_id 会流入
  slog 日志、task.owner、join 重定向，不受限的字符集意味着日志注入与
  下游解析隐患；
- **weight 上限**：1–1000（调度器侧再钳到 ≤10000）——极端权重会让加权
  算术溢出、把单 tick 认领上限撑爆；
- **名册可见性**：集群名册/`/api/cluster`/控制台「集群」页均为 **admin
  门**——主机名/版本/拓扑是内部信息，member 角色不可见（仪表盘小结卡
  同样仅 admin 渲染）。
| 网络层（IP） | MySQL 账号 host 限定 + 端口不出内网 | 连接级拒绝（握手都过不了） | runbook 见下 |
| 身份层（指纹） | MySQL `REQUIRE X509` + 每节点客户端证书 | 密码学节点身份：可吊销单节点、可审计来源 | 高安全部署可启用 |

**网络层加固 runbook**（最有效、零代码改动）：

```sql
-- 1. 账号绑定网段（不要 @'%'）：只有集群网段能认证
CREATE USER 'app_task'@'172.18.0.%' IDENTIFIED BY '<dsn密码>';
GRANT ALL ON app_task.* TO 'app_task'@'172.18.0.%';
-- 2. 需要更强身份时启用 X.509 客户端证书（每节点一张，可单独吊销）
-- ALTER USER 'app_task'@'172.18.0.%' REQUIRE X509;
-- app-task 侧 DSN 追加 &tls=true（并在 MySQL 侧配置 CA/证书校验）
```

配合 compose 网络隔离（MySQL 服务不声明公网 ports）即为完整闭环：
伪造者若不在可信网段内，连接被 MySQL 直接拒绝；若在网段内但没有凭据，
认证失败；若有凭据——它已是受信成员，问题转化为凭据保管与轮换（治理）。

**最小权限（既有防线）**：app-task 账号只授 `app_task` 一个库——即使凭据
泄露，污染范围被限制在调度域，不波及主栈数据。

**连接层加固（`rdbms.*`/`redis.*` 配置）**：MySQL 侧 `dial/read/write
timeout` 强制有界（驱动默认读/写无超时，hung DB 会冻结 worker）、`tls`
支持 true/skip-verify（配合 X509 方案）、`prepare_stmt` 预编译缓存、
`slow_threshold_ms` 慢查询日志；池默认 `max_open=25/max_idle=10` 匹配
worker 并发，`conn_max_lifetime/idle_time` 防长连接老化与中间件静默断连。
Redis 侧 `pool_size/min_idle_conns/超时/max_retries` 可配（rediss:// 走
TLS；超时保证 Redis 故障时限时失败，配合限流/节流 fail-open）。

**审计（既有防线）**：名册（node_id/hostname/invited_by/joined_via）+
task.owner + join API 留痕，任何节点"从哪来、谁邀请的、认领了什么"可溯源；
异常节点在仪表盘/`at node ls` 一眼可见。

### 8.4 各手段的明确定位（回答"token/IP/指纹用哪个"）

- **token**：只用于**邀请发起**的认证（admin 门，已实现）。节点侧的自证
  token 对威胁 B 无效，不再加码；
- **IP**：真实有效的连接级控制，放在 MySQL 层（见 8.3 runbook）；
- **指纹**：= mTLS 客户端证书，密码学级节点身份，高安全部署启用；
- **默认形态**：`open` 准入 + 内网隔离 + 网段账号 + 最小权限 + 留痕审计，
  对本系统的规模与威胁模型是充分且最简的。

## 9. 运维 runbook

**起双实例**：

```bash
# 根 compose（控制台 8001 + 8011；manager 预设 weight=1）
docker compose --profile ha up -d app-task app-task-ha
# 或独立 compose
cd app-task && docker compose --profile ha up -d --build
```

**验证加入**：`at node ls` 应看到两行 active，`at info` 显示 workers/inflight。

**验证故障接管**：`docker stop mind-base-app-task-ha` → 存活实例在其心跳
失联（~30s）后接管该节点认领；`at node ls` 显示失联 → `at ps` 确认任务
不中断。

**验证不重不漏**：双实例运行期间注册一批任务，`at logs` 确认每个任务只有
一条 dispatch 记录。

**扩容第四、五台**：控制台「集群」页或 `at node join` 预登记 → 新机器按
指引启动（同一 DB）→ `at node ls` 确认转正。

## 10. 配置参考

| 配置 | 默认 | 说明 |
|------|------|------|
| `scheduler.interval_seconds` | 30 | 轮询间隔 |
| `scheduler.workers` | 16 | 全局派发并发 |
| `scheduler.batch_size` | 50 | 每 tick 认领上限基数 |
| `scheduler.dispatching_timeout_seconds` | 120 | dispatching 认领回收时长 |
| `scheduler.per_url_limit` | 8 | 单 executor_url 并发闸 |
| `scheduler.weight` | 1 | 本节点派发份额 |
| `scheduler.instance_id` | hostname+rand | 节点身份（owner/名册共用） |
| `cluster.admission` | open | open \| pre_approved |
| `webui.session_store` | memory | memory \| redis（配 `redis.url`） |

## 11. FAQ

**Q：MySQL 宕机会怎样？**
全集群暂停（没有权威存储就没有调度）。这是刻意取舍：多主复制会引入真正的
分布式一致性难题。MySQL 侧建议用既有高可用手段（主从/InnoDB Cluster）。

**Q：两实例时钟不一致怎么办？**
认领 TTL 比较用实例本地时钟；120s TTL 对秒级时钟偏斜有约百倍裕度。k8s 依赖
NTP，与所有分布式系统相同。

**Q：任务会不会执行两次？**
状态转换恰好一次；执行副作用 at-least-once（绝不丢失、可能重复触发——仅
发生在回收重派场景）。执行器必须按 `X-Task-Id` 幂等。

**Q：谁都能加入吗？**
见 §6 威胁模型：加入硬前提是共享 DB 凭据；预登记（admin 发起）+ 可选
`pre_approved` 准入负责治理与防误配置。

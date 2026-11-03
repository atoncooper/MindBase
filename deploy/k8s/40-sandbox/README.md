# OpenSandbox — Kubernetes 部署（MindBase 沙箱运行时）

本目录负责 **OpenSandbox 控制面 + 沙箱工作负载** 的集群侧安装；MindBase 控制层
`app-sandbox` 仍由 `deploy/k8s/30-apps/app-sandbox.yaml` 部署。

```
app-ts ──APISIX /internal/sandbox/v1/*──► app-sandbox (ns mind-base, :8017)
                                              │ lifecycle REST (OPEN-SANDBOX-API-KEY)
                                              ▼
                            opensandbox-server (ns opensandbox-system, :80)
                                              │ BatchSandbox / Pool CRs
                                              ▼
                            opensandbox-controller ──► sandbox Pods (ns opensandbox)
                                              ▲
                    execd traffic ──► opensandbox-ingress-gateway (:80)
```

## 目录结构

```
deploy/k8s/40-sandbox/
├── install.sh                 # 安装/升级（profile、dry-run、smoke、policy）
├── preflight.sh               # 安装前只读检查
├── uninstall.sh               # 卸载（默认保留 CRD；--purge 才删）
├── values/
│   ├── opensandbox.yaml       # 公共 values
│   ├── opensandbox-dev.yaml   # 小集群/开发
│   └── opensandbox-prod.yaml  # 生产（HA gateway、metrics、反亲和、资源）
└── manifests/
    ├── 00-namespace.yaml
    ├── pool-python.yaml       # Python 热池
    ├── pdb.yaml               # server/gateway PDB
    ├── networkpolicy.yaml     # 可选：sandbox 平面网络策略
    ├── servicemonitor.yaml    # 可选：Prometheus Operator
    └── smoke-test-job.yaml    # 可选：经 app-sandbox 的真实执行冒烟
```

## 1. 前置要求与容量

| 项 | 要求 |
|---|---|
| K8s | ≥ 1.21，CoreDNS 正常（app-sandbox 用 `opensandbox-server.opensandbox-system.svc.cluster.local`） |
| 工具 | kubectl、Helm 3、git |
| 镜像 | `sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/*`（海外/私有仓库先转存） |
| app 镜像 | `atoncooper/mind-base-app-sandbox:latest`（`docker build -t ... app-go/app-sandbox`） |
| 存储 | 本目录全部 emptyDir，无需 StorageClass |
| 容量（prod） | server 1×(1cpu/2Gi)，gateway 3×(0.5cpu/0.5Gi)，controller 2×(0.2cpu/0.25Gi)，sandbox Pod 0.25cpu/0.25Gi（poolMax 10 → 预留 2.5cpu/2.5Gi） |

> 上游版本固定 **release-1.2.0**（`OPENSANDBOX_RELEASE` 可覆盖）。chart 不单独发包，
> 必须从 release tag checkout 后 `helm dependency build opensandbox`（脚本已处理）。

## 2. 安装

```bash
export OPENSANDBOX_API_KEY=$(openssl rand -hex 32)   # 与 app-sandbox 共用

bash deploy/k8s/40-sandbox/preflight.sh              # 只读检查
bash deploy/k8s/40-sandbox/install.sh                # prod profile
# 小集群：bash deploy/k8s/40-sandbox/install.sh --profile dev
# 只渲染：... --dry-run
# 加 NetworkPolicy / 端到端 smoke：... --with-policy --smoke
# 复用已有热池：... --skip-pool
```

脚本：建 namespace → 建 `opensandbox-api-key`（opensandbox-system 与 mind-base 各一份）
→ checkout release + `helm dependency build` → `helm upgrade --install --atomic --wait`
→ 等 server/controller Available → 校验 CRD → apply PDB/Pool（可选 policy）→ 打印状态。

官方安装顺序：**base（CRD+RBAC）→ controller → ingress-gateway → server**；
`fast-sandbox`（Firecracker）与 `node-agent` 默认关闭。

## 3. 配置与 Secret

- lifecycle API Key：脚本从 `OPENSANDBOX_API_KEY` 生成 Secret `opensandbox-api-key`；
  app-sandbox 通过 `SANDBOX__RUNTIME__OPENSANDBOX__API_KEY` 引用 **mind-base 命名空间的同名 Secret**；
- 生产建议用 External Secrets/Vault 管理，轮换 = 更新两个 namespace 的 Secret + 重启 server 与 app-sandbox；
- gateway route 签名（OSEP-0011）：跨集群暴露时在 server 与 gateway 同时配置
  `server.gateway.secureAccess.existingSecret` / `gateway.secureAccess.existingSecret`
  （Secret 含 `keys` 与 `active-key`）；
- lifecycle server 只走 ClusterIP，不对外暴露。

## 4. 热池（Pool）

`manifests/pool-python.yaml` 定义 `pool-python`（poolMin=1 / poolMax=10 / buffer 1..3）。
app-sandbox 通过 `runtime.opensandbox.poolRef=pool-python` 走热池分配（不再回传 image/entrypoint）；
留空则由 lifecycle 按 BatchSandbox 模板从镜像直建。

- 容量：改 `capacitySpec` 与 sandbox 容器 resources；poolMax 决定单集群最大并发 sandbox；
- 版本：`execd:release-1.2.0` 必须与 server `configToml` 的 `execd_image` 一致；
  `code-interpreter`/`task-executor` 使用对应 release tag（当前 v1.1.0 / v0.1.0）；
- poolMin ≥ 1 消除首个执行冷启动；poolMax 过小会导致创建排队。

## 5. 验证

```bash
kubectl -n opensandbox-system get deploy,pods
kubectl -n opensandbox get pool,pods

kubectl -n opensandbox-system port-forward svc/opensandbox-server 8080:80
curl -fsS http://127.0.0.1:8080/health

kubectl -n mind-base port-forward svc/app-sandbox 8017:8017
curl -fsS http://127.0.0.1:8017/health
curl -fsS http://127.0.0.1:8017/ready

# 端到端（真实创建/执行/回收；需要 mindbase-env.APISIX_CONSUMER_KEY）
bash deploy/k8s/40-sandbox/install.sh --skip-pool --smoke
kubectl -n mind-base logs job/sandbox-smoke
```

smoke 通过标准：`exitCode=0`、`stdoutPreview` 含 `42`、120s 内进入 terminal。

## 6. 监控与告警

- `manifests/servicemonitor.yaml`：app-sandbox `/metrics` + controller metrics
  （需 prod values 的 `controller.metrics.enabled=true`，PodMonitor 抓 metrics 端口）；
- 关键指标：`sandbox_executions_total{status}`、`sandbox_quota_denied_total{kind}`、
  `sandbox_sweeper_actions_total{reason}`、controller `controller_runtime_reconcile_*`；
- 建议告警：失败率 >10% 持续 10m、lease 操作失败 >0、pool available=0、server 5xx、gateway p99 >2s。

## 7. 升级 / 回滚 / 卸载

```bash
OPENSANDBOX_RELEASE=release-1.2.0 bash deploy/k8s/40-sandbox/install.sh

helm history opensandbox -n opensandbox-system
helm rollback opensandbox <REVISION> -n opensandbox-system --wait

bash deploy/k8s/40-sandbox/uninstall.sh            # 保留 CRD/Pool/namespace
bash deploy/k8s/40-sandbox/uninstall.sh --purge    # 彻底清理
```

> CRD 带 `helm.sh/resource-policy: keep`；跨大版本升级前先看上游 release notes 与
> `manifests/HELM-DEPLOYMENT.md`。

## 8. 安全

- lifecycle server / gateway 仅 ClusterIP；API Key 只在 Secret，不下发浏览器；
- 建议 apply `manifests/networkpolicy.yaml`：仅 `mind-base/app-sandbox` 访问 server:80 与
  gateway:28888，仅 gateway 访问 sandbox Pod 的 execd:44772；
- sandbox 隔离依赖 runtime + 镜像白名单 + egress 策略；生产建议启用 gVisor/Kata
  （上游 `[secure_runtime]`）与 egress sidecar；
- 控制面 Pod 非 root、drop ALL；sandbox Pod 由 Pool 模板控制；
- app-sandbox `/internal/admin/*` 不经 APISIX（网关只放行 `/internal/sandbox/v1/*`）。

## 9. 已知限制

- lifecycle server 默认单副本，上游不支持通用多副本 HA；升级 Recreate 会短暂中断 API；
- ingress-gateway 在 K8s 必需（sandbox Pod 仅 ClusterIP）；
- app-sandbox 单副本（进程内幂等缓存 + 单 sweeper），扩副本前需 leader election/幂等落库；
- 不含 fast-sandbox（Firecracker）与 node-agent，需要时按上游 HELM-DEPLOYMENT.md 开启；
- MinIO 产物收集尚未接入（仍用 Fake artifact store），presigned URL 暂不可用；
- 首次安装的镜像 tag / 私有仓库需按环境验证。

## 10. 故障排查

| 现象 | 排查 |
|---|---|
| app-sandbox init 卡住 | `kubectl -n opensandbox-system get svc opensandbox-server`；确认 Service 名/端口 |
| server 起不来（API key） | 检查 `opensandbox-api-key` 是否存在且 `server.env` 引用 key=api-key |
| pool 一直 Pending | 节点资源不足/镜像拉取失败；`kubectl -n opensandbox describe pod` |
| 创建成功但 execd 连不上 | 检查 gateway Service、NetworkPolicy、`server.gateway.host` 与 route mode |
| app-sandbox 502/超时 | 看 app-sandbox 与 lifecycle 日志；确认 API Key 一致、gateway 可达 |
| smoke exitCode!=0 | 看 sandbox Pod/execd 日志；确认 pool 模板 execd 版本与 server 配置一致 |

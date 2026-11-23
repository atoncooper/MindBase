# TLS / 内部服务加密（已完成）

> 状态：**阶段一（网关/身份/MCP/任务/支付链路）+ 阶段二（应用自身 TLS 监听）+ 阶段三（数据层 TLS/mTLS）均已上线并验证**（2026-11-15）。
> 例外清单见 §6（app-task→app-task-mysql、APISIX 上游不校验身份、Milvus REST 关闭、deploy/docker 拆分部署待同步）。

## 1. 证书体系（仓库根 secrets/certs/，整体 gitignored；app-pay 例外）

    secrets/certs/
    ├── openresty/{dev-ca.crt,dev-ca.key,dev-ca.srl,fullchain.pem,privkey.pem}
    │     └─ 共享开发 CA（根锚点）+ 浏览器入口叶子
    ├── ca-bundle.crt            # 系统公共 CA + dev CA（容器统一信任 bundle）
    ├── <service>/               # 每个服务/数据面一份叶子
    │   ├── dev-ca.crt
    │   ├── server.crt
    │   └── server.key
    └── {apisix,app-user,app-ts,app-cloud,app-admin,app-kg,frontend,sandbox,
         higress,minio,mysql,mongo,redis,milvus,neo4j,etcd}/

- 由 scripts/gen-certs.sh 统一签发（compose cert-gen 一次性容器，幂等/自动续期）；scripts/certgen.Dockerfile 增加 ca-certificates 以生成信任 bundle。
- 所有叶子共用一份 CA，**SAN 覆盖全部服务/数据面别名**（app-user、apisix、mysql、mongo、milvus、**etcd**…），任何客户端都能按 compose DNS 名校验证书。
- **叶子 EKU = serverAuth,clientAuth**：同一批叶子既做服务端证书，也用于 mTLS 客户端身份（etcd --client-cert-auth 需要 clientAuth，否则报 x509: certificate specifies an incompatible key usage）。
- app-pay 例外：叶子仍在 app-pay/certs/（PAY_TLS_CERT/KEY 相对路径契约）。
- 信任注入：
  - Go 服务：挂载 ca-bundle.crt 覆盖 /etc/ssl/certs/ca-certificates.crt，SSL_CERT_FILE 指向它；
  - Node（app-ts）：同上挂载 + NODE_EXTRA_CA_CERTS；Milvus SDK 另外显式传 tls.rootCertPath；
  - Java（app-pay）：一次性 cert-truststore 容器用 keytool 生成 app-pay/certs/truststore.p12（PKCS12, changeit），**先导入 JRE 默认 cacerts（公网 CA，支付宝/微信等出站必需），再追加内部 dev CA**，经 JAVA_TOOL_OPTIONS 注入；只导入内部 CA 会导致 PKIX path building failed；
  - OpenResty：proxy_ssl_verify on + proxy_ssl_trusted_certificate /etc/openresty/certs/dev-ca.crt。

## 2. 最终加密矩阵

### 2.1 边缘 / 网关

| 链路 | 状态 | 校验 |
|---|---|---|
| 浏览器 → OpenResty:443 | **HTTPS** | dev CA（浏览器需信任一次） |
| OpenResty → APISIX:9443 | **HTTPS** | OpenResty 真校验（dev CA；upstream 静态块 keepalive+重试） |
| OpenResty → frontend:8443 / sandbox:8443 / higress:9443 | **HTTPS** | 同 netns OpenResty stream TLS 前置（镜像不自带 TLS），edge 真校验 |
| OpenResty → app-cloud:8007(公开分享) / minio:9000 | **HTTPS** | edge 真校验（minio 预览走 proxy_ssl_verify off，预签名/自签场景）；app-user/app-admin-api 现在只由 APISIX 访问 |
| APISIX → app-user / app-content / app-pay / app-task / app-ts / app-cloud / app-sandbox | **HTTPS** | 仅加密；APISIX 3.20 已支持 `upstream.tls.verify`（3.19+），当前未挂内部 CA，故仍不校验证书 |
| APISIX forward-auth → app-user | **HTTPS** | 同上 |
| 管理台 UI(3001) → app-admin-api:8016 | **HTTPS** | nginx(admin UI 镜像) 真校验（dev CA + `proxy_ssl_name app-admin`；入口 3001 仅回环/SSH 隧道） |
| APISIX 自身 TLS | 9443 监听 + 声明式 ssls（render-config.sh 注入 PEM，SNI 覆盖 apisix/mindbase/localhost） | — |

### 2.2 服务 ↔ 服务（应用自身 TLS 监听）

| 服务 | 监听 | 出站 |
|---|---|---|
| app-user | 8006/8010/8015 **HTTPS**（TLS__CERT_FILE/KEY_FILE） | MySQL TLS、Mongo TLS、Redis rediss://、MinIO https、APISIX https |
| app-content | 8004 **HTTPS**（原有） | MySQL TLS |
| app-cloud | 8007 **HTTPS**（server.tls + ListenAndServeTLS） | MySQL TLS、Mongo TLS、Redis rediss://、MinIO https、APISIX https |
| app-kg | gRPC 8013 **TLS** + HTTP 8014 **HTTPS** | MySQL TLS、Neo4j **bolt+s** |
| app-admin-api | 8016 **HTTPS**（server.tls） | MySQL TLS（主库 MYSQL_TLS_MODE；支付库同） |
| app-ts | 8000 **HTTPS**（Fastify server.tls） | app-user / app-content-mcp / APISIX / app-pay / app-quiz / app-task / 沙箱 **HTTPS + dev CA**；app-kg gRPC **TLS**；Mongo TLS；Redis rediss://；MinIO https；**Milvus gRPC TLS**（MILVUS__SSL=true + /app/certs/dev-ca.crt） |
| app-pay | 8002 **HTTPS**（PEM，app-pay/certs） | app_pay MySQL **sslMode=REQUIRED**；APISIX https（PKCS12 truststore） |
| app-task | 8001 **HTTPS**（镜像自生成自签 certs/auto.crt） | APISIX https（APPTASK__APP__BASE_URL=https://apisix:9443）；app-pay 超时回调 https（CA 校验）；**app_task MySQL 明文（例外，见 §6）** |
| app-content-mcp | 8019 **HTTPS**（CONTENTMCP__SERVER__TLS__ENABLED=true） | APISIX（key-auth internal 路由）https |
| app-sandbox / frontend / higress | 容器内仍明文，由同 netns OpenResty stream 前置终结 TLS（8443/8443/9443） | — |
| frontend SSR → OpenResty:443 | **HTTPS**（INTERNAL_API_URL=https://openresty:443 + NODE_EXTRA_CA_CERTS；旧镜像的 `http://nginx:80` 由网络 alias 兜底） | 真校验 |

### 2.3 数据层

| 组件 | 服务端 | 客户端 |
|---|---|---|
| MySQL（mind_base / app_pay） | --require-secure-transport=ON（8.4 自动证书，非 dev CA） | Go 各服务 DSN 追加 &tls=skip-verify（MYSQL_TLS_MODE，compose 注入）；app-pay JDBC sslMode=REQUIRED&useSSL=true&requireSSL=true（CLI 覆盖，镜像未重建） |
| app-task-mysql | 8.4 自动证书（可用） | **明文**（外部镜像 DSN 不透传 tls=，见 §6） |
| MongoDB | --tlsMode requireTLS --tlsCertificateKeyFile /tls/server.pem --tlsCAFile /tls/ca.crt --tlsAllowConnectionsWithoutCertificates（secrets/certs/mongo） | .env MONGO__URI 追加 &tls=true（Go / app-ts 全部） |
| Redis | --tls-port 6379 + --port 6380（legacy 明文仅给 MinIO bucket notify）；dev CA 证书 | 业务客户端一律 rediss://（CA 走 ca-bundle） |
| MinIO | /root/.minio/certs/{public.crt,private.key}（dev CA 叶子，SAN 含 minio） | OpenResty / app-ts / app-cloud / app-sandbox / Milvus 全部 https |
| Milvus | proxy gRPC **TLS**（tls.serverPemPath=/certs/server.crt，common.security.tlsMode=1）；REST 关闭；etcd **mTLS**；MinIO https | app-ts SDK ssl:true + tls.rootCertPath=/app/certs/dev-ca.crt + serverName=milvus（统一工厂 src/clients/milvus-client.ts，chunk store 与 KG entity index 共用） |
| Neo4j | Bolt **TLS required**（NEO4J_dbms_ssl_policy_bolt_* + NEO4J_server_bolt_tls__level=REQUIRED，secrets/certs/neo4j/bolt） | app-kg KG__URI=bolt+s://neo4j:7687（CA 走 ca-bundle） |
| etcd | **mTLS**（--cert-file/--key-file/--trusted-ca-file/--client-cert-auth，secrets/certs/etcd） | Milvus etcd.ssl.{enabled,tlsCert,tlsKey,tlsCACert}（/etcd-certs/*）；APISIX traditional+etcd 用 **mTLS**（k8s 例外：与 Milvus 共享集群内 plain etcd） |

## 3. 已验证（2026-11-15，真实请求）

    # 边缘（Windows 本机 curl 走 schannel，需要 --ssl-no-revoke）
    curl -s -6 --ssl-no-revoke --cacert secrets/certs/openresty/dev-ca.crt \
      -H 'Authorization: Bearer <token>' -H 'X-Requested-With: XMLHttpRequest' \
      https://localhost/account          # 200（Next.js 页面 SSR 正常）
    curl ... https://localhost/auth/me   # 200 {"uid":...,"nickname":"AtonCooper",...}
    # /pay/membership /pay/products /quota/summary /chat/sessions /notes /task-quiz
    # /cloud/folders /cloud/videos /blindspot 均为 200

- **MySQL**：SHOW GLOBAL STATUS LIKE 'Ssl_accepts' = 28（mind_base）/ 23（app_pay）→ 客户端确实走 TLS。
- **Redis**：redis-cli --tls --cacert /certs/dev-ca.crt -p 6379 ping → PONG。
- **Mongo**：mongosh --tls ... --eval 'db.adminCommand({ping:1})' → { ok: 1 }。
- **Milvus**：容器外 TLS 握手 CN=milvus；app-ts 日志 [RAG] initialized ... cloud_drive(ok) + [KG_INDEX] ready collection=kg_entities；Milvus 日志 useSSL=true、Proxy listen on external grpc listener、Milvus Proxy successfully initialized。
- **etcd**：healthcheck healthy（etcdctl --cacert/--cert/--key），Milvus 以 mTLS 连接成功。
- **Neo4j**：app-kg [NEO4J] constraints ensured（bolt+s）。
- **app-pay**：[PAY] env_summary ... rdbms=jdbc:mysql://app-pay-mysql:3306/app_pay?sslMode=REQUIRED...。
- **app-ts**：MCP 12 工具 kind=ok、board 5/5 注册、[BOOT] listening on https://0.0.0.0:8000。

## 4. 关键实现要点 / 坑

1. **APISIX 3.20**：ssl.listen 里 enable_http2 已废弃（去掉）；9443 证书必须由声明式 `ssls` 按 SNI 提供（`apisix/render-config.sh` 注入 PEM，证书缺失时删掉整块）；`apisix.ssl.cert/key` 不参与该 listener（CLI 固定使用 `cert/ssl_PLACE_HOLDER.crt` 占位，已在 3.11→3.20 升级时删除这两个死配置）。
2. **Milvus TLS 与 REST 冲突**：proxy HTTP 监听与外部 gRPC 共用 19530 时 Milvus 要求 tlsMode=0，否则报 proxy server(http) and external grpc server share the same port, tls mode must be 0；因此 proxy.http.enabled: false（本栈不用 Milvus REST）。
3. **Milvus 配置必须完整**：`deploy/config/milvus/milvus.yaml` 是镜像默认配置的**完整副本**（只改 minio/TLS/etcd 几行），由根 compose 挂载到 `/milvus/configs/milvus.yaml`；`deploy/k8s/20-data/milvus.yaml` 是 K8s StatefulSet 清单（kustomize resource），两者不是同一类文件，不要把服务端配置塞进 k8s 清单目录。曾用被截断的半份文件挂载 → 启动 30s 后 panic: context canceled / proxy 端口 bind 失败（极难定位），损坏时直接重新从镜像拷默认配置再改。
4. **Milvus 客户端统一入口**：src/clients/milvus-client.ts 的 createMilvusClient() 是进程内唯一 MilvusClient 工厂（chunk store + KG entity index 共用），避免两处 TLS/SNI 漂移。
5. **etcd mTLS**：etcd 客户端证书需要 clientAuth EKU；SAN 必须含 etcd（Milvus 用 endpoint 主机名做 serverName）。旧叶子删除后重签（gen-certs.sh 的 alias 刷新只认 app-ts，删目录最稳）。
6. **Redis 双端口**：MinIO bucket notify 不支持 rediss://（too many colons in address），所以保留 6380 明文仅供 MinIO；业务客户端全部 rediss://。
7. **MySQL/Mongo 证书**：官方镜像自动证书与 dev CA 不同 → 客户端用 skip-verify / tlsInsecure（加密但不钉 CA）；dev CA 签发的（Milvus/etcd/MinIO/Neo4j/服务间）走真实 CA 校验。
8. **Windows curl**：本机 curl 是 schannel 后端，--cacert 之外必须加 --ssl-no-revoke（否则 schannel: the revocation status is unknown），localhost 解析到 ::1 时用 -6。

8. **APISIX 配置源 / Admin（3.20）**：配置迁到 etcd（traditional），路由/上游/消费者/SSL 由内嵌 Dashboard 或 Admin API 管理；Admin 仅 HTTPS（`https_admin` + apisix leaf），宿主端口写死在 compose 字面量（默认回环），来源 IP 由 config 的 `allow_admin` 限制（Docker 发布端口下 APISIX 看到的是 Docker 网关 IP，真正的客户端 IP 限制由宿主绑定/防火墙承担）。compose/deploy 栈的 APISIX→etcd 走 mTLS（`deployment.etcd.tls` + 共享 dev CA）；k8s 因 Milvus 共用同一 etcd，暂保持集群内 plain HTTP，后续与 Milvus TLS 一起收紧。

## 5. 维护 / 轮换

    docker compose run --rm --no-deps cert-gen all        # 幂等：有效复用、临期重签
    docker compose run --rm --no-deps cert-gen services   # 只重签服务叶子（CA 必须在）
    MB_CERT_FORCE=1 ... cert-gen all                      # 强制全量重签

- 叶子默认 825 天、剩余 ROTATE_WITHIN_DAYS 内自动重签；重签后重启对应容器（服务启动时读证书）。
- 新增服务：在 gen-certs.sh 的 service 列表与 SAN alias 列表各加一行 → 重跑 services → 挂载 secrets/certs/<name> + 设置对应 TLS env。
- 生产替换正式 CA：MB_CERT_KEEP=1 + 外部证书（保持挂载路径契约不变）。

## 6. 例外与待办

| 项 | 现状 | 原因 / 后续 |
|---|---|---|
| app-task → app-task-mysql | **明文** | app-task 是外部镜像（独立仓库），其 DSN 转换不透传 tls= 参数（实测加 ?tls=skip-verify 后 Ssl_accepts 仍为 0）。同一私有 docker 网络内；需要时在上游仓库给 GORM MySQL DSN 加 TLS 支持后再开。 |
| APISIX → 上游 | 只加密不校验证书 | APISIX 3.20 已支持 `tls.verify`/`tls.ca_certs`；当前未挂内部 CA，换正式 CA 后可逐 upstream 打开，或在 OpenResty→APISIX 侧保持真校验。 |
| Milvus REST API | 关闭（proxy.http.enabled=false） | TLS 模式下 http/grpc 不能共用 19530；本栈只用 gRPC SDK，无 REST 调用方。 |
| 管理台 UI 入口 | 127.0.0.1:3001 明文（仅回环/SSH 隧道） | 静态 SPA + `/api` 反代；`/api` 到 app-admin-api 已是 https 且真校验，302/登录 cookie 在回环内。要全链路 https 可再给 admin UI nginx 加 8443 TLS 监听（非必需）。 |
| app-task 服务端证书 | 镜像自签（certs/auto.crt） | 外部镜像自带自动证书，APISIX 不校验上游 → 可工作；如需纳入 dev CA，可挂载 APPTASK__SERVER__TLS__CERT/KEY 指向 dev CA 叶子。 |
| deploy/k8s（K8s 清单） | 数据层 `20-data/*` 仍明文（Milvus/MinIO/etcd/Redis/Mongo 未挂证书 ConfigMap/Secret），应用侧 `30-apps` 已部分同步 | 需要给 20-data 各 StatefulSet 增加 cert Secret 挂载 + TLS 参数、给 Milvus 增加 `milvus-config.yaml` 的 ConfigMap（当前 StatefulSet 只用 env，不挂服务端配置）；单机 compose 是已验证路径。 |
| deploy/docker（两机 overlay 拆分部署） | **未同步本轮 TLS**（该目录在阶段一就已落后主线） | 拆分部署按服务单文件，需要在 11-etcd / 12-minio / 20-redis / 21-mongo / 22-neo4j / 23-milvus / 30-* / 34~35 / 38 / 41 / 42 / 43 各文件补齐 secrets/certs 挂载、TLS env、healthcheck；当前仅根 docker-compose.yml 是验证过的部署路径。 |
| secrets/certs 目录 | 整体 gitignored | 新 clone 后第一次 docker compose up 由 cert-gen 自动生成。 |

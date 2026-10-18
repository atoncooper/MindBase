# deploy/docker — 两机分离部署（每服务一份 compose）

> 每个服务一个独立 compose 文件（独立 project，可单独 up/down/看日志），全部挂同一张
> **attachable overlay 网络 mind-base-overlay**——server1 与 server2 上的容器按服务名互通
> （compose 自动把服务名注册为 overlay DNS alias），nginx 的 resolver 与 apisix 的
> upstream 无需任何改动。每个文件顶部 name 不同，down 互不影响。

## 一、机器分工

| 机器 | 文件 | 说明 |
|---|---|---|
| **server1**（manager，边缘层） | 00-certs / 10-frontend / 11-etcd / 12-minio / 13-apisix / 14-nginx | TLS 入口、网关、前端、对象存储 |
| **server2**（worker，数据+后端） | 20-redis / 21-mongo / 22-neo4j / 23-milvus / 24-app-task-mysql / 25-app-pay-mysql / 30~37(app-go) / 38~40(MCP) / 41-app-task / 42-app-pay / 43-app-ts | 数据层 + 全部业务后端 |
| 可选 | 90-higress / 95-app-pay-admin | .env 已指向外部 AI 网关就不用起 higress；pay-admin 用 SSH 隧道访问 |

> 主库 mind_base 用外部 MySQL（.env 的 RDBMS__URL），两份文件里都不含主 mysql；
> app-task / app-pay 的两个专用小库（app_task / app_pay，表自动建）默认随 server2 起。

## 二、前置条件

1. swarm：server1 manager、server2 worker 已互 join（docker node ls 两行）
2. overlay：server1 上 docker network create -d overlay --attachable mind-base-overlay（已建）
3. 安全组两台之间放行：**2377/tcp、7946/tcp+udp、4789/udp**；外部 MySQL 对两台放行 3306
4. 两台都能看到该网络：docker network ls | grep mind-base-overlay
5. 本目录在仓库内：<repo>/deploy/docker/（文件里的 ../../ 相对路径依赖这个位置）

## 三、server1 部署

```bash
cd /MindBase && git pull        # 或 scp -r deploy/ 到服务器
cd deploy/docker
docker volume ls | grep -E 'minio|etcd'   # 确认旧数据卷名（默认 mindbase_minio_data / mindbase_etcd_data）
#   若名字不同：改 11-etcd.yml / 12-minio.yml / 14-nginx.yml 里 volumes 的 external name

# .env 里建议配置（证书 SAN 覆盖你的访问地址）：
#   MB_CERT_HOST=你的域名或公网IP
#   MB_CERT_EXTRA_SAN=额外域名,公网IP     （可选）
bash start-frontend.sh
```

旧栈迁移：先 cd /MindBase && docker compose down（数据卷保留），再跑上面的脚本。
etcd/minio/certbot/nginx 缓存卷通过 external name 复用旧数据，**不要 down -v**。

## 四、server2 部署

从 server1 拷贝（不需要完整仓库，但要保持下面的目录结构）：

```bash
# server2 上：<repo>/deploy/docker/ 放本目录全部文件
scp -r manager:/MindBase/.env                    <repo>/
scp -r manager:/MindBase/secrets                 <repo>/
scp -r manager:/MindBase/app-pay/certs           <repo>/app-pay/
scp -r manager:/MindBase/app-board/certs         <repo>/app-board/
scp -r manager:/MindBase/mcp/app-board-mcp/certs <repo>/mcp/app-board-mcp/   # 可选
scp -r manager:/MindBase/data/higress            <repo>/data/                 # 本机 higress 时
```

.env 必须包含：RDBMS__URL（外部主库）、APISIX_CONSUMER_KEY（与 server1 apisix.yaml 一致）、
AI_GATEWAY__API_KEY / AI_GATEWAY__BASE_URL、REDIS_PASSWORD / MONGO_* / MINIO_* /
NEO4J_PASSWORD（与 server1 同值）、PAY_MYSQL_* / APPTASK_MYSQL_*。

```bash
cd <repo>/deploy/docker
bash start-backend.sh
```

## 五、单服务启停（模板）

```bash
cd <repo>/deploy/docker
docker compose --env-file ../../.env -f 31-app-bili.yml up -d app-bili     # 启动
docker compose --env-file ../../.env -f 31-app-bili.yml down               # 停止并删除容器
docker compose --env-file ../../.env -f 31-app-bili.yml logs -f app-bili   # 日志
docker compose --env-file ../../.env -f 13-apisix.yml up -d --force-recreate apisix  # 改配置后重建
```

## 六、证书（关于浏览器警告，必须说清楚）

- Subject 已是完整字段：C=CN / ST=Sichuan / L=Chengdu / O=MindBase / OU=MindBase Platform；
  CA 的 CN=MindBase Root CA，叶子的 CN=访问主机名（MB_CERT_HOST）。
- SAN 覆盖：MB_CERT_HOST（域名或 IP）+ localhost / 127.0.0.1 / ::1 / app-pay / app-pay-test + MB_CERT_EXTRA_SAN。
- **Subject 填得再完整也不会消除自签证书的浏览器警告**——警告来自信任链，不是字段缺失。
  消除警告的两条正路：
  1. 导入信任：把 nginx/certs/dev-ca.crt 导入访问端的
     Windows：certmgr.msc → 受信任的根证书颁发机构；macOS：钥匙串→系统→始终信任；
     Firefox 有独立证书库（设置→隐私与安全→证书→导入）。
     之后 https://<MB_CERT_HOST> 全绿；curl 加 --cacert nginx/certs/dev-ca.crt。
  2. 真 CA（推荐，有 mindbase.top 后所有人零警告）：
     ```bash
     # 前提：DNS A 记录 mindbase.top -> server1 公网IP；80/443 对公网开放
     mkdir -p /MindBase/data/letsencrypt
     docker run --rm -v mindbase_certbot_www:/var/www/certbot \
       -v /MindBase/data/letsencrypt:/etc/letsencrypt certbot/certbot \
       certonly --webroot -w /var/www/certbot -d mindbase.top \
       --email you@example.com --agree-tos --no-eff-email
     cp /MindBase/data/letsencrypt/live/mindbase.top/{fullchain,privkey}.pem /MindBase/nginx/certs/ 2>/dev/null || \
       (cp /MindBase/data/letsencrypt/live/mindbase.top/fullchain.pem /MindBase/nginx/certs/ && \
        cp /MindBase/data/letsencrypt/live/mindbase.top/privkey.pem /MindBase/nginx/certs/)
     chmod 600 /MindBase/nginx/certs/privkey.pem
     # .env 设 MB_CERT_KEEP=1（cert-gen 不再覆盖真证书），然后
     docker compose --env-file ../../.env -f 14-nginx.yml restart nginx
     # 续期（90 天，放 crontab）：
     # 0 3 * * 1 docker run --rm -v mindbase_certbot_www:/var/www/certbot -v /MindBase/data/letsencrypt:/etc/letsencrypt certbot/certbot renew --webroot -w /var/www/certbot && cp /MindBase/data/letsencrypt/live/mindbase.top/*.pem /MindBase/nginx/certs/ && docker exec mind-base-nginx nginx -s reload
     ```
- 重新生成：改 MB_CERT_HOST/EXTRA_SAN 后重跑 docker compose --env-file ../../.env -f 00-certs.yml up cert-gen
  （相关叶子自动按新 SAN 重签）；全量重签 MB_CERT_FORCE=1。
- server2 的 app-pay/app-board 必须用 server1 拷来的**同一套**证书（apisix 信任的就是这套 dev-CA）。

## 七、验证

```bash
# server2 → server1 按名解析
docker run --rm --network mind-base-overlay busybox ping -c2 minio
# server1 → server2
docker exec mind-base-apisix getent hosts app-auth
# 健康面
docker exec mind-base-app-ts wget -qO- http://127.0.0.1:8000/health
# 端到端：浏览器 https://<MB_CERT_HOST> 登录 + 聊天；docker logs -f mind-base-apisix
```

## 八、排障

| 症状 | 检查 |
|---|---|
| 跨机 ping 不通 | 安全组 4789/udp（overlay 数据面）、7946/tcp+udp、2377/tcp |
| server2 起容器报 network not found | server2 未加入 swarm 或 overlay 没建 |
| apisix 502 | 对应后端容器没起/不健康：getent hosts <服务名> |
| app-pay 拒启 | ../../app-pay/certs 缺失（未从 server1 拷） |
| app-board TLS 握手失败 | server2 的 app-board/certs 不是 server1 那套 dev-CA |
| minio 事件不触发向量化 | redis 密码不一致；docker restart mind-base-minio |
| 镜像拉取失败 | server2 无本地镜像且 Hub 不可达：docker pull 手动补 |

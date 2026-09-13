# Production Deployment

This guide covers deploying MindBase in production — with HTTPS, monitoring, and high availability.

> 服务/端口/路由全表见 [architecture.md](architecture.md)。

---

## Architecture

```
                     Browser
                        │
                        ▼
              ┌──────────────────┐
              │   nginx :80/:443 │  ← TLS termination + SPA 分发 + 缓存
              └────────┬─────────┘
                       │ API 前缀
                       ▼
              ┌──────────────────┐
              │  APISIX :9080    │  ← 鉴权（forward-auth → X-Uid / key-auth）+ 路由
              └──┬─────┬─────┬───┘
                 ▼     ▼     ▼
        ┌─────────┐ ┌─────────┐ ┌─────────────┐ ┌──────────────┐
        │ backend │ │app-task │ │ app-pay     │ │ app-board    │
        │  :8000  │ │ :8001   │ │ :8002(https)│ │ :8004(https) │
        └────┬────┘ └────┬────┘ └──────┬──────┘ └──────┬───────┘
             │           │             │               │
   ┌─────────┼───────────┼─────────────┴───────────────┘
   ▼         ▼           ▼
┌────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────┐ ┌───────┐ ┌─────────┐
│ MySQL  │ │  Redis  │ │  Milvus  │ │ MongoDB  │ │ Neo4j │ │ MinIO │ │ 独立MySQL │
└────────┘ └─────────┘ └──────────┘ └──────────┘ └───────┘ └───────┘ └─────────┘
 mind_base   缓存/限流    向量库        正文/题目      知识图谱   文件存储   app_task/app_pay
```

---

## Prerequisites

- A Linux server (Ubuntu 22.04+ / Debian 12+)
- Docker 24+ with Compose v2 plugin
- A domain name pointing to your server
- (Optional) A K8s cluster

---

## Step-by-step deployment

### 1. Clone & configure

```bash
git clone <repo-url> /opt/mind-base
cd /opt/mind-base
```

### 2. Secrets

Generate the required secrets:

```bash
# Session signing key
python -c "import secrets; print(secrets.token_urlsafe(48))"

# API key encryption key (DO NOT change after first deploy)
python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"
```

Create `.env` (also generate `APISIX_CONSUMER_KEY` with the same `token_urlsafe(32)` command — required for service-to-service auth):

```env
LLM__API_KEY=sk-your-production-key
SESSION__SECRET=<output-from-above>
SECURITY__API_KEY_ENCRYPTION_KEY=<output-from-above>
APISIX_CONSUMER_KEY=<output-from-above>
RDBMS__URL=mysql+aiomysql://mind_base:strongpassword@mysql:3306/mind_base
MONGO__URI=mongodb://admin:strongpassword@mongo:27017/?authSource=admin
REDIS__URL=redis://:strongpassword@redis:6379/1
NEO4J_PASSWORD=strongpassword          # 与 compose 的 neo4j 服务共享

# LangSmith (optional)
LANGSMITH_API_KEY=lsv2_pt_xxx
```

### 3. Production config

Create `app/config/config.yaml`:

```yaml
app:
  debug: false
  log_level: WARNING

server:
  workers: 8
  reload: false
  proxy_headers: true

rdbms:
  echo: false
  pool_size: 50
  max_overflow: 30

mongo:
  enabled: true

redis:
  enabled: true

ratelimit:
  chat_per_minute: 30
  asr_per_hour: 50

langsmith:
  enabled: false
```

### 4. Start

```bash
docker compose up -d          # 默认 profile = 全栈（含 nginx/APISIX/Milvus/Neo4j/app-task/app-board）
```

Optional add-ons: `--profile pay`（交易/会员）、`--profile pay-admin`（支付后台）、`--profile full`（全部）。各服务的部署与配置见 [app-pay.md](app-pay.md) / [app-pay-admin.md](app-pay-admin.md) / [app-board.md](app-board.md) / [app-task.md](app-task.md)。

### Daytona code sandbox (optional, for code agent)

```bash
docker compose -f docker-compose.daytona.yml up -d
```

Configure in backend `.env`: `DAYTONA__ENABLED=true`, `DAYTONA__API_URL=http://daytona:3000`, `DAYTONA__API_KEY=<key>`.

### 5. Verify

```bash
curl http://localhost:8000/health      # backend（直连）
curl http://localhost/health           # 经 nginx → APISIX 的完整链路
curl http://localhost:8001/health      # app-task
# 返回 {"status": "healthy"} 即正常；/health 携带 agent_harness 状态

curl http://localhost:3000             # HTML response（或直接走 nginx 80/443）
```

> 生产入口建议统一走 nginx（80/443）。compose 中 APISIX/app-board/app-pay 仅容器网络或回环可达，不直接对公网暴露。

---

## HTTPS with Caddy (recommended)

Caddy auto-provisions Let's Encrypt certificates. Create `/etc/caddy/Caddyfile`:

```
your-domain.com {
    reverse_proxy /api/* localhost:8000
    reverse_proxy /health localhost:8000
    reverse_proxy /vec/* localhost:8000
    reverse_proxy /asr/* localhost:8000
    reverse_proxy /auth/* localhost:8000
    reverse_proxy /wallpaper/* localhost:8000
    reverse_proxy /preferences/* localhost:8000
    reverse_proxy localhost:3000
}
```

```bash
sudo apt install caddy
sudo systemctl enable --now caddy
```

## HTTPS with Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend API
    location /api/ {
        rewrite ^/api/(.*) /$1 break;
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check
    location /health {
        proxy_pass http://127.0.0.1:8000;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## K8s Deployment

### Sample Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mind-base-backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mind-base-backend
  template:
    metadata:
      labels:
        app: mind-base-backend
    spec:
      containers:
        - name: backend
          image: your-registry/mind-base-backend:latest
          ports:
            - containerPort: 8000
          envFrom:
            - secretRef:
                name: mind-base-secrets
          env:
            - name: APP_LOG_LEVEL
              value: "WARNING"
            - name: RDBMS__URL
              value: "mysql+aiomysql://mind_base:$(MYSQL_PASSWORD)@mysql-svc:3306/mind_base"
          resources:
            limits:
              memory: "4Gi"
              cpu: "2"
            requests:
              memory: "1Gi"
              cpu: "0.5"
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 30
            periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: mind-base-backend-svc
spec:
  selector:
    app: mind-base-backend
  ports:
    - port: 8000
      targetPort: 8000
```

### Secrets

```bash
kubectl create secret generic mind-base-secrets \
  --from-literal=LLM__API_KEY=sk-xxx \
  --from-literal=SESSION__SECRET=$(python -c "import secrets; print(secrets.token_urlsafe(48))") \
  --from-literal=SECURITY__API_KEY_ENCRYPTION_KEY=$(python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())")
```

---

## Production checklist

- [ ] `app.debug` is `false`
- [ ] `app.log_level` is `WARNING` or `ERROR`
- [ ] `server.proxy_headers` is `true`
- [ ] `server.workers` matches CPU count / 2
- [ ] All `*_API_KEY` / `*_SECRET` env vars are set and strong
- [ ] `SECURITY__API_KEY_ENCRYPTION_KEY` is saved securely (not recoverable from logs)
- [ ] Database URL points to a managed database (not SQLite)
- [ ] HTTPS is enabled (Caddy / Nginx / cloud LB)
- [ ] Health check endpoint is monitored
- [ ] Backups are scheduled for MySQL and volumes
- [ ] Docker resource limits are set (see docker-compose.yml)
- [ ] Firewall allows only 443 (and 80 for redirect)

---

## Monitoring

### Health endpoint

```
GET /health → {"status": "healthy"}
```

### Cache stats

```
GET /cache/stats → {"l1_hits": ..., "l2_hits": ..., "misses": ...}
```

### Logs

- `logs/app.log` — all logs, rotation 10 MB, retention 7 days
- `logs/error.log` — ERROR+ only, retention 30 days

### Recommended external monitoring

- **Uptime**: Uptime Kuma, Better Uptime
- **Logs**: ship to Loki / Datadog / ELK
- **Metrics**: expose via Prometheus FastAPI instrumentator
- **Traces**: LangSmith (built-in) or OpenTelemetry

---

## Backup & restore

```bash
# Relational data (MySQL): mind_base 元数据 + app_task / app_pay
docker compose exec mysql mysqldump -u root -p mind_base > backup-mind_base.sql
docker compose exec app-task-mysql mysqldump -u root -p app_task > backup-app_task.sql   # 若启用了 app-task
docker compose exec app-pay-mysql mysqldump -u root -p app_pay > backup-app_pay.sql      # 若启用了 app-pay

# Document stores (Mongo): 聊天/笔记正文/ASR/题目/板内容
docker compose exec mongo mongodump --db MindBase --archive > backup-mongo.archive

# Graph store (Neo4j): 知识图谱
docker compose exec neo4j neo4j-admin database dump neo4j --to-stdout > backup-neo4j.dump

# Files (MinIO) / vectors (Milvus) volumes
docker run --rm \
  -v mind-base_minio_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/minio-backup-$(date +%F).tar.gz -C /data .

# Restore MySQL
docker compose exec -T mysql mysql -u root -p mind_base < backup-mind_base.sql
```

---

## Upgrading

```bash
cd /opt/mind-base
git pull
docker compose up -d --build
```

If the embedding model or chunk strategy changed, bump `embedding.version` in config and rebuild vector indexes.

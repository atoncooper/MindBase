# Docker 构建与部署指南

本文档介绍如何使用 Docker Compose 一键构建并部署 Bilibili RAG 系统。

---

## 目录

- [前置条件](#前置条件)
- [项目 Docker 架构](#项目-docker-架构)
- [快速开始](#快速开始)
- [环境变量配置](#环境变量配置)
- [构建与启动](#构建与启动)
- [验证部署](#验证部署)
- [常用运维命令](#常用运维命令)
- [生产环境建议](#生产环境建议)
- [常见问题](#常见问题)

---

## 前置条件

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| Docker | 24+ | 容器运行时 |
| Docker Compose | 2.x（Plugin） | 多容器编排 |
| Git | 2.x | 克隆项目（可选） |

> Windows 用户建议使用 Docker Desktop，macOS/Linux 用户建议使用 Docker Engine + Compose Plugin。

---

## 项目 Docker 架构

```
docker-compose.yml
├── backend (bilibili-rag-backend)    ← FastAPI :8000
│   └── Dockerfile (项目根目录)
└── frontend (bilibili-rag-frontend)  ← Next.js :3000
    └── Dockerfile (frontend/ 目录)
```

**两个容器均对外暴露端口：**
- **后端 API**：`http://localhost:8000`（Swagger Docs：`http://localhost:8000/docs`）
- **前端 UI**：`http://localhost:3000`

**数据持久化通过 Docker Volumes：**
- `backend_data`：SQLite 数据库 + Milvus 向量数据
- `backend_logs`：应用日志

---

## 快速开始

```bash
# 1. 进入项目根目录
cd bilibili-rag

# 2. 复制并编辑环境变量
cp .env.example .env
# 编辑 .env，至少填入 LLM__API_KEY 和 SESSION__SECRET

# 3. 构建并启动所有服务（后台运行）
docker compose up -d --build

# 4. 查看启动日志
docker compose logs -f
```

首次构建约 3-8 分钟（含 pip install + npm ci + Next.js build），后续构建可利用 Docker layer cache 加速。

---

## 环境变量配置

### 必填项

在项目根目录创建 `.env` 文件，至少填入以下变量：

```bash
# LLM API Key（必填，兼容 OpenAI 协议）
LLM__API_KEY=sk-your-api-key-here

# Session 签名密钥（必填）
# 生成方式：python -c "import secrets; print(secrets.token_urlsafe(48))"
SESSION__SECRET=your-generated-secret

# 用户 API Key 加密密钥（必填，部署后不可修改）
# 生成方式：python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"
SECURITY__API_KEY_ENCRYPTION_KEY=your-generated-encryption-key
```

### 完整环境变量参考

| 变量分类 | 变量名 | 说明 | 默认值 |
|---------|--------|------|--------|
| **核心** | `LLM__API_KEY` | LLM API Key（兼容 OpenAI 协议） | 空（必填） |
| **核心** | `SESSION__SECRET` | Session JWT 签名密钥 | 空（必填） |
| **核心** | `SECURITY__API_KEY_ENCRYPTION_KEY` | 用户 API Key 加密密钥（base64） | 空（必填） |
| **数据库** | `RDBMS__URL` | 关系数据库连接串（开发用 SQLite，生产用 PostgreSQL） | 见 YAML |
| **LLM** | `LLM__API_KEY` | 同核心，LLM API Key | 空 |
| **可观测** | `LANGSMITH_API_KEY` | LangSmith Trace Key | 空 |
| **可观测** | `LANGCHAIN_TRACING_V2` | 启用 LangChain Trace | true |
| **可观测** | `LANGSMITH_TRACING` | 启用 LangSmith Trace | true |
| **前端** | `NEXT_PUBLIC_API_URL` | 前端访问后端的地址（容器内通信） | http://backend:8000 |
| **应用** | `APP_PORT` | 后端对外端口 | 8000 |

> **配置优先级**：环境变量 > `app/config/local.yaml` > `app/config/config.yaml` > `app/config/default.yaml`。
> 非敏感配置（超时时间、分块大小、模型名等）请在 YAML 文件中修改，不要在 `.env` 中重复定义。

### 关于 LLM 提供商

默认使用阿里云 DashScope（`qwen3-max` + `text-embedding-v4`）。如需切换到 OpenAI：

1. 编辑 `app/config/default.yaml` 或 `app/config/config.yaml`：
   ```yaml
   llm:
     provider: openai
     base_url: https://api.openai.com/v1
     model: gpt-4o
   embedding:
     model: text-embedding-3-small
     dimension: 1536
   ```
2. `.env` 中将 `LLM__API_KEY` 设为 OpenAI Key 即可。

---

## 构建与启动

### 基础命令

```bash
# 构建镜像（不启动）
docker compose build

# 构建 + 启动（后台）
docker compose up -d --build

# 启动已有镜像（不重新构建）
docker compose up -d

# 查看运行状态
docker compose ps

# 查看日志
docker compose logs -f backend     # 仅后端
docker compose logs -f frontend    # 仅前端
docker compose logs -f             # 全部
```

### 分步操作

```bash
# 仅构建/重启后端
docker compose up -d --build backend

# 仅构建/重启前端
docker compose up -d --build frontend

# 重启某个服务
docker compose restart backend
```

### 停止与清理

```bash
# 停止所有容器
docker compose down

# 停止并删除 volumes（清空所有数据！）
docker compose down -v

# 停止并删除镜像
docker compose down --rmi all
```

---

## 验证部署

### 1. 健康检查

```bash
# 后端健康检查
curl http://localhost:8000/health
# 预期返回：{"status": "healthy"}

# 前端健康检查
curl -I http://localhost:3000
# 预期返回：HTTP/1.1 200 OK
```

Docker Compose 已配置了后端的 `healthcheck`，前端会在后端 healthy 之后再启动。

### 2. 快速功能验证

打开浏览器访问 `http://localhost:3000`，确认：

1. 页面正常加载，无白屏
2. 点击"登录"按钮能获取 B 站二维码
3. 登录后能看到收藏夹列表
4. 选中收藏夹后能进行入库操作
5. 入库完成后能在右侧聊天面板进行问答

### 3. API 文档验证

访问 `http://localhost:8000/docs` 查看 Swagger UI，确认所有接口已注册。

---

## 常用运维命令

```bash
# 进入容器
docker compose exec backend bash        # 后端
docker compose exec frontend sh         # 前端（Alpine）

# 查看后端实时日志
docker compose logs -f --tail=100 backend

# 查看资源使用
docker stats bilibili-rag-backend bilibili-rag-frontend

# 备份数据卷
docker run --rm -v bilibili-rag_backend_data:/data -v $(pwd):/backup alpine tar czf /backup/data-backup.tar.gz -C /data .

# 恢复数据卷
docker run --rm -v bilibili-rag_backend_data:/data -v $(pwd):/backup alpine tar xzf /backup/data-backup.tar.gz -C /data
```

---

## 生产环境建议

### 1. 使用 PostgreSQL 替代 SQLite

当前 `default.yaml` 中配置了 MySQL 连接。生产环境推荐 PostgreSQL：

```bash
# .env
RDBMS__URL=postgresql+asyncpg://user:password@host:5432/bilirag
```

并在 `app/config/config.yaml` 中配置连接池：

```yaml
rdbms:
  echo: false
  pool_size: 20
  max_overflow: 10
```

### 2. 关闭 Debug 模式

在 `app/config/config.yaml` 中：
```yaml
app:
  debug: false
  log_level: WARNING
```

### 3. 使用反向代理

建议在容器前加 Nginx / Caddy 反向代理，统一入口并处理 HTTPS：

```nginx
# Nginx 示例
server {
    listen 443 ssl;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;  # 前端
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;  # 后端
    }

    location /health {
        proxy_pass http://127.0.0.1:8000;
    }
}
```

### 4. 资源限制

在 `docker-compose.yml` 中为每个服务添加资源限制：

```yaml
services:
  backend:
    # ... 其它配置
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: "2"
        reservations:
          memory: 1G
          cpus: "0.5"
```

### 5. 生产环境变量清单

部署到生产前，确认以下变量已设置：

| 变量 | 生产值建议 |
|------|----------|
| `LLM__API_KEY` | 真实 Key |
| `SESSION__SECRET` | 随机 48 位字符串 |
| `SECURITY__API_KEY_ENCRYPTION_KEY` | 随机 32 字节 base64 |
| `RDBMS__URL` | PostgreSQL 连接串 |
| `LANGSMITH_API_KEY` | 可选，用于链路追踪 |

---

## 常见问题

### Q: 构建时下载依赖很慢？

**后端**：在 Dockerfile 中配置 pip 镜像源：
```dockerfile
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
```

**前端**：在 Dockerfile 中配置 npm 镜像源：
```dockerfile
RUN npm ci --registry=https://registry.npmmirror.com
```

### Q: 前端无法连接后端？

检查 `docker-compose.yml` 中前端的环境变量：
```yaml
NEXT_PUBLIC_API_URL=http://backend:8000
```

容器内服务间通信使用 Docker 服务名（`backend`）而非 `localhost`。浏览器端的前端代码会读取 `NEXT_PUBLIC_API_URL` 来发请求，确保该值能从浏览器端访问（通常是 `http://localhost:8000` 或你的域名）。

### Q: ASR 服务不可用？

检查：
1. 后端容器中 ffmpeg 是否安装成功：`docker compose exec backend ffmpeg -version`
2. DashScope API Key 是否正确：确认 `LLM__API_KEY` 已设置（ASR 复用 LLM 的 API Key）
3. ASR 音频文件是否正常下载

### Q: Milvus 数据丢失？

确保不要删除 `backend_data` volume：
```bash
# 查看 volume 是否存在
docker volume ls | grep bilibili-rag

# 停止容器时保留 volume（不加 -v 参数）
docker compose down        # 保留数据
docker compose down -v     # 删除数据（危险！）
```

### Q: 如何更新到最新版本？

```bash
git pull
docker compose up -d --build
```

> 如果涉及 embedding 模型更换，需要清空 Milvus 数据并全量重建向量索引。

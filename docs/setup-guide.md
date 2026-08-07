# MindBase 安装与运行指南

> 手把手从零把 MindBase 跑起来。按顺序做就行。

---

## 第 1 步：装 Docker

MindBase 用 Docker 部署，最省事。

- Windows / Mac：下载 [Docker Desktop](https://www.docker.com/products/docker-desktop) 安装
- Linux：`curl -fsSL https://get.docker.com | sh && sudo systemctl enable --now docker`

装完确认能用：

```bash
docker --version
docker compose version
```

---

## 第 2 步：拉代码

```bash
git clone https://github.com/atoncooper/MindBase.git
cd MindBase
```

---

## 第 3 步：申请 API Key

系统需要几个 key，先去申请。

### 3.1 DashScope（必填，不配跑不起来）

MindBase 的 LLM、向量化、语音识别都走阿里云 DashScope。

1. 开通 DashScope：https://dashscope.console.aliyun.com/
2. 创建 API Key：https://dashscope.console.aliyun.com/apiKey
3. 复制那个 `sk-` 开头的 key，下一步用

### 3.2 Resend（只用定时出题功能才需要，否则跳过）

定时出题到点发邮件用。

1. 注册：https://resend.com（免费 100 封/天）
2. 创建 API Key：https://resend.com/api-keys，复制 `re_` 开头的 key
3. 验证发件域名：后台 Domains → Add Domain，按提示加 3 条 DNS 记录等生效
   - 不验证域名只能用测试地址 `onboarding@resend.dev`，且只能发给你自己注册 Resend 的邮箱

---

## 第 4 步：配置 `.env`

在项目根目录执行：

```bash
cp .env.example .env
```

打开 `.env`，找到下面几项填上值（其他保持默认即可，数据库等 Docker 会自动起）：

```bash
# ===== 必填 =====

# DashScope API Key（第 3.1 步拿的）
LLM__API_KEY=sk-这里填你的DashScope密钥

# Session 签名密钥——执行下面命令生成，把输出粘进来
# python -c "import secrets; print(secrets.token_urlsafe(48))"
SESSION__SECRET=

# 用户 API Key 加密密钥——执行下面命令生成，把输出粘进来
# python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"
# ⚠️ 部署后绝不能改这个值，否则已存的用户 API Key 全部无法解密
SECURITY__API_KEY_ENCRYPTION_KEY=

# 服务间通信密钥——执行下面命令生成，把输出粘进来
# python -c "import secrets; print(secrets.token_urlsafe(32))"
APISIX_CONSUMER_KEY=

# ===== 定时出题功能才填（不用出题就留空）=====

# Resend API Key（第 3.2 步拿的）
APPTASK_EMAIL_API_KEY=
```

数据库、MongoDB、Redis、Milvus 这些 Docker 会自动起，**不用你配**。

---

## 第 5 步：（只用出题功能才做）改发件人地址

不用出题功能就跳到第 6 步。

打开 `app-task/default.yaml`，找到 `from_email`，改成你在 Resend 验证过的域名：

```yaml
email:
  from_email: "MindBase <noreply@你的域名.com>"
```

---

## 第 6 步：启动

```bash
docker compose --profile full up -d --build
```

- `--profile full` 启动全部服务（含向量库 Milvus、出题执行器 app-task）
- `--build` 首次或改了代码要加，会编译后端、前端、app-task

首次跑要几分钟（拉镜像 + 编译）。完成后看状态：

```bash
docker compose ps
```

所有服务应该是 `running` 或 `healthy`。如果有 `unhealthy` 或 `Exited`，看日志：

```bash
docker compose logs backend      # 主服务
docker compose logs app-task     # 出题执行器
```

---

## 第 7 步：验证

浏览器打开 **http://localhost:3000**，能看到登录页就说明前端起来了。

或命令行验证后端：

```bash
curl http://localhost:8000/health
# 返回 {"status":"healthy",...} 即正常

curl http://localhost:8001/health
# app-task 健康检查（出题执行器）
```

如果 `/health` 报错，最常见是 `.env` 没填全或填错变量名（回第 4 步检查）。

---

## 第 8 步：开始用

1. 打开 http://localhost:3000
2. 用 B 站 App 扫码登录
3. 选要同步的收藏夹，点同步
4. 触发知识库构建（会做语音识别 + 向量化，等几分钟）
5. 构建完就能在对话框问收藏夹里的内容了
6. 定时出题：进「定时出题」，填出题方向（如"数学一填空题"）+ 触发时间，到点自动出题并发邮件到你的邮箱

---

## 常见问题

### 启动后 3000 端口打不开

前端还在构建。看日志等到 `ready`：

```bash
docker compose logs -f frontend
```

### backend `/health` 报错 / 启动失败

```bash
docker compose logs backend | tail -50
```

最常见原因：
- `.env` 的 `LLM_API_KEY` / `SESSION_SECRET` / `API_KEY_ENCRYPTION_KEY` 没填或填成了双下划线（应该是 `LLM_API_KEY` 不是 `LLM__API_KEY`）
- `API_KEY_ENCRYPTION_KEY` 不是合法的 base64（重新用第 4 步的命令生成）

### app-task 启动失败 `config validation failed`

`APISIX_CONSUMER_KEY` 没填。回第 4 步填上（三个服务间密钥要一致，docker-compose 会自动传给 app-task）。

### 到点没收到邮件

先看出题执行器日志：

```bash
docker compose logs app-task | grep -E "TASK|NOTIFICATION"
```

再查通知状态：

```bash
docker compose exec mysql mysql -umind_base -pmind-base mind_base -e "SELECT status, last_error FROM task_quiz_notification ORDER BY id DESC LIMIT 5;"
```

- `status=dry_run`：`APPTASK_EMAIL_API_KEY` 没配，邮件没发（配了才会发）
- `status=failed`：Resend 拒绝了，看 `last_error`——多半是发件域名没在 Resend 验证，或 `from_email` 还用的默认 `onboarding@resend.dev`
- `status=sent`：真发了，去垃圾箱找

### 前端题目显示原始 `\frac{...}` 不渲染

前端依赖没装好。进前端容器重装：

```bash
docker compose exec frontend npm install katex
docker compose restart frontend
```

### CI 报 `npm ci 504 Gateway Time-out`

前端 `package-lock.json` 指向了国内镜像。本地跑：

```bash
cd frontend
sed -i 's|registry.npmmirror.com|registry.npmjs.org|g' package-lock.json
```

提交改完的 lock。

### 想用本地开发（不用 Docker）

需要自己起 MySQL / MongoDB / Redis / Milvus（可以只起这些 infra 用 Docker，程序本地跑）。

```bash
# 起 infra
docker compose up -d mysql mongo redis
docker compose --profile storage up -d milvus

# 后端
python -m pip install -r requirements.txt
export LLM__API_KEY=sk-xxx
export RDBMS__URL="mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base"
export MONGO__URI="mongodb://admin:mind-base@127.0.0.1:27017/?authSource=admin"
uvicorn app.main:app --reload --port 8000

# 前端（另开终端）
cd frontend && npm install && npm run dev

# 出题执行器（另开终端）
go run ./app-task
```

本地开发时 `.env` 用 `.env.example` 的**双下划线**变量名（`LLM__API_KEY` 等），程序直接读。

---

## 停止 / 清理

```bash
# 停止所有服务（保留数据）
docker compose --profile full down

# 彻底清理（删所有数据，慎用）
docker compose --profile full down -v
```

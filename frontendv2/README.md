# frontendv2 - MindBase 当前前端

> 这是 MindBase 的**当前活跃前端**。第一代前端 [`../frontend/`](../frontend/) 已废弃，仅作存档。

## 技术栈

- Next.js 16.3（App Router, `output: "standalone"`）
- React 19
- Tailwind CSS v4（`@theme` tokens，见 `app/globals.css`）
- framer-motion 13、react-markdown 9 + remark-gfm + rehype-katex、lucide-react

## 本地开发

```bash
cd frontendv2
npm install
npm run dev   # http://localhost:3000
```

开发模式下，`next.config.ts` 的 `rewrites()` 将 API 请求代理到 `NEXT_PUBLIC_APISIX_HOST`（默认 `192.168.138.128:9080`）。按需覆盖：

```bash
NEXT_PUBLIC_APISIX_HOST=apisix:9080 npm run dev
```

> `/tasks`、`/task-quiz`、`/notes` 既是页面路由又是后端 API 路径，靠 `beforeFiles` + `X-Requested-With` 头区分 API fetch 与页面导航，避免 fetch 命中页面返回 HTML。

## Docker 部署

compose 的 `frontend` 服务即本目录，构建源为 `frontendv2/Dockerfile`：

```bash
# 从仓库根构建并启动整栈
docker compose up -d --build frontend

# 或单独构建镜像
docker build -t mind-base-frontendv2 \
  --build-arg NEXT_PUBLIC_API_URL=https://your-domain \
  -f frontendv2/Dockerfile frontendv2
```

**生产环境**设 `NEXT_PUBLIC_API_URL`（非空）后，`next.config.ts` 的 `rewrites()` 返回空，由 nginx 代理 API；不设则走 dev 代理。`NEXT_PUBLIC_*` 是 build-time 内联变量，必须通过 `--build-arg` 或 compose `build.args` 传入，运行时 env 对它们无效。

详见 [`Dockerfile`](./Dockerfile) 与 [`../docker-compose.yml`](../docker-compose.yml) 的 `frontend` 服务。

## npm 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发服务器（Turbopack） |
| `npm run build` | 生产构建（standalone） |
| `npm run start` | 启动生产服务器 |
| `npm run lint` | ESLint |

## 目录速览

| 路径 | 说明 |
|------|------|
| `app/` | App Router 页面与布局（首页、设置、账户、用量、笔记、任务等） |
| `components/` | React 组件：`chat/` `account/` `settings/` `billing/` `notes/` `cloud-drive/` `quiz/` `task-quiz/` `skills/` |
| `lib/api/` | **唯一** API 调用入口（组件内禁止直接 `fetch`） |
| `lib/chat-stream.ts` | SSE 流式响应解析 |
| `app/globals.css` | Tailwind v4 主题 tokens + `.md-body` 排版样式 |
| `next.config.ts` | standalone 输出 + dev 代理 rewrites |

## 约束

- 所有 API 调用必须经 `lib/api/`，禁止组件内直接 `fetch`。
- `sessionId` 由后端下发，前端只存储不生成。
- 全站偏好 Material 实色 surface，避免玻璃拟态 / 强渐变。

# Getting Started — Local Development

Run MindBase on your machine for development.

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Python | >= 3.11 | `python --version` |
| Node.js | >= 18 | `node --version` |
| ffmpeg | any recent | `ffmpeg -version` |
| MySQL | 8.x | required — provide via `RDBMS__URL` (no SQLite fallback in defaults) |
| Git | 2.x | `git --version` |

> **Windows users**: install ffmpeg via `winget install ffmpeg` or [ffmpeg.org](https://ffmpeg.org). Ensure `ffmpeg.exe` is on your PATH.

---

## Quick start (5 minutes)

```bash
# 1. Clone
git clone <repo-url> && cd mind-base

# 2. Environment
cp .env.example .env
# Edit .env — fill in LLM__API_KEY at minimum

# 3. Backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# 4. Frontend (new terminal)
cd frontendv2
npm install
npm run dev
```

Open **http://localhost:3000** — the backend Swagger is at **http://localhost:8000/docs**.

---

## Minimal `.env`

```env
LLM__API_KEY=sk-your-dashscope-key
```

> All other settings fall back to `app/config/default.yaml`. See [configuration.md](configuration.md) for the full reference.

---

## Database

`rdbms.url` has **no default** — inject it via env:

```env
RDBMS__URL=mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base
```

The easiest local setup is the MySQL container from the compose file (`docker compose up -d mysql`), or point `RDBMS__URL` at any MySQL/PostgreSQL instance. SQLite (`sqlite+aiosqlite:///./data/mind_base.db`) also works for pure local dev if you set it explicitly.

---

## Project structure (development)

```
app/
├── main.py              # FastAPI entry point, middleware, lifespan
├── routers/             # HTTP endpoints (thin — parameter parsing only)
├── services/            # Business logic
│   ├── rag/             # Vector retrieval, chunking, LLM prompts
│   └── auth/            # User lifecycle, tokens
├── repository/          # Database access (SQL / ORM)
├── infra/               # Infrastructure (MySQL, Milvus, Redis, Mongo, …)
├── config/              # YAML configuration (default.yaml)
├── response/            # Pydantic API schemas (request / response models)
├── agent/               # LangGraph agents (chat / memory / note / code / search / summary / quiz)
├── harness/             # AgentHarness orchestration (orchestrator + runtime)
├── tools/               # @register_tool auto-discovered tools
└── models.py            # SQLAlchemy ORM models only

frontendv2/              # current frontend (frontend/ is deprecated, archived only)
├── app/                 # Next.js App Router (page.tsx, layout.tsx)
├── components/          # React components (chat / account / settings / billing / notes / cloud-drive / quiz)
├── lib/api/             # API client (modular, no direct fetch in components)
└── lib/chat-stream.ts   # SSE stream parsing

docs/                    # Documentation
```

---

## Development workflow

1. **Backend changes** → auto-reload via uvicorn `--reload`
2. **Frontend changes** → HMR via Next.js dev server
3. **New API endpoint** → add router → register in `main.py` → test at `/docs`
4. **New response model** → add to `app/response/<module>.py` → re-export in `__init__.py`

### Type checking & linting

```bash
# Backend
pip install ruff mypy
ruff check app/
mypy app/

# Frontend
cd frontendv2
npm run lint
npx tsc --noEmit
```

---

## Running with Docker (dev)

```bash
# Full stack (default profile): backend, frontend, nginx, APISIX, MySQL, Redis,
# Mongo, MinIO, Milvus, Neo4j, app-task, app-board
docker compose up -d

# Optional extras on top of the full stack
docker compose --profile pay up -d         # + payment/membership service (app-pay)
docker compose --profile pay-admin up -d   # + payment admin console (app-pay-admin)
docker compose --profile tools up -d       # + redis-commander / mongo-express
```

See [architecture.md](architecture.md) for the complete service/port/profile table.

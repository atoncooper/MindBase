# Getting Started — Local Development

Run BiliMind on your machine for development.

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Python | >= 3.11 | `python --version` |
| Node.js | >= 18 | `node --version` |
| ffmpeg | any recent | `ffmpeg -version` |
| MySQL | 8.x | optional — defaults to SQLite if absent |
| Git | 2.x | `git --version` |

> **Windows users**: install ffmpeg via `winget install ffmpeg` or [ffmpeg.org](https://ffmpeg.org). Ensure `ffmpeg.exe` is on your PATH.

---

## Quick start (5 minutes)

```bash
# 1. Clone
git clone <repo-url> && cd bilibili-rag

# 2. Environment
cp .env.example .env
# Edit .env — fill in LLM__API_KEY at minimum

# 3. Backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# 4. Frontend (new terminal)
cd frontend
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

If MySQL is not available, change `rdbms.url` in a `config.yaml`:

```yaml
# app/config/config.yaml
rdbms:
  url: sqlite+aiosqlite:///./data/bilibili_rag.db
```

By default the project uses MySQL (`mysql+aiomysql://...`). SQLite is fine for local dev.

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
└── models.py            # SQLAlchemy ORM models only

frontend/
├── app/                 # Next.js App Router (page.tsx, layout.tsx)
├── components/          # React components
│   └── three/           # Three.js 3D scene components
└── lib/                 # API client (api.ts), shared utilities

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
cd frontend
npm run lint
npx tsc --noEmit
```

---

## Running with Docker (dev)

```bash
# Minimal stack (backend + frontend + MySQL + Redis + Mongo)
docker compose up -d

# With Milvus
docker compose --profile storage up -d

# Full stack with admin UIs
docker compose --profile full up -d
```

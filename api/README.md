# Bilibili RAG API Documentation

Complete OpenAPI 3.0 specification for the Bilibili RAG knowledge base system.

## Quick start

### Option 1: Local Swagger UI

```bash
cd api
python -m http.server 8080
# Open http://localhost:8080/swagger-ui.html
```

### Option 2: Online editor

1. Go to https://editor.swagger.io
2. File → Import URL → `http://localhost:8000/openapi.yaml`
   Or paste the contents of `openapi.yaml` directly.

### Option 3: FastAPI built-in docs

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

---

## API overview

### Auth (`/auth`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/qrcode` | Generate QR login code |
| GET | `/auth/qrcode/poll/{qrcode_key}` | Poll QR scan status |
| GET | `/auth/me` | Get current user info (Bearer token) |
| GET | `/auth/session/{session_id}` | [Legacy] Get session info |
| DELETE | `/auth/token` | Logout current device (Bearer token) |
| DELETE | `/auth/tokens` | Logout all devices (Bearer token) |
| DELETE | `/auth/session/{session_id}` | [Legacy] Logout |

### Chat (`/chat`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat/ask` | Standard Q&A |
| POST | `/chat/ask/agentic` | Agentic multi-hop RAG Q&A |
| POST | `/chat/ask/stream` | Streaming Q&A (SSE) |
| POST | `/chat/search` | Semantic search |
| GET | `/chat/sessions` | List chat sessions |
| POST | `/chat/sessions` | Create chat session |
| GET | `/chat/sessions/{chat_session_id}` | Get session detail |
| PATCH | `/chat/sessions/{chat_session_id}` | Rename session |
| DELETE | `/chat/sessions/{chat_session_id}` | Delete session |
| GET | `/chat/history` | Get chat history (paginated) |
| DELETE | `/chat/history` | Clear chat history |

### Favorites (`/favorites`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/favorites/list` | List favorite folders |
| GET | `/favorites/{media_id}/videos` | Get folder videos (paginated) |
| GET | `/favorites/{media_id}/all-videos` | Get all folder videos |
| POST | `/favorites/organize/preview` | Preview folder organization |
| POST | `/favorites/organize/execute` | Execute folder organization |
| POST | `/favorites/organize/clean-invalid` | Clean invalid resources |

### Knowledge (`/knowledge`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/knowledge/stats` | Knowledge base stats |
| GET | `/knowledge/folders/status` | Folder index status |
| GET | `/knowledge/pages/vectorized` | List vectorized pages |
| GET | `/knowledge/video/{bvid}/pages` | Video multi-P info |
| POST | `/knowledge/folders/sync` | Sync folders to vector DB |
| POST | `/knowledge/build` | Build knowledge base (async) |
| GET | `/knowledge/build/status/{task_id}` | Query build task status |
| DELETE | `/knowledge/clear` | Clear knowledge base |
| DELETE | `/knowledge/video/{bvid}` | Delete single video |

### ASR (`/asr`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/asr/content` | Query ASR content |
| POST | `/asr/create` | Create ASR task (idempotent) |
| POST | `/asr/update` | Manual edit ASR content |
| POST | `/asr/reasr` | Force re-ASR (new version) |
| GET | `/asr/status/{task_id}` | Query ASR task status |
| GET | `/asr/versions` | Query ASR version history |

### VectorPage (`/vec/page`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vec/page/status` | Query page vector status |
| POST | `/vec/page/create` | Create vectorization task |
| POST | `/vec/page/revector` | Force re-vectorization |
| GET | `/vec/page/status/{task_id}` | Query vectorization task status |

### Credentials (`/credentials`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/credentials` | List credentials (keys masked) |
| POST | `/credentials` | Create credential |
| PATCH | `/credentials/{credential_id}` | Update credential |
| DELETE | `/credentials/{credential_id}` | Delete credential |
| POST | `/credentials/{credential_id}/default` | Set as default credential |

### Settings (`/settings`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/credentials/status` | Get API key config (masked) |
| POST | `/settings/credentials` | Set/update user API keys |
| DELETE | `/settings/credentials` | Delete custom keys (revert to defaults) |

### Billing (`/billing`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/billing/summary` | Usage summary |
| GET | `/billing/by-provider` | Usage by provider |
| GET | `/billing/by-credential` | Usage by credential |

### Quiz (`/quiz`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/quiz/generate` | Generate quiz set |
| GET | `/quiz/{quiz_uuid}` | Get quiz (optional answers) |
| POST | `/quiz/submit` | Submit answers + auto-grade |
| GET | `/quiz/history` | Answer history (paginated) |
| GET | `/quiz/wrong-answers` | Wrong answers notebook |
| GET | `/quiz/export` | Export data (jsonl/csv/sft) |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API root |
| GET | `/health` | Health check |

---

## Authentication

### Login flow

```
1. GET  /auth/qrcode              → get QR code
2. User scans QR code with Bilibili app
3. GET  /auth/qrcode/poll/{key}  → poll until "confirmed"
4. Save the returned session_token
```

### Using the token

**New (recommended):** `Authorization: Bearer <session_token>` header.

```
GET /auth/me
Authorization: Bearer abc123...
```

**Legacy (compat):** `?session_id=<uuid>` query parameter.

```
GET /favorites/list?session_id=abc123
```

---

## SSE streaming format

`/chat/ask/stream` returns Server-Sent Events:

```
data: {"type":"chunk","content":"Hello"}
data: {"type":"chunk","content":", welcome"}
data: {"type":"sources","sources":[{"bvid":"BV1xx","title":"...","url":"..."}]}
data: {"type":"done"}
```

Four event types:
- `chunk` — append text to the message bubble
- `sources` — pass to SourcesPanel for display
- `error` — show error, re-enable input
- `done` — mark stream as complete

---

## Route strategies

| Route | Description | Use case |
|-------|-------------|----------|
| `direct` | Direct LLM answer | Greetings, general chat |
| `db_list` | List-style answer | "What videos do I have?" |
| `db_content` | Content summary | "Summarize the ML tutorials" |
| `vector` | Vector retrieval + RAG | Specific topic questions |

---

## Task status lifecycle

ASR and vectorization tasks follow the same state machine:

```
pending → processing → done
                    ↘ failed (retryable)
```

---

## Error format

All errors return a uniform structure:

```json
{"detail": "Human-readable error description"}
```

| HTTP code | Meaning |
|-----------|---------|
| 200 | Success |
| 400 | Invalid request parameters |
| 401 | Not authenticated / token expired |
| 404 | Resource not found |
| 409 | Conflict (duplicate create) |
| 422 | Request body validation error |
| 500 | Internal server error |

---

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-05 | v1.3.0 | User center (uid/oauth/token/RBAC), YAML config, Repository layer |
| 2026-05 | v1.3.0 | New endpoints: `/auth/me`, `/auth/token`, `/credentials`, `/settings`, `/billing`, `/quiz` |
| 2026-04 | v1.2.0 | Per-page ASR + vectorization, Agentic RAG, LangSmith integration |
| 2026-03 | v1.1.0 | Favorite folder organize, background build tasks |
| 2026-03 | v1.0.0 | Initial release |

---

## Related docs

- [Project README](../README.md)
- [Configuration guide](../docs/configuration.md)
- [OpenAPI specification](./openapi.yaml)

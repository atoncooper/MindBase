# MindBase Desktop

Fully-local desktop companion of [MindBase](../..): a personal knowledge base that runs entirely on
your machine. Built with Tauri 2 + React 19 + TypeScript — no backend service is required and all
data stays in local storage.

## Architecture

The Rust shell (`src-tauri/src/`) mirrors the backend's `app/harness` + `app/services` layering,
re-implemented for a single machine:

```
React UI (src/)                     Rust commands (src-tauri/src/)
┌──────────────────┐   Tauri IPC   ┌─────────────────────────────────────┐
│ ChatView / Quiz  │ ────────────► │ chat.rs · quiz.rs · ingest.rs …     │
│ NotesView / …    │ ◄── events ── │            │                        │
└──────────────────┘               │            ▼                        │
                                   │  harness/  AgentHarness             │
                                   │  ├── orchestrator.rs  LLM 路由       │
                                   │  ├── lifecycle.rs     熔断+会话锁+TTL │
                                   │  ├── registry.rs      工具注册表      │
                                   │  ├── runtime.rs       并发执行+指标   │
                                   │  ├── scheduler.rs     队列(默认旁路)  │
                                   │  └── tools.rs         本地工具实现    │
                                   │            │                        │
                                   │  agents.rs (chat/memory/note ReAct) │
                                   │            ▼                        │
                                   │  vectors.rs + db.rs (SQLite 向量库)  │
                                   └─────────────────────────────────────┘
```

- **harness/** — five-piece port of the backend's AgentHarness: an LLM router with a 3 s timeout
  that unconditionally falls back to `chat`, circuit breakers (3 failures / 30 s cooldown) plus
  per-session locks and TTL cleanup, a registry-driven concurrent tool runtime with per-tool
  metrics, and a per-agent bounded-queue scheduler that is scaffolding by default.
- **agents.rs** — chat / memory / note / code / search descriptors sharing one generic ReAct
  loop. Sub-agents are reached only through `delegate_to_agent` (memory retrieves past
  conversation, note edits the notebook, code writes but never executes code, search queries
  Context7 docs with web-crawl fallback — the only optional-network tools), depth-capped at
  two levels with consecutive-failure short-circuit; their internal tool rounds stream to the
  UI as `subStep` events rendered indented under the parent turn. The summary agent runs as a
  standalone streaming command (`chat_summarize`) behind the sidebar 总结 button, with
  save-as-note in the dialog.
- **Local data** — everything (documents, chunks, vectors, notes, revisions, sessions, summaries)
  lives in one SQLite database under the data directory; the vector store is brute-force cosine.

## Data directory

The SQLite database lives under a single data directory. The default location is the OS app-data
folder; it can be moved to any folder from the 数据存储 card in the app (with optional data
migration, or a fresh empty database). The choice is persisted via a pointer file
(`data-location.json`) inside the *default* directory, so it survives restarts; if the custom
location becomes unusable, startup self-heals back to the default instead of failing.

## API keys

Provider API keys (DashScope / OpenRouter) are stored in the `api_keys` table of the same local
SQLite database. Raw keys never leave the Rust layer — the UI only ever receives masked previews
(`sk-…wxyz`) — and keys are never logged.

## ASR provider (云端 / 本地)

语音转写支持两种模式，在「API 设置 → ASR 语音转写」卡片内切换：

- **云端 API（DashScope）** — 默认。走 `asr` 槽的 Key / Base URL / 模型，未配置 Key 时回退
  DashScope 密钥。
- **本地部署（Whisper）** — 无需任何 API Key。应用通过自带的嵌入式 Python 自动安装
  faster-whisper 依赖并启动 `scripts/whisper_server.py`（OpenAI 兼容接口），模型权重首次使用时
  自动下载到 `<data_dir>/whisper-models`（默认走 hf-mirror.com 镜像并绕过系统代理，可用
  `HF_ENDPOINT` 覆盖）。应用启动即拉起服务、退出时停止；入库时若云端 Key 缺失也会自动回退本地。
  默认模型 `small`（CPU 友好），可在卡片中切换 tiny / base / medium / large-v3。

## Vector store

The vector store is built in and requires zero configuration: embeddings live in the `vectors`
table of the same SQLite database as everything else, so they are stored under the active data
directory and move together with 数据存储 relocation. Search is brute-force cosine similarity,
which comfortably handles a personal knowledge base. The 系统状态 card shows the current chunk
count (hover for the exact storage path); no external service is involved.

## Knowledge base (入库 / 搜索 / 问答)

The workspace turns favorited B站 videos into a searchable local knowledge base, mirroring the
backend's production pipeline (`app/services/`):

1. **入库** — 收藏夹 → 展开视频 → 入库。Per 分P: fetch the AI-conclusion outline (WBI-signed),
   resolve the audio CDN URL (signed `playurl`, unsigned fallback), transcribe with DashScope
   `paraformer-v2` (the cloud service pulls the CDN bytes directly; when the link is unreachable
   the app downloads locally and uploads to DashScope's temporary OSS), chunk with the rule-based
   semantic chunker (target 750 / max 900 / overlap 100 — ported from `chunking.py`), embed with
   DashScope `text-embedding-v4` (1024-d), and store vectors + a `documents` row in one
   transaction. Re-ingesting is delete-before-write; a failed 分P is marked and the run continues.
2. **降级** — when ASR is unavailable the 分P still lands with title+description text
   (`source = basic_info`), matching `content_fetcher.py`'s fallback.
3. **搜索 / 对话** — the home view is a ChatGPT-style conversation workspace: a sidebar of
   sessions (create / rename / delete, auto-titled from the first message with an LLM and
   guarded so manual renames win) plus a streaming chat column. Each turn runs through the
   local harness (`src-tauri/src/harness/`): an orchestrator picks the agent (only `chat` is
   routable today, matching production backend posture), a lifecycle layer gates it with
   per-agent circuit breakers and per-session locks, and a registry-driven ReAct loop lets the
   model call tools — `vector_search`, `list_documents`, `search_chat_history`,
   `get_recent_context` / `get_full_history` / `get_compressed_summary`, the four note tools,
   and `delegate_to_agent` (memory / note sub-agents, depth-capped at two levels with
   consecutive-failure short-circuiting). Answers stream with 【视频标题】 citations; nested
   agent steps render inline. A scheduler module (per-agent bounded queues with classified
   retries) exists as scaffolding and currently carries the title-refinement job.
4. **测验** — a manual quiz panel over ingested content: pick count / types (single & multi
   choice, short answer, essay) / difficulty / optional topic, then answer inline. Generation
   mirrors the backend's structured-output schemas including the essay→short_answer→
   single_choice downgrade chain and low-confidence marking; grading is local for objective
   types and LLM rubric scoring for essays.
5. **笔记** — local markdown notebook with optimistic-concurrency autosave, revision snapshots
   (backend 30%/10-minute policy), and video anchors that parse pasted B站 links down to the
   timestamp. Stored content is plain markdown sanitized Rust-side (dangerous URL schemes
   collapse to `#`, script/iframe blocks are dropped) before it ever touches SQLite.

## Notes (笔记)

A local markdown notebook under the 笔记 nav item: two-pane layout (searchable list with
pinning on the left, editor on the right) with 编辑 / 预览 modes. Editing is one seamless
plain-textarea surface over the raw markdown — native Ctrl+Z undo and Chinese IME composition
work untouched; preview renders through react-markdown (GFM + soft line breaks). Editor
shortcuts: Ctrl+B/I/`/K/Shift+X wrap the selection (bold, italic, code, link, strike),
Ctrl+1/2/3 toggle headings, Ctrl+Shift+Q/L toggle quote/list, Enter continues lists and
Tab/Shift+Tab indents, Ctrl+E swaps edit/preview and Ctrl+S saves now. Saves are debounced
(800 ms) with optimistic concurrency — an outdated `updatedAt` surfaces a conflict state
instead of overwriting. Revision snapshots follow the
backend policy (change ≥30% after ≥10 minutes, char-bigram approximation, newest 20 kept per
note) with one-click rollback. Video anchors parse pasted B站 links (bvid + p + t), fetch the
video title, and jump straight back to the timestamp in the browser. Stored content is plain
markdown sanitized Rust-side (dangerous URL schemes collapse to `#`, script/iframe blocks are
dropped) before it ever touches SQLite.

Requirements: a DashScope API key in API 设置 (used for ASR + embeddings; embeddings stay
DashScope-only by design). 问答 additionally needs a conversational model — DashScope defaults to
`qwen-flash` when unset, or an OpenRouter key with an explicit model. WBI signing is a local port
of `app/services/wbi.py` (anonymous nav keys, 6h cache).

## Prerequisites

- Node.js >= 18
- Rust toolchain (stable) plus the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/)
  for your platform

## Getting started

```bash
npm install

# REQUIRED before the first `tauri dev` / `tauri build`:
# the FFmpeg sidecar binaries under src-tauri/binaries/ are gitignored and must
# be provisioned locally.
npm run fetch:ffmpeg

npm run tauri dev    # run the desktop app in development mode
npm run tauri build  # produce installers
```

## Scripts

| Script                | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `npm run dev`         | Vite dev server for the frontend only                              |
| `npm run build`       | Type-check (`tsc`) then production Vite bundle                     |
| `npm run preview`     | Preview the built frontend                                         |
| `npm run fetch:ffmpeg`| Provision FFmpeg/FFprobe sidecar binaries into `src-tauri/binaries/` |
| `npm run tauri dev`   | Run the desktop app (requires `fetch:ffmpeg` first)                |
| `npm run tauri build` | Package the desktop app (requires `fetch:ffmpeg` first)            |

## Supply-chain note (TODO)

The FFmpeg binaries provisioned by `scripts/fetch-ffmpeg.ps1` are not hash- or version-pinned yet.
Pin known-good artifacts before distributing installers publicly; see the TODO at the top of that
script.

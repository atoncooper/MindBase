# MindBase Desktop

Fully-local desktop companion of [MindBase](../..): a personal knowledge base that runs entirely on
your machine. Built with Tauri 2 + React 19 + TypeScript — no backend service is required and all
data stays in local storage.

## Architecture

The Rust shell (`src-tauri/src/`) is split into domain **packages** — one directory plus a
`mod.rs` front door per package — mirroring the backend's service layering. The authoritative
layout, dependency rules and splitting conventions live in
[docs/desktop-rust-architecture.md](../docs/desktop-rust-architecture.md).

```
React UI (src/)                     Rust packages (src-tauri/src/)
┌──────────────────┐   Tauri IPC   ┌──────────────────────────────────────────┐
│ ChatView / Quiz  │ ────────────► │ app/         shell · setup · tray · IPC  │
│ NotesView / …    │ ◄── events ── │  ├ workspace/  notes·quiz·mindmap·…      │
└──────────────────┘               │  ├ agent/      harness·chat·skills·tools │
                                   │  ├ knowledge/  bilibili·ingest·vectors   │
                                   │  ├ media/      asr·whisper·ocr·ffmpeg    │
                                   │  ├ llm/        providers·client·embed    │
                                   │  └ infra/      sqlite·config·logging     │
                                   └──────────────────────────────────────────┘
```

- **app/** — Tauri shell only: builder assembly, startup wiring, tray and the single IPC
  registry (`app/commands.rs`). No business logic.
- **agent/** — the local AgentHarness (orchestrator / lifecycle / registry / runtime /
  scheduler / tools), agent descriptors sharing one generic ReAct loop, chat sessions,
  editable prompt defaults, skill packs and the web-search tool. Sub-agents are reached only
  through `delegate_to_agent` (memory / note / code / search), depth-capped at two levels.
  The summary agent runs as a standalone streaming command (`chat_summarize`).
- **knowledge/** — Bilibili acquisition (QR login, favorites, WBI-signed content), ingestion
  (transcribe → rule-based chunking → embed → store), local document import, URL capture, and
  the SQLite vector store with FTS hybrid retrieval.
- **media/** — media runtimes: cloud DashScope ASR + realtime WebSocket, managed local
  faster-whisper / OCR sidecars, ffmpeg resolution and the audio cache quota.
- **llm/** — outbound model access: provider catalog, credentials and egress proxy, the
  streaming chat client (OpenAI-compatible + Anthropic), embeddings and rerank.
- **workspace/** — user-facing document domains: notes, quiz, mind map, research, manuscript,
  literature, dataset, resume and slides.
- **infra/** — SQLite (schema + migrations + data-directory relocation), config, file logging,
  conversation artifacts on disk, embedded Python provisioning and the signed updater.
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

## 本机命令执行（run_command，默认关闭）

对话 Agent 可以调用一个 `run_command` 工具在本机执行命令：

- **三套 shell**：Windows 默认 `pwsh`（可显式 `cmd`）；Linux / macOS 用 `bash`。
- **默认关闭**：只有在「系统设置 → 命令执行」勾选开启后才会真正执行，否则工具直接返回错误。
- **文件边界**：`cwd` 必须在应用数据目录（`<data_dir>`）内，默认 `<data_dir>/agent-files/<agent>/`；
  越界路径走与 `read_file` 相同的词法规约 + canonicalize 校验并被拒绝。注意这是**工具层约定**：
  命令继承当前用户权限，仍可读写用户有权访问的任意路径，不是操作系统级沙箱。
- **网络**：`network=inherit`（默认）继承应用网络；`network=off` 在 Linux 用 `unshare -n`、
  macOS 用 `sandbox-exec` 断网执行，Windows 没有用户态等价机制会**明确报错**（不静默降级）。
- **运行护栏**：超时 1s–600s（默认 60s，到时强杀进程树）、命令长度上限 16KB。
- **输出策略**：stdout/stderr **直接写入** `<data_dir>/logs/exec/*.out.log|*.err.log`（不经过内存管道），
  工具只回传头 2KB + 尾 4KB 摘要与日志路径；需要看完整内容时用 `read_file` 的 `offset`/`limit`
  （字节，单次 ≤64KB）分段读取。日志目录按 64MB / 200 文件上限自动清理旧文件。
- **审计**：每次执行追加一行 JSON 到 `<data_dir>/logs/shell-audit.jsonl`（时间、agent、session、
  shell、network、cwd、命令预览、退出码、是否超时、耗时）。

> 安全提示：`run_command` 的能力远大于 `write_file`。请只在明确需要时开启，并避免把
> 不受信任的网页/文档内容直接交给 Agent 转成命令执行。

### git / gh 工具

除通用 `run_command` 外，同一开关下还提供两个结构化工具（不经过 shell 拼接参数）：

- **`git`**：`status` / `diff`（可选 staged、stat、path）/ `log`（oneline，limit、path）/
  `show`（rev，默认 HEAD）/ `branch` / `add`（paths 或 all）/ `commit`（message）。
  `repo` 传仓库根的**绝对路径**（代码仓库通常不在数据目录内）；写操作只有 add / commit，
  提示词要求仅在用户明确要求时使用。
- **`gh`**：`auth_status` / `pr_list` / `pr_view` / `pr_diff` / `pr_checks` /
  `issue_list` / `issue_view` / `pr_create`（title、body，可选 base、draft）。
  通过本机 GitHub CLI 执行（需 `gh auth login`），工具本身不保存 token；列表/详情走
  `--json` 结构化输出。`pr_create` 属写操作，只在用户明确要求时调用。

两个工具的每次调用同样写入 `<data_dir>/logs/shell-audit.jsonl`（含 `tool` 字段），
并共享 `run_command` 的配置开关与输出/超时护栏。

### 沙箱执行（run_sandboxed）

需要运行不可信代码时，用 `run_sandboxed` 而不是 `run_command`——它把命令关进**操作系统级沙箱**
（实现在独立 `src-tauri/src/sandbox/` 包：`mod.rs` 平台分派、`windows.rs` AppContainer、`unix.rs` bwrap/seatbelt；
工具层只做参数与审计适配）：

| 平台 | 后端 | 隔离 |
|------|------|------|
| Windows | AppContainer（每用户 profile `MindBase.Sandbox`，icacls 只授权沙箱目录） | 无网络（无 internetClient 能力）；文件只读写 `<data_dir>/agent-files/<agent>/sandbox/` + 系统目录只读 |
| Linux | bubblewrap（`bwrap --unshare-net`） | 独立 net/pid 命名空间；只 bind 沙箱目录为可写 /work |
| macOS | sandbox-exec（seatbelt） | deny network*；只允许系统目录只读与沙箱目录读写 |

- 工作流：先用 `write_file` 把脚本写到相对路径 `sandbox/xxx.ps1`（= 沙箱目录），再用
  `run_sandboxed` 执行；命令 cwd 固定为沙箱目录，**读不到数据目录、密钥库和用户文件**。
- **网络可配**：默认 `network: "off"`（断网）。需要联网的代码（pip/npm 安装、调用 API）传
  `network: "on"`：Windows 仅把 AppContainer 的 internetClient 能力加回 token（文件隔离不变），
  Linux 去掉 `--unshare-net`，macOS 用 `allow network*`；仍只读写沙箱目录。
- 注意：Windows AppContainer 不允许 loopback，因此沙箱内**不走应用里配置的本地代理**（127.0.0.1），
  `network=on` 为直连；需要代理时请使用非 loopback 的代理地址。
- Windows 支持 `pwsh`（powershell.exe，默认）与 `cmd`；Linux / macOS 只支持 `bash`。
- 超时默认 120s（1s–600s），到点用 Job Object / 进程组强杀整棵进程树；
  输出与 `run_command` 一致：stdout/stderr 直接写 `<data_dir>/logs/exec/` 日志文件，工具只回传头/尾摘要，
  完整内容用 `read_file` 的 offset/limit 分段读取；每次执行写 `<data_dir>/logs/shell-audit.jsonl`（含 backend 字段）。
- 未安装 bubblewrap 时 Linux 返回明确安装提示；Windows AppContainer 无需额外依赖。
- 复用库调研（rappct / heel / skarn-sandbox / birdcage）与取舍见
  [docs/desktop-rust-architecture.md](../docs/desktop-rust-architecture.md) §8；当前 Windows 后端为 windows-rs 自实现
  （rappct 0.13 的启动路径在本机 Windows 11 25H2 稳定 E_INVALIDARG，未采用）。

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
   local harness (`src-tauri/src/agent/harness/`): an orchestrator picks the agent (only `chat` is
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

## 测试布局

测试分两层，避免端到端测试散落在每个源码文件里：

| 层 | 位置 | 内容 |
|---|---|---|
| 单元测试 | 源码内联 `#[cfg(test)] mod tests` | 纯函数 / 解析器 / 状态机（需要访问私有实现） |
| 端到端（集成）测试 | **包内 `src-tauri/tests/`** | 工具执行、沙箱、文件系统、config/db、切块、Markdown 消毒、quiz 解析等跨模块行为 |

`tests/` 按域分包（每个子目录 `main.rs` 是 Cargo 自动发现的独立测试 crate）：

```text
tests/
├── common/mod.rs        # 纯 std 共享辅助（临时目录 / 命令串 / 临时 git 仓库）
├── toolkit/             # 非 agent：process / shell / git / gh（14）
├── sandbox/             # 非 agent：AppContainer 隔离 + 网络策略（8，1 ignored）
├── infra/               # 非 agent：执行日志摘要/分页/配额、config 开关（5）
├── knowledge/           # 非 agent：文本切块（4）
├── workspace/           # 非 agent：笔记 Markdown 消毒、quiz 解析（6）
└── agent/               # 唯一使用 TestHarness：工具契约 / 注册表 / 门禁（7）
```

- 非 agent 测试直接调用 `pub mod toolkit` / `pub mod sandbox`，或经 `testing` 的只读包装
  （`summarize_log` / `read_log_slice` / `prune_logs` / `chunk_text` / `sanitize_markdown` /
  `parse_quiz_questions`）访问 `pub(crate)` 逻辑，**不初始化 harness**。
- 运行：`cd src-tauri && cargo test`（全部）；只跑单测 `cargo test --lib`；
  只跑某域 `cargo test --test toolkit` / `--test sandbox` / `--test infra` …
- 新增端到端用例按域放进 `tests/<domain>/`；纯函数/私有实现单测仍留在源码内联（Rust 惯例）。

## 自动化任务（长时任务）

AI 可以用 `automation_start` 启动长任务（训练 / 构建 / 批处理），立即返回 `task_id`，不阻塞回合；
日志按 **任务 / 日期 / run** 落 `<data_dir>/automation/<task_id>/<YYYY-MM-DD>/*.log`，数据库只存
任务/运行/日志段指针/报告。后台调度器通过 `automation_due` 定期产出**有界上下文包**（状态 + 尾部 4KB +
日志路径），模型用 `automation_status` / `automation_log_search` / `automation_log_read` 按需查看，
失败可 `automation_retry`（受 max_attempts 限制），`automation_kill` 终止；应用重启会把遗留任务标记
`interrupted`，不会误以为还在运行。`usage_stats` 统计近 N 天的输入/输出/缓存命中/合计 token（按模型、会话、天），
详见 [docs/automation.md](../docs/automation.md)。

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

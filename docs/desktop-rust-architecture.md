# 桌面端 Rust 分包架构（mind-base-desktop）

> 范围：`mind-base-desktop/src-tauri/src/`。本文是该目录的唯一结构规范；
> 新增模块、拆分大文件、跨包调用前先读这里。

## 1. 为什么要分包

重构前：`src/` 是 36 个平铺的 `.rs` 文件 + 2 个目录（51 个文件、36,467 行），最大的单文件
2,763 行（`harness/tools.rs`），`lib.rs` 同时承担启动、托盘、插件与 125 个命令注册。
任何功能都要在平铺文件里找，职责边界只能靠记忆维持。

现在：按**领域包（package）**分层，每个包一个目录 + `mod.rs` 门面；包内大文件再按内聚职责
拆成子模块。重构后 191 个文件、38,192 行（增量全部来自模块头注释与门面重导出），
**最大单文件 595 行、0 个文件超过 800 行**，`lib.rs` 只剩 31 行包声明。

## 2. 包清单与依赖方向

```
app         Tauri 外壳：Builder、启动装配、托盘、IPC 命令注册
├── workspace   用户文档域：笔记 / 测验 / 思维导图 / 科研 / 手稿 / 文献 / 数据集
├── agent       本地 AgentHarness：ReAct 循环、工具、会话、skills
├── knowledge   知识链路：B 站获取 → 转写 → 切块 → 向量 / 混合检索
├── media       本地媒体运行时：ASR（云端 + whisper）、OCR、ffmpeg、缓存
├── llm         出站模型访问：provider 目录、密钥、chat client、embedding、rerank
└── infra       本地基础设施：SQLite、配置、日志、嵌入式 Python、更新器
```

主依赖方向（新代码按此写）：

```
app  →  workspace / agent  →  knowledge / media  →  llm  →  infra
```

- `app` 只做装配与命令注册，不写业务逻辑（这也是 `lib.rs` 只剩包声明的原因）。
- `agent` 与 `workspace` 同层，允许互调：工具层会调 `workspace::notes` / `workspace::quiz` 的
  domain 函数，`workspace::research` 会取 `agent::prompts` 的提示词。
- `knowledge` / `media` 互不依赖：`knowledge::ingest` 需要转写就调 `media::asr`，`media` 不知道
  「知识库」的存在。
- `infra` 是地基，原则上不反向依赖业务包。

**已知例外（本次重构是「只搬家、不重写」，历史耦合原样保留；新代码不要模仿）**

| 位置 | 依赖 | 原因 / 后续方向 |
|------|------|----------------|
| `infra/config.rs` | `llm::api_keys`、`media::ocr_server` | 配置校验需要代理地址规范化 + OCR 模型清单；可下沉为纯字符串校验 |
| `infra/db/schema.rs` | `knowledge::vectors::index_tokens` | FTS 回填复用切词；应把切词下沉 `infra` 或共享类型 |
| `infra/db/memory.rs` | `agent::agents::SearchWindowEntry` | 记忆窗口 DTO 历史落点在 agents；可下沉为共享 DTO |
| `infra/updater`、`infra/python_runtime` | `llm::api_keys::egress_agents` / `child_proxy_env` | 所有出站流量统一走代理；应抽到 `infra/net` |
| `llm/rerank.rs` | `knowledge::vectors::SearchHit` | 只依赖数据类型；可下沉共享 DTO |
| `llm/api_keys/e2e.rs` | `media::asr`、`media::whisper_server`、`media::ffmpeg` | 「测试供应商配置」诊断模块，天然跨包 |
| `workspace/research/commands.rs` | `agent::prompts` / `agent::agents` | 科研阶段提示词复用 agent 的默认提示词 |

这些例外都在模块边界处单点出现，包内没有反向依赖扩散；消除它们属于后续「依赖收口」工作，
不是本次目录重构的范围。

## 3. 目录结构

```
src/
├── main.rs                 # 二进制入口（5 行，只调 lib::run）
├── lib.rs                  # 包声明 + run() 转发到 app::run()
├── app/                    # Tauri 外壳
│   ├── mod.rs              # Builder 组装（插件 / setup / window_event / run）
│   ├── setup.rs            # 启动装配：DB、日志、prompts、ffmpeg、代理、托盘、ASR 预热
│   ├── tray.rs             # 托盘图标 + reveal_main
│   └── commands.rs         # 唯一的 IPC 注册表（按包分组，125 个命令）
├── agent/                  # Agent 域
│   ├── harness/            # 五件套 + ReAct + 计划/交互/健康检查/子代理
│   │   ├── mod.rs          #   Harness 单例 + 门面
│   │   ├── lifecycle.rs / orchestrator.rs / registry.rs / runtime.rs
│   │   ├── scheduler.rs / tasks.rs
│   │   ├── plan.rs / interaction.rs / prompt.rs / health.rs / react.rs / subagent.rs
│   │   └── tools/          #   工具族：knowledge / session_store / memory / context /
│   │                       #   web / files / notes / vision / artifacts / delegate / …
│   ├── chat/               # 会话：types / sessions / history / context / images /
│   │                       #        streaming / summary
│   ├── skills/             # skills：paths / parse / state / commands / store / install
│   ├── agents.rs           # AgentKind 描述符
│   ├── prompts.rs          # 提示词默认值（include_str! 自 src-tauri/prompts）
│   └── web_search.rs       # 联网搜索工具
├── knowledge/              # 知识链路
│   ├── bilibili/           # login / favorites / content / wbi
│   ├── ingest/             # pipeline / pages / transcribe / audio / documents / search
│   ├── file_ingest/        # scan / extract / ocr / documents / pipeline
│   ├── vectors/            # store / search / fts / commands / tests
│   ├── web_capture.rs      # URL 抓取入库
│   └── chunker.rs          # 规则语义切块
├── media/                  # 媒体运行时
│   ├── asr/                # config / types / parse / upload / client / realtime / wav / local
│   ├── whisper_server/     # models / download / process / commands
│   ├── ocr_server.rs
│   ├── ffmpeg.rs
│   └── media_cache.rs
├── llm/                    # 模型访问
│   ├── api_keys/           # validation / status / catalog / proxy / probe / e2e
│   ├── client/             # types / stream / openai / anthropic / usage / vision
│   ├── ai_providers.rs
│   ├── embeddings.rs
│   └── rerank.rs
├── workspace/              # 用户文档域
│   ├── notes/              # types / markdown / revisions / anchors / store / commands
│   ├── quiz/               # types / parse / generate / grade / history / sets / commands
│   ├── mindmap/            # types / crud / snapshots / templates / icons
│   ├── research/           # types / store / briefing / commands
│   ├── literature/         # types / store / util / bibtex / csl / crossref / commands
│   ├── dataset/            # types / store / import / analysis / commands
│   ├── manuscript.rs
│   ├── resume.rs
│   └── slides.rs
└── infra/                  # 基础设施
    ├── db/                 # schema / migrations / connection / data_dir / memory / commands
    ├── python_runtime/     # layout / provision / onnx / download / scripts
    ├── updater/            # types / github / download / install / plugin / commands
    ├── config.rs
    ├── logging.rs
    └── store.rs
```

> 每个拆分过的模块都是「`mod.rs` 门面 + 子模块」：门面只做声明与重导出，不写业务逻辑。

## 4. 包内拆分约定

大文件不要平铺增长，按职责拆成目录 + `mod.rs` 门面：

```
knowledge/ingest.rs  →  knowledge/ingest/
                          ├── mod.rs        # pub(crate) use 重导出既有接口（调用方无感）
                          ├── pipeline.rs   # 入库编排
                          ├── transcribe.rs # 转写 + 音频准备
                          └── documents.rs  # documents 表读写
```

硬性要求：

1. **只搬家不重写**：拆分是代码移动，函数体、测试断言、错误文案保持不变。
2. **门面保持稳定**：`mod.rs` 用 `pub(crate) use` 重导出原本被其它模块引用的条目，
   调用方路径（如 `crate::knowledge::ingest::ingest_video`）不得变化。
3. **可见性最小化**：子模块默认私有（`mod x;`），只有跨模块条目才 `pub(crate)`。
4. **测试跟着被测代码走**：`#[cfg(test)] mod tests` 移到拥有被测条目的子模块；
   跨子模块的集成测试放专门的 `tests.rs`。
5. **每个子模块一个 `//!` 头注释**：一句话说明职责，不写流水账。
6. **单文件 ≤ 500 行**（硬上限 800）。超过说明还能再拆。

## 5. 新增功能的落位

| 要加的东西 | 落位 |
|-----------|------|
| 新的 Tauri 命令 | 领域包内实现 `pub fn`，再到 `app/commands.rs` 注册 |
| 新的 provider / 模型调用 | `llm/`（不要散建 `ureq`/HTTP client，走已有 agent 工厂） |
| 新的入库来源 | `knowledge/`（编排进 `ingest`，来源适配器单独文件） |
| 新的文档类型 | `workspace/<kind>.rs`，并在 `workspace/mod.rs` 声明 |
| 新的本地 sidecar | `media/`（进程管理 + 健康探测成套放同一子模块） |
| 表 / 配置 / 日志 / 路径 | `infra/`（不要在业务包里直接拼 SQL/路径） |

## 6. 验证

```bash
cd mind-base-desktop/src-tauri
cargo check --all-targets    # 必须 0 error
cargo test --lib             # 基线：269 passed / 3 ignored
```

前端不用动；`npm run tauri build` 前先确保以上两条通过。

## 7. 重构结果（2026-10-29）

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| `src/` 下 .rs 文件数 | 51 | 191 |
| 代码总行数 | 36,467 | 38,192（+模块头/门面重导出，无逻辑新增） |
| 最大单文件 | 2,763（harness/tools.rs） | 595（knowledge/bilibili/login.rs） |
| > 800 行的文件 | 18 | 0 |
| > 500 行的文件 | 20 | 5 |
| `lib.rs` | 280（含启动/托盘/命令注册） | 31（只做包声明） |
| 包（目录）数 | 2 | 7 + 每个已拆模块的子包 |
| `cargo test --lib` | 269 passed / 3 ignored | 269 passed / 3 ignored（不变） |

拆分原则：**只搬家、不重写**——函数体、错误文案、注释与测试断言逐行保留；门面重导出保证
所有既有 `crate::<pkg>::<mod>::<item>` 路径与 `app/commands.rs` 的 `generate_handler!`
注册不变（`#[tauri::command]` 生成的 `__cmd__*` 宏也一并重导出）。

> 下次再出现 > 500 行的文件，按 §4 的约定就地拆成「门面 + 子模块」，不要让它长回去。

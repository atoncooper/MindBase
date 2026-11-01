# 桌面端 Rust 分包架构（mind-base-desktop）

> 范围：`mind-base-desktop/src-tauri/src/`。本文是该目录的唯一结构规范；
> 新增模块、拆分大文件、跨包调用前先读这里。

## 1. 为什么要分包

重构前：`src/` 是 36 个平铺的 `.rs` 文件 + 2 个目录（51 个文件、36,467 行），最大的单文件
2,763 行（`harness/tools.rs`），`lib.rs` 同时承担启动、托盘、插件与 125 个命令注册。
任何功能都要在平铺文件里找，职责边界只能靠记忆维持。

现在：按**领域包（package）**分层，每个包一个目录 + `mod.rs` 门面；包内大文件再按内聚职责
拆成子模块。重构后 199 个文件、40,776 行（增量全部来自模块头注释、门面重导出与沙箱包），
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
app  →  workspace / agent  →  repositories  →  infra
              └→  knowledge / media  →  llm  →  infra
                              agent  →  sandbox（OS 隔离原语）
```

- `app` 只做装配与命令注册，不写业务逻辑（这也是 `lib.rs` 只剩包声明的原因）。
- `agent` 与 `workspace` 同层，允许互调：工具层会调 `workspace::notes` / `workspace::quiz` 的
  domain 函数，`workspace::research` 会取 `agent::prompts` 的提示词。
- `knowledge` / `media` 互不依赖：`knowledge::ingest` 需要转写就调 `media::asr`，`media` 不知道
  「知识库」的存在。
- `repositories` 是数据访问层：已迁移域（科研 / 写作 / 文献 / 数据 / 实验）的 **SQL 只写在
  `repositories/`**，`workspace` / `agent` 只调用类型化函数；业务不变式（如阶段单 active）放
  `workspace` 的 service 层。
- `infra` 是地基，原则上不反向依赖业务包。
- `sandbox` 是独立的 OS 隔离原语包（AppContainer / bubblewrap / seatbelt），只依赖
  标准库 + `windows` crate，可被任意上层复用；它不感知 agent / tools / 配置。
- `toolkit` 是与 agent 无关的工具执行层（process / shell / git / gh），被
  `agent::harness::tools` 的薄适配器调用；它的测试直接打包 API，不需要 harness。

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
| `repositories/research/*` | `workspace::research` 的纯 DTO（`ResearchEvent` 等） | 复用数据结构避免重复定义；不调用业务函数，后续可下沉共享 DTO |

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
├── automation/             # 长时自动化任务（supervisor / log_index / report / scheduler）
├── toolkit/                # 与 agent 无关的工具执行层
│   ├── mod.rs              #   包说明与依赖方向
│   ├── process.rs          #   子进程执行 / 输出落文件 / 超时杀树 / 审计
│   ├── shell.rs            #   pwsh / cmd / bash 构造与断网包装
│   ├── git.rs              #   git action 参数构造与执行
│   └── gh.rs               #   gh action 参数构造与执行
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
│   ├── research/           # types / briefing / service / commands（SQL 在 repositories）
│   ├── literature/         # types / util / bibtex / csl / crossref / commands（SQL 在 repositories）
│   ├── dataset/            # types / import / analysis / commands（SQL 在 repositories）
│   ├── manuscript.rs
│   ├── resume.rs
│   └── slides.rs
├── repositories/           # 数据访问层（repository pattern：所有 SQL）
│   ├── mod.rs              # RepoResult/RepoError + query_all/query_optional/query_one/execute/count
│   ├── research/           # projects / stages / events / artifacts / guidance / stats
│   ├── manuscript.rs
│   ├── literature.rs
│   ├── dataset.rs
│   └── experiment.rs
└── infra/                  # 基础设施
    ├── db/                 # schema / migrations / connection / data_dir / memory / commands
    ├── python_runtime/     # layout / provision / onnx / download / scripts
    ├── updater/            # types / github / download / install / plugin / commands
    ├── ssh/                # mod / types / client / fingerprint / hosts / exec / test / session
    ├── config.rs
    ├── secret.rs           # 凭据保护（keyring 4：Win CredMgr / macOS Keychain / Linux Secret Service；DPAPI 仅历史迁移；不可用时 plain: 降级告警）
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
| 新的 SQL / 表读写 | `repositories/`（一个表或聚合一个文件；业务不变式放 `workspace` 的 service） |
| 配置 / 日志 / 路径 | `infra/`（不要在业务包里直接拼路径；SQL 走 `repositories`） |
| 新的 OS 隔离 / 进程执行原语 | `sandbox/`（按平台加后端，工具层只做适配） |
| 新的通用命令/Git 执行能力 | `toolkit/`（纯实现；agent 工具只做 LocalTool 适配） |
| 新的长任务/自动化能力 | `automation/`（日志分区 + supervisor + 报告节奏；工具层只做适配） |

## 6. 验证

```bash
cd mind-base-desktop/src-tauri
cargo check --all-targets    # 必须 0 error
cargo test --lib             # 基线：296 passed / 3 ignored
```

前端不用动；`npm run tauri build` 前先确保以上两条通过。

## 7. 重构结果（2026-10-29）

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| `src/` 下 .rs 文件数 | 51 | 199 |
| 代码总行数 | 36,467 | 40,776（+模块头/门面重导出/沙箱包，无逻辑新增） |
| 最大单文件 | 2,763（harness/tools.rs） | 595（knowledge/bilibili/login.rs） |
| > 800 行的文件 | 18 | 0 |
| > 500 行的文件 | 20 | 6 |
| `lib.rs` | 280（含启动/托盘/命令注册） | 31（只做包声明） |
| 包（目录）数 | 2 | 7 + 每个已拆模块的子包 |
| `cargo test --lib` | 269 passed / 3 ignored | 269 passed / 3 ignored（不变） |

拆分原则：**只搬家、不重写**——函数体、错误文案、注释与测试断言逐行保留；门面重导出保证
所有既有 `crate::<pkg>::<mod>::<item>` 路径与 `app/commands.rs` 的 `generate_handler!`
注册不变（`#[tauri::command]` 生成的 `__cmd__*` 宏也一并重导出）。

> 下次再出现 > 500 行的文件，按 §4 的约定就地拆成「门面 + 子模块」，不要让它长回去。

## 8. 沙箱实现与复用库调研（2026-10-30）

沙箱独立为 `sandbox/` 包（`mod.rs` / `windows.rs` / `unix.rs`），工具层
`agent::harness::tools::sandbox` 只做参数解析 / 开关 / 审计；OS 隔离实现可被其它上层复用。

调研的现成 Rust 库：

| crate | 版本/活跃度 | 覆盖平台 | 结论 |
|-------|------------|----------|------|
| `rappct` | 0.13.3，2026-10，41k dl，MIT | Windows AppContainer/LPAC + 能力 + 进程启动 + ACL | **评估后未采用**：其 `launch_in_container_with_io` 在本机（Windows 11 25H2 / build 26200）稳定返回 `E_INVALIDARG (0x80070057)`，连最简单的 `cmd /C echo` 也失败；保留 windows-rs 自实现，rappct 可等上游修复后再替换 |
| `heel` | 0.7.1，2026-10 | macOS seatbelt / Linux Landlock+seccomp / Windows AppContainer+Job | 覆盖面最好且带网络策略（DenyAll/代理白名单），但依赖树重（hyper/smol/pty 等）、较新，暂不引入；可作后续跨平台替换候选 |
| `skarn-sandbox` | 1.0.1，2026-09 | macOS seatbelt / Linux Landlock+seccomp / Windows AppContainer | 统一 Policy API，但下载量小（5k）、需要外部 worker，暂不引入 |
| `birdcage` | 0.8.1，157k dl | Linux Landlock+seccomp / macOS seatbelt（Windows 不支持） | Linux/macOS 可用它替换 bwrap/sandbox-exec 依赖，但无法在当前 Windows 环境验证，暂不引入 |
| `nono` / `hakoniwa` / `landlock` | — | Linux（部分 macOS） | 平台单一，不满足 Windows |

当前实现：
- Windows：windows-rs 直接 `CreateAppContainerProfile` + `SECURITY_CAPABILITIES`（network=on 时加
  internetClient `S-1-15-3-1`）+ 可继承管道 + Job Object 超时杀进程树；沙箱目录用 `icacls` 授权给
  AppContainer SID。
- Linux/macOS：bubblewrap / sandbox-exec，系统工具缺失时明确报错。

> 后续若 `rappct` 修复启动问题或 `heel` 成熟，可只替换 `sandbox/windows.rs` / `sandbox/unix.rs`，
> 工具层与包接口不变（这是分包的主要收益）。

### 执行输出：落文件 + 摘要，不经过内存

命令类工具（`run_command` / `git` / `gh` / `run_sandboxed`）的 stdout/stderr **直接重定向到**
`<data_dir>/logs/exec/` 下的文件（`infra/exec_log.rs` 统一管理路径、头 2KB + 尾 4KB 摘要、
64MB/200 文件保留策略与按字节分段读取）；工具只回传摘要与日志路径，模型需要全文时用 `read_file`
的 `offset`/`limit` 分段读取。这样大输出（构建日志、批量 diff、训练输出）不会堆在内存或上下文里。

## 9. 测试分层（2026-10-30）

标准 Rust 布局：**单元测试内联 + 包内 `tests/` 集成测试**；`tests/` 再按域分包
（每个子目录的 `main.rs` 被 Cargo 自动识别为一个独立测试 crate）。

```text
tests/
├── common/mod.rs        # 只含 std 辅助（不引用 agent/harness）
├── toolkit/             # process / shell / git / gh
├── sandbox/             # appcontainer / network
├── infra/               # exec_log / config
├── knowledge/           # chunker
├── workspace/           # notes markdown / quiz parse
└── agent/               # 工具契约（唯一使用 TestHarness）
```

分层规则：
- **非 agent**（toolkit / sandbox / infra / knowledge / workspace）：直接调用 `pub mod toolkit`、
  `pub mod sandbox`，或经 `src/testing.rs` 的只读包装访问 `pub(crate)` 逻辑
  （exec_log 摘要/分页/配额、chunker、markdown 消毒、quiz 解析），不初始化 agent；
- **agent 层**（`tests/agent`）：配置开关、工具注册表、cwd 边界、输出摘要、read_file 分页，
  只有这一类测试使用 `TestHarness`；
- **单测**：纯函数 / 解析器 / 需要私有实现的逻辑仍内联 `#[cfg(test)] mod tests`（语言惯例，
  集成测试只能看到 `pub` API）。

命中数（2026-10-30）：单测 276（273 passed / 3 ignored）+ tests/ 44（43 passed / 1 ignored）
= **320 tests，0 failed**。基线命令：`cargo test`（CI 同命令）；单域 `cargo test --test <domain>`。

## 10. Agent 协同与透明化（2026-10-31）

拓扑是「星型 + 一层再委托」，不是 mesh：

| 层 | 可以委托谁 | 说明 |
|---|---|---|
| chat（顶层，对用户透明） | memory / note / code / search / academic / research | 用户只看到「助手处理中」，不暴露主 agent 身份 |
| academic / research（子代理） | search / memory | 只能再委托一层；孙代理不能继续委托（结构性上限） |
| 其他子代理 | — | 无 delegate 通道 |
| 主 agent 自建 agent | 运行时不限（chat 工具集） | create_agent 持久化「名字 + 角色提示词」，之后 delegate_to_agent 按名字复用；list_agents 查看 |

共享机制：

- 同一 session_id：历史、记忆窗口、向量检索、文件目录；
- 委托成功自动写 session findings（黑板），所有带 get_session_findings 的 agent 可读；
- 子代理步骤以 SubStep 事件推给前端；token 用量合并回父回合；
- 同一目标连续失败 2 次熔断（避免委托风暴）。

前端可见性（默认安静，有运行才出现）：

- 主 agent 名字默认隐藏，只显示进度/动作；
- 顶栏只在「有子代理或后台任务在跑」时出现一个轻量入口（N 个 agent 运行中），
  点开仅显示运行中的子代理与后台任务（可停止），空闲时完全不渲染；
- 子代理运行结束发 AgentRun 事件（agent / ok / duration_ms / steps / usage），
  前端按 agent 聚合为助手消息脚注：次数 · 总耗时 · 步数 · token；
- 后台任务 TaskView 增加 usage（token 用量）与 elapsed/steps，面板可见；
- 后台任务弹窗不再让用户选 agent，统一由主 agent（chat）调度；
- 自定义 agent（create_agent）：存 SQLite（custom_agents 表），委托时把角色提示词包成任务说明，
  与聊天共享 session/知识库/文件；可用 list_agents 列出内置 + 自定义 agent；
- 学术工具（academic/research 可用）：
  academic_literature（Crossref 检索 / 文献列表 / BibTeX·CSL 导入 / BibTeX 导出 / 单条核验）、
  academic_project（项目列表 / 简报 / 阶段流转）、
  academic_manuscript（章节列表 / 读取 / 写入，正文落 manuscript/sections/*.md）、
  academic_evidence（数据集列表 / 数据文件导入含 Python 画像 / 分析脚本执行 / 实验记录列表 / 登记实验运行）、web_search；
  科研工作台的 research_ask 已从单次 completion 升级为 ReAct（同一套工具 + 项目简报注入）；
- 后台任务仍可独立运行，不阻塞当前对话。

## 11. 数据访问层 repositories（2026-10-31）

**规则：SQL 只写在 `src/repositories/`。** 业务层（`workspace` / `agent` 工具 / Tauri 命令）只调用
类型化函数；repository 不做业务校验 / 流程编排。

### 11.1 目录与职责

```
repositories/
├── mod.rs          RepoResult/RepoError + SQLx 风格辅助函数
├── research/       projects / stages / events / artifacts / guidance / stats
├── manuscript.rs   manuscript_sections
├── literature.rs   literature_refs / citations
├── dataset.rs      datasets
└── experiment.rs   experiment_runs
```

- 一个表（或一个聚合）一个文件；每个查询一个函数（`find_*` / `list_*` / `insert_*` /
  `update_*` / `delete_*` / `count_*`），SQL 就近写在函数里。
- 行映射函数（`xxx_from_row`）与领域 DTO 分离；repository 可复用 `workspace` 的纯 DTO，
  但不调用业务函数。
- 业务不变式（阶段单 active、字段归一化、审计事件内容）在 `workspace/research/service.rs`
  这类 service 层组合多个 repository 完成。
- repository 接收 `&rusqlite::Connection`，因此可直接传 `Transaction`（Deref 到 Connection）
  获得事务能力。

### 11.2 为什么保留 rusqlite 而不是引入 sqlx

桌面端是**离线内置 SQLite（rusqlite bundled）** + 同步 Tauri 命令；sqlx 的编译期校验需要
构建时 `DATABASE_URL` / 离线元数据，还会引入第二套连接池与异步运行时。当前做法是
「rusqlite + SQLx 风格的 repository 层」：

```rust
pub(crate) fn find(conn: &Connection, id: &str) -> RepoResult<Option<ResearchProject>> {
    query_optional(conn, "SELECT ... FROM research_projects WHERE id = ?1", params![id], project_from_row)
}
```

等价于 sqlx 的 `query_as::<_, T>(...).bind(id).fetch_optional(pool)`；错误经
`From<RepoError> for String` 在命令边界转成前端 `String`。

### 11.3 迁移状态

| 域 | 状态 |
|----|------|
| research / manuscript / literature / dataset / experiment | ✅ 已迁移（业务层 0 SQL） |
| notes / quiz / mindmap / automation / knowledge / agent 会话 / llm / infra | ⏳ 待迁移（仍按旧方式，后续逐域搬入 `repositories/`） |

`infra/db/{schema,migrations,memory,tests}.rs` 属于建表 / 迁移 / 测试夹具，不算业务 SQL。

## 12. SSH 子包与远程执行安全（2026-10-31）

SSH 从单文件 `infra/ssh.rs`（约 1080 行）拆成 `infra/ssh/` 子包，门面保持
`crate::infra::ssh::{...}` 路径不变：

| 文件 | 职责 |
|------|------|
| `ssh/mod.rs` | 门面：模块声明 + 文档 + 重导出（命令 / 类型 / 常量 / `__cmd__` 宏） |
| `ssh/types.rs` | 对外 DTO（执行结果、测试报告、会话信息、输出/关闭事件）与超时/PTY 常量 |
| `ssh/client.rs` | russh 客户端、认证（密码/私钥，凭据解密）、PTY 配置、连接建立 |
| `ssh/fingerprint.rs` | 主机指纹策略（TOFU / 匹配 / 不匹配拒绝）与指纹写回 |
| `ssh/hosts.rs` | 主机 CRUD、凭据写入系统凭据库（keyring）、被移除主机的凭据清理、指纹信任/清除命令 |
| `ssh/exec.rs` | 一次性远程执行（exec / exec_blocking / 超时夹取） |
| `ssh/test.rs` | 连通性测试（`ssh_host_test`） |
| `ssh/session.rs` | 持久交互会话（PTY shell）、会话表/可复用 Handle、读写任务、事件广播、UTF-8 分帧、会话日志接线 |
| `ssh/sftp.rs` | SFTP 文件传输（list / download / upload / mkdir / delete；复用会话 Handle 开 sftp 子系统；单文件 ≤200MB） |
| `ssh/forward.rs` | 本地端口转发（仅 local forward：127.0.0.1 → SSH direct-tcpip；abort handle 管理/会话断开清理） |
| `ssh/log.rs` | 交互会话输出日志（`<data_dir>/logs/ssh/<host>-<stamp>.log`；仅记录输出） |

### 安全模型（参考 Xshell）

- **凭据（跨平台系统凭据库）**：使用 keyring 4 统一后端——Windows Credential
  Manager / macOS Keychain / Linux Secret Service；配置/数据库只保存
  `keyring:<scope>` 引用（scope 形如 `ssh:<host>:password` / `ssh:<host>:passphrase`），
  service 固定为 `mindbase-desktop`。
  - 系统凭据库不可用（如 Linux 无 Secret Service、无桌面会话的 CI）时退化
    为 `plain:<明文>` 并 eprintln 告警（明确告知不安全），保证功能可用；
  - Windows 历史 DPAPI 密文（`dpapi:`）仍可解密（仅历史迁移用），下次保存主机
    配置时自动迁移到系统凭据库；非 Windows 遇到 `dpapi:` 视为不可用并告警；
  - 保存主机列表是全量替换：被移除的主机会删除其 keyring 两条目（best effort）；
    日志与 Agent 工具不回传密码；
  - 本机仅验证 Windows 分支；macOS/Linux 由 keyring 统一 API + 编译期 cfg 选择
    后端，**需要 CI 或真机验证**（Keychain / Secret Service 权限与会话前提）。
- **上传命令可移植**：upload 的 base64 解码兼容 GNU（`base64 -d`）、BSD/macOS
  （`base64 -D`）与 `openssl base64 -d`（按顺序回退），不再依赖 GNU 专有参数。
- **主机指纹**：每台主机保存 SHA256 指纹；交互连接/测试首次 TOFU 自动记录，
  后续不匹配拒绝连接；Agent 一次性执行**必须已固定指纹**（防 MITM）。
- **项目绑定与授权**：`SshHostConfig.projectId` 绑定科研项目，`allowAgent` 控制
  Agent 是否可用；`remote_exec` 强制校验「授权 + 指纹 + 项目绑定」。
- **上传**：`remote_exec action=upload` 只能上传项目目录内的文件（≤2MB，路径
  canonicalize 后必须在项目根内），再 `run` 执行；`run` 仍走危险命令黑名单；
  base64 解码在 GNU/BSD/macOS/openssl 环境均可用。
- **交互终端**：用户自己输入的命令不经过 Agent 黑名单（与 Xshell 一致）。
- **SFTP 文件传输**：`sftp_list / sftp_download / sftp_upload / sftp_mkdir / sftp_delete`
  复用当前交互会话的 SSH Handle（`LiveSession.handle`）打开 sftp 子系统；单文件
  上限 200MB；只支持删除文件（目录删除拒绝）；上传要求远端父目录已存在；错误、
  未知会话均为中文提示。
- **本地端口转发**：`ssh_forward_add / ssh_forward_remove / ssh_forward_list`，仅
  **local forward**（绑 127.0.0.1:localPort → SSH 隧道 → remoteHost:remotePort，
  tokio copy_bidirectional）；每条转发保存 abort handle，remove 释放监听端口，会话
  断开时自动清理全部转发。remote forwarding / SOCKS 暂不支持（后续按需扩展）。
- **会话日志**：`SshHostConfig.logSession`（默认 false）开启后，交互会话在
  `<data_dir>/logs/ssh/<host>-<stamp>.log` 记录头部（UTC 时间/主机/用户）与终端
  原始输出；路径通过 `SshSessionInfo.logPath` 只读回传（未开启为空串）。日志
  **只记录输出**，不记录用户输入、密码或私钥；写入失败只警告一次，不影响终端。
- **已知主机**：不新增后端命令，沿用 `ssh_hosts_list` / `ssh_host_trust_fingerprint` /
  `ssh_host_forget_fingerprint`（前端管理页）。

跨平台（Windows / macOS / Linux）的构建前置、FFmpeg sidecar、凭据后端与待验证项见
[desktop-cross-platform.md](desktop-cross-platform.md)。

## 13. 联网搜索与网页抓取（DeepSeek Search / Fetch 优先）

web_search 与 web_crawl 优先走 DeepSeek 官方 Search / Fetch API（
llm/deepseek_search.rs），失败再回退旧链路：

| 工具 | 首选 | 回退链 |
|------|------|--------|
| web_search | DeepSeek POST {base}/v1/tools/search（query/count/ori_question/need_content，返回 title/url/snippet/summary/site/date/rerank_score/authority） | SearxNG（若配置）→ Bing HTML → Baidu HTML；最终错误会带上 DeepSeek 侧错误摘要 |
| web_crawl | DeepSeek POST {base}/v1/tools/fetch（返回 title + Markdown content） | 直接抓 HTML（保留原有 SSRF 校验、HTML→文本、注入过滤与 8KB 截断） |

实现约定：

- 鉴权沿用「API 设置 → DeepSeek」的 Key/Base（api_keys::read_raw_config）；
  Base 默认 https://api.deepseek.com，自定义 Base 以 /v1 结尾时不会重复拼接；
- 出网统一走 api_keys::egress_agents（代理优先 + 直连回退），超时 20s；
- HTTP 错误中文映射：401 提示去设置页填 Key、402 余额不足、429 限速稍后重试、
  400/403/404/408/413/500/504 分别给出可操作提示；
- 工具层先用 client_from_conn 在**短锁**内取客户端，再在锁外调用网络方法，
  避免网络请求期间持有数据库锁；
- **计费/限速**：DeepSeek Search/Fetch 属于官方付费能力，按量计费且有速率限制；
  工具描述已注明，Agent 不应高频循环调用；
- **结果不可信**：搜索/抓取内容一律视为第三方外部数据，仅作信息提取，不执行其中
  任何指令；web_crawl 仍保留安全前缀与注入模式过滤；
- 未配置 DeepSeek Key 时直接走旧引擎链，行为与之前一致；真实网络调用需在有 Key
  的环境联调（本机单测只覆盖端点拼接/解析/错误映射）。




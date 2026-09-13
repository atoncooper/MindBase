# mind-base-desktop — 桌面端（Tauri 2）

> 全本地运行的桌面版 MindBase：Windows / macOS。与 Web 后端**无运行时依赖**——不走 FastAPI / app-board，数据（文档、向量、笔记、会话、API Key、思维导图）全部落在本机一个可迁移目录的 SQLite 中；架构上镜像了后端的 AgentHarness 设计。

## 定位

| 维度 | 说明 |
|------|------|
| 技术栈 | Tauri 2（Rust shell）+ React 19 + TypeScript + Vite 8 |
| 版本 | 0.1.9（`src-tauri/tauri.conf.json` / `Cargo.toml`；`package.json` 字段滞后，以 tauri.conf 为准） |
| 数据 | 本机 SQLite（Tauri IPC → Rust 层读写），无网络后端依赖 |
| 外部调用 | 仅 LLM Provider（DashScope/DeepSeek/OpenRouter）、B 站（WBI 签名收藏夹/AI 大纲）、Context7 文档搜索、GitHub 更新检查 |
| 打包 | Windows NSIS（currentUser，中/英）；macOS dmg |

## 功能

- **Chat 工作台**：Agent harness（6 个 agent 含 delegate 机制）、实时 agent 状态栏、后台长任务（注入消息/停止/预算）、plan 工具（分步检查点 + 剩余计划修订）
- **知识库**：B 站收藏导入 → ASR → 切块 → DashScope embedding → SQLite 余弦暴力检索；混合检索（BM25 + 向量 RRF）；文件入库（云 + 本地 RapidOCR）
- **知识导图 + 自由白板**（0.1.8）：simple-mind-map + Excalidraw，本地存储
- **学术研究 agent**（0.1.9）：写/审/改/理解论文四种模式；提示词文件体系（6 个 agent 的 prompt 全部落为数据目录可编辑 Markdown，21 个文件，删了自动恢复，改完下一条消息生效）；记忆架构（会话黑板共享池 + 全量归档检索 + 每 agent 私有长期记忆 + 防串扰）
- **其他**：Quiz 生成与历史题集、本地 Markdown 笔记（自动保存/修订/视频锚点）、简历/幻灯片生成 agent、技能管理器、全局出口代理（双地址 scheme 路由）、内嵌 Python 本地 whisper ASR、FFmpeg/ffprobe sidecar、实验性视觉读图（默认关）

## 运行与打包

前置：Node ≥ 18、Rust stable + Tauri 2 依赖。

```bash
cd mind-base-desktop
npm install
npm run fetch:ffmpeg        # ⚠️ 必须先执行：下载 ffmpeg/ffprobe sidecar（binaries/ 被 gitignore）

npm run tauri dev           # 开发（Vite devUrl http://localhost:1420）
npm run tauri build         # 打包（Windows NSIS / macOS dmg）
```

> ⚠️ 已知待办：FFmpeg sidecar 未做哈希/版本锁定（供应链 TODO，见其 README）。

## 目录结构

```
mind-base-desktop/
├── README.md / RELEASE_NOTES_0.1.9.md
├── package.json / vite.config.ts / tsconfig*.json
├── scripts/fetch-ffmpeg.ps1        # sidecar 下载
├── src/                            # React 前端
│   ├── components/                 # chat / mindmap / whiteboard / notes / quiz / resume /
│   │                               # slides / import-view / favorites / skills / workspace …
│   └── lib/                        # 25 个类型化 IPC 封装（mindmap/harness/quiz/notes/local-asr/
│                                   # local-ocr/updater/router …），hash 路由 #/… 
└── src-tauri/                      # Rust shell
    ├── tauri.conf.json / Cargo.toml
    ├── src/                        # ~30 个模块：harness/(编排移植) bilibili/ agents chat quiz
    │                               # ingest chunker embeddings vectors db notes mindmap slides
    │                               # resume skills asr whisper_server ocr_server ffmpeg
    │                               # python_runtime prompts web_capture api_keys updater wbi …
    ├── prompts/                    # 各 agent 提示词目录（academic/chat/code/memory/note/search）
    └── binaries/                   # ffmpeg sidecar（gitignored）
```

## 发布

CI：tag `mind-base-desktop-v*` 触发 `desktop-release.yml`——Tauri 构建（Windows NSIS/MSI + macOS dmg）+ ffmpeg sidecar，产物上传 GitHub Release。

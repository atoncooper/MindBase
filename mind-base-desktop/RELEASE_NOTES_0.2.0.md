# MindBase Desktop 0.2.0

> 桌面端「科研工作台 + SSH 远程 + 对话体验」版本：科研控制台补齐 repositories 数据层、AI 选刊与 AI 计划、论文导入与原生 Word/PDF 展示、Google Docs 风格写作；SSH 升级为独立包，支持主机管理、交互终端、SFTP、本地端口转发、会话日志与跨平台凭据；对话新增思考过程、消息排队、DeepSeek 官方搜索，并修复工具参数泄漏与空回复。

## ✨ 新功能

### 🔬 科研工作台
- **数据层重构**：新增 repositories 层（research / manuscript / literature / dataset / experiment），SQLx 风格查询封装，业务层不再散落 SQL；研究项目/阶段/事件/产物/文献/数据/实验/稿件全部走仓储访问。
- **AI 选刊**：项目信息「目标期刊」支持「AI 推荐期刊」，结合项目标题、类型、领域、截止时间与已登记文献的投稿渠道，返回 3–5 个候选（匹配度 + 推荐理由），一键采纳写回。
- **AI 研究计划**：按阶段生成目标、任务、交付物、验收标准、风险与建议提问，持久化到项目；任务可勾选，也可让 AI 按计划逐项执行并回填完成状态。
- **论文导入**：支持 PDF / DOCX / MD / TXT / TeX / LaTeX / HTML，自动拆章节创建写作文档；保留原文件到项目 imported/，可随时回到原生文档。
- **DOCX 解析升级**：按文档顺序解析段落与表格，标题样式转 Markdown 标题；表格输出标准 Markdown；Word 公式（OMML）转 LaTeX（分数、上下标、根式、求和/积分、括号、矩阵、多行等）；导入 Word/PDF 时自动解析参考文献并写入项目文献库（待核验）。
- **原生文档优先展示**：导入的 Word 用 docx-preview 按原版式渲染（表格、图片、公式、页眉页脚），PDF 逐页渲染；原生渲染失败才自动回退「文本视图」，Markdown 仅作备胎。
- **文件与数据**：文件 tab 左右卡片等高对齐、内部滚动；支持导入任意文件到项目；数据集画像/分析脚本保留；分析脚本编辑器升级为 VS Code 风格（Prism 高亮 + 行号 + Tab 缩进 + 中文输入法支持）。

### ✍️ 写作
- **Google Docs 风格写作台**：只读 A4 全文画布 + 顶部 App Bar（文档标题/保存状态/文档选择/大纲/导入/导出/阅读/保存），不再默认进入编辑模式。
- **阅读内编辑**：点「阅读」进入全屏整篇阅读（目录、进度、KaTeX 公式），阅读态可切换「编辑」，按章节编辑并保存/完成；未保存改动有确认。
- **文档选择 popover**：搜索 + 类型筛选 chips + 列表 + 新建/重命名/删除，替代常驻左栏；筛选 chips 间距修复。
- **大纲抽屉**：章节进度、跳转、新增/删除章节、AI 续写/润色/检查引用。
- **阅读模式**：整篇文档 + 目录 + 滚动定位 + 阅读进度；原生 Word/PDF 与文本视图可切换。

### 🖥 SSH 远程
- **独立 ssh 子包**：infra/ssh 拆分为 mod / types / client / fingerprint / hosts / exec / test / session / sftp / forward / log，单文件 ≤500 行。
- **主机管理**：设置 → 远程服务器，Xshell 风格会话列表、新建/编辑弹窗、连接测试、主机指纹固定/重置、项目绑定、Agent 授权、会话日志开关。
- **交互终端**：xterm.js 终端 + 字号调节 + 全屏阅读式布局；底部命令输入栏支持 bash 语法高亮、历史命令、Enter 发送。
- **SFTP**：文件列表、上传/下载、新建目录、删除文件（≤200MB）。
- **本地端口转发**：127.0.0.1:本地端口 → 远端 host:port，支持新增/删除，会话断开自动清理。
- **会话日志**：按主机开启，输出写入 logs/ssh/<host>-<stamp>.log，可在终端工具条复制/打开。
- **已知主机**：主机指纹管理页，查看/重置；Agent remote_exec 强制校验授权 + 固定指纹 + 项目绑定。
- **跨平台凭据**：Windows Credential Manager / macOS Keychain / Linux Secret Service（keyring 4），配置只存引用；旧 DPAPI 密文 Windows 自动迁移；系统凭据库不可用时降级 plain 并警告。

### 💬 对话
- **思考过程**：思考模型（DeepSeek reasoning_content 等）的推理过程实时流式展示，可折叠回看；历史持久化；非思考模型不显示空面板；推理不进入下一轮上下文。
- **消息排队**：AI 回复中可继续输入并发送，消息进入队列，当前回合结束后按顺序自动发送；队列可单条删除/清空。
- **DeepSeek 官方搜索**：web_search / web_crawl 优先调用 DeepSeek Search / Fetch API（/v1/tools/search、/v1/tools/fetch），失败回退 SearxNG/Bing/Baidu；支持代理、超时与中文错误提示。
- **操作图标**：重新生成/重试改为 refresh 图标，AI 回复新增复制图标；科研工作台侧栏可收起。
- **回答兜底**：检测模型把工具参数/调用格式当正文的情况，先修复轮再强制总结，仍失败给出确定性兜底文案，不再出现「完成了什么都不说」的空白气泡。
- **提示词纪律**：最终回答必须自然语言总结；正文避免过度加粗/标题化；学术 agent 项目模式强制走 academic_project / academic_literature / academic_manuscript 工作流。

### 🌍 跨平台
- Python 运行时：Windows 保持嵌入式；macOS/Linux 使用系统 python3 创建 venv，依赖装在 venv 内。
- FFmpeg sidecar：新增跨平台 scripts/fetch-ffmpeg.mjs（npm run fetch:ffmpeg），Windows 保留 PowerShell 脚本。
- 文档：新增 docs/desktop-cross-platform.md（三平台构建前置、sidecar、凭据、Python、待验证项）。

## 🛠 修复
- 启动 panic：manuscript_sections 的 document_id 索引在列迁移之前创建导致 no such column；索引移到迁移之后并补回归测试。
- 科研动态只显示 stage.updated、无分页、时间戳相同；修复事件 payload/actor、no-op 抑制、分页与秒级时间显示。
- 阶段切换器重复（步骤条 + 计划 chips）；侧边栏图标重复；写作页布局拥挤。
- 对话工具调用参数泄漏成正文、空回复、重新生成后无说明。
- 导入/分析脚本 textarea 因 box-sizing 缺失溢出卡片；新建项目输入框溢出、截止日期改为原生日期选择器。
- 设置页/远程页按钮与组件间距、终端/文件/写作面板满高与对齐问题。
- 远程上传 base64 命令在 BSD/macOS 不兼容；改为 GNU/BSD/openssl 回退。

## 🧪 质量验证
- cargo test --lib --locked：400 passed / 0 failed / 3 ignored。
- cargo test --test agent：25 passed。
- cargo check --all-targets --locked：通过，0 warning。
- npm ci + npm run build（tsc + vite）：通过。

## 📦 版本与升级
- 桌面端版本 0.1.16 → 0.2.0（package.json / package-lock.json / tauri.conf.json / Cargo.toml / Cargo.lock）。
- 直接覆盖安装；SQLite 新增列/表均自动迁移，本地数据与配置兼容。
- 旧版导入的 Word 文档建议重新导入一次，以记录原始文件并启用原生 Word 展示与参考文献自动解析。

## ⚠️ 已知限制
- SSH 功能（SFTP、端口转发、日志）缺少真实服务器端到端验证；仅完成编译/单测。
- 端口转发目前仅本地转发；remote forwarding / SOCKS 未实现。
- docx-preview 对极复杂 Word 对象（MathType、域代码、浮动图形）为尽力还原，可切文本视图查看抽取结果。
- 参考文献自动解析为启发式，复杂格式可能漏识别或字段不全，导入后需在文献页核对。
- macOS / Linux 分支通过 cfg 与标准 API 实现，仍需 CI/真机验证（Keychain、Secret Service、venv、打包）。
- 本地 ASR/OCR 的 CUDA 加速仍仅 Windows；macOS/Linux 使用 CPU 版 onnxruntime。

**完整变更**：CHANGELOG.md（0.2.0 段）与本次 PR。

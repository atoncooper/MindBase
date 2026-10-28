# MindBase Desktop 0.1.15

> 桌面端「Google 化」大版本：全站切换 Google 配色，对话按 Gemini 重做，模型配置支持各类 Coding Plan 与 OpenCode（含 Anthropic 协议），科研工作台与项目信息编辑正式上线。

## ✨ 新功能

### 🎨 全站 Google 配色
- 浅色：页面 `#f8f9fa`、白卡、侧栏 `#f0f4f9`、主色 `#0b57d0`；深色：`#131314` / `#1e1f20` / `#8ab4f8`。
- 主按钮、导航选中态、复选框/开关、进度条、徽标、发送键等交互件统一为 Google 蓝；测验域保留 Google Forms 紫作为独立产品色。
- 新增 `--page` 令牌区分页面底色与卡片表面，长页面切短页面不再整屏变灰。

### 💬 Gemini 风格对话
- 侧栏 280px 蓝灰底、选中会话蓝色调圆角块；「＋ 新建对话」白底描边药丸。
- 模式切换（对话 / 简历 / PPT）移到顶栏，改为 M3 分段控件；收起侧栏只保留图标与会话圆点，**不再出现逐字竖排的压缩文字**。
- 空态改为 Gemini 式问候标题 + 建议胶囊；消息区 780px 居中。
- Composer 改为两行：上方输入，下方「＋ 附件 / 模型药丸 / ↑ 发送」；模型选择从无名图标改为「✦ + 当前模型名 + 下拉箭头」药丸。
- 窄窗口（≤980px）自动收起侧栏，优先保证消息宽度。

### 🧠 模型配置：支持各类 Coding Plan 与 OpenCode
- 新增目录驱动的提供方（参照 DeepSeek Harness provider 数据）：
  - **编程套餐**：DeepSeek、GLM 编程套餐（国际 `api.z.ai` / 国内 `open.bigmodel.cn`）、Kimi 编程套餐、MiniMax（国际 / 国内）、Qwen Token 套餐（国际 / 国内）、小米 Token 套餐（AMS / 国内）。
  - **OpenCode**：OpenCode Zen（OpenAI 兼容 / Claude 协议）、OpenCode Go（OpenAI 兼容 / Claude 协议）。
  - **官方 API**：Anthropic Claude、OpenAI、Moonshot/Kimi（国际 / 国内）。
  - **聚合与兼容端点**：DashScope、OpenRouter、自定义 OpenAI 兼容端点；ASR / Embedding / OCR 用途槽保留。
- 新增 **Anthropic Messages 协议适配层**：请求/流式响应在 HTTP 层双向翻译，支持工具调用、图片、tool_result 与 token 用量；Claude、MiniMax、Kimi Coding 等 Anthropic 协议套餐可正常进行带工具的对话。
- 支持从端点拉取模型列表（`GET /models`，按协议鉴权）、协议感知的「测试连接」、任意对话提供方「设为默认」；对话界面的提供方菜单由目录驱动。

### 🔬 科研工作台
- 全屏两栏 Google Workspace 风格：左侧项目栏（搜索 / 项目列表 / AI 绑定状态），右侧项目页（阶段步骤条、当前阶段建议、项目信息、阶段产物、最近动态、文献 / 数据 / 写作 tab）。
- **项目信息可编辑**：项目名称、论文类型、研究领域、目标期刊 / venue、截止日期；保存后页头标题、meta chips 与左侧列表同步刷新（数据写本地 SQLite）。
- 文献：BibTeX / CSL-JSON 导入、Crossref 核验、BibTeX 导出；数据：CSV / XLSX 导入与列画像、本机 Python 分析脚本；写作：章节编辑、DOCX 导出、Cover Letter 入口。

## 🎨 体验与细节
- 设置页 Google Workspace 风格：M3 主 tab、16px 圆角卡片、40px outlined 输入框、Google 复选框与分段控件。
- 侧栏收起态不渲染文字，仅保留图标与圆点（hover tooltip 显示全名）。
- 设置、科研、对话三个域使用同一套 Google 令牌，亮/暗主题自动跟随。

## 🛠 修复
- **页面被内容撑窄**：`.shell` 作为 flex 子项时因 `margin:auto` 退化为内容自适应宽度，内容少时整页缩成窄条；改为显式 `width:100%` + `box-sizing:border-box`。
- 窄窗口页面留白过大、滚动条出现/消失导致的 10px 宽度跳动（`scrollbar-gutter`）。
- 设置页 scoped 样式压过 `[hidden]`，导致三个 tab 同时渲染。
- 对话侧栏收起后模式文字仍参与布局、被压成逐字竖排；窄窗下出现点不动的「展开历史」死控件。
- 长列表/表格在窄窗口把页面撑出横向滚动条。

## 🧪 质量与验证
- `cargo check` 通过；`cargo test --lib` **269 passed / 0 failed**（含 Anthropic 请求体与流式事件映射用例）。
- `npm run build`（`tsc && vite build`）通过。
- 1440 / 1024 / 800 与 600px 窄窗、浅色 / 深色逐页截图核对：对话（展开 / 收起 / 空态）、设置三个 tab、科研概览 / 编辑 / 文献 / 数据 / 写作、收藏夹 / 测验等。

## 📦 升级说明
- 直接覆盖安装即可，本地数据与配置保持兼容；科研域新增数据表使用 `CREATE TABLE IF NOT EXISTS` 自动建表，无需手动迁移。
- 新增的 Coding Plan / OpenCode 等提供方需在「设置 → API 设置 → 模型配置」中填入对应 API Key，并可点「获取模型」/「测试连接」验证。
- Anthropic 协议套餐（Claude / MiniMax / Kimi Coding / OpenCode Claude）无需额外开关，选择后即可使用。
- macOS 构建仍为 Beta。

## ⚠️ 已知限制
- Anthropic 适配目前映射文本、工具调用、图片与用量；思考（thinking）增量帧不展示。
- OpenAI Responses（Codex 的 ChatGPT 后端）与 Gemini 原生协议暂未适配；GitHub Copilot 等 OAuth-only 套餐不在支持范围。
- OpenCode Zen / Go 的 GPT / Grok 模型属于 Responses 协议，当前客户端不可用；请选择其 OpenAI 兼容或 Claude 协议模型。
- 对话历史中的图片仍只随本轮请求发送，不写入历史。

**完整变更**：CHANGELOG.md（0.1.15 段）与 PR #157。

# MindBase Desktop 0.1.14

> 本次更新把桌面端本地 agent 的能力补齐到与 Web 端一致的水位：会话交互、联网检索、多模态输入、检索质量、成本可见与执行稳定性。

## ✨ 新功能

- **结构化交互卡片（ask_user）**：需要澄清、写操作确认或补充信息时，AI 会用卡片提问（选项 / 确认 / 表单三种形态），点击或提交即作为下一条消息回答，本轮即时结束等待你补充，不再把问题混在正文里。
- **联网搜索（web_search）**：知识库覆盖不到时先搜索再抓正文。引擎链支持自建 SearxNG（设置 `MIND_BASE_SEARXNG_URL`）→ Bing → Baidu，自带反爬识别、代理出口与失败降级。
- **主动图片输入**：输入框支持粘贴、拖拽、选择图片（最多 4 张，单张 ≤5MB、合计 ≤15MB）。仅视觉模型可用（如 qwen-vl / gpt-4o），非视觉模型会给出明确提示。
- **后台任务入口**：聊天顶栏新增「后台任务」，可把任务派给 chat / memory / note / code / search / academic 六个 agent 在后台执行，并在 Agent 状态页注入消息、停止或查看。
- **产物卡片**：简历、幻灯片等本轮生成的文件会以卡片形式出现在消息中，可一键打开（写入 `exports/` 目录）。
- **token 用量可见**：每轮对话结束后，消息底部展示输入 / 输出 / 合计 tokens；用量随消息落库，重启后仍可查看。

## 🚀 体验与质量

- **检索精排**：混合检索（BM25 + 向量 RRF）之后新增 DashScope `gte-rerank-v2` 精排，命中更准；未配置或调用失败时自动回退融合顺序，不影响检索可用性。
- **工具执行硬超时**：每个工具独立线程执行，默认 180 秒超时（`MIND_BASE_TOOL_TIMEOUT_SECS` 可调）。卡死的工具会降级为可读错误，本轮继续，不再拖住整段对话。
- **文件能力沙箱**：`read_file` / `write_file` / `list_dir` 的相对路径固定在当前 agent 的 `agent-files/<agent>/` 目录，绝对路径仅限应用数据目录内，`..` 越界会被拒绝。
- **academic agent 修复**：学术研究 agent 现在可通过委托、后台任务与工具清单正常触达（写 / 审 / 改 / 读论文四种模式）。

## 🛠 修复

- 修复日志模块时间转换测试的纪元常量笔误。
- 修复 OCR 测试共用临时目录导致的偶发失败（并行测试互删）。
- 同步 package-lock / Cargo.lock 中的版本字段。

## 📦 升级说明

- 直接覆盖安装即可；本地数据库自动迁移（`chat_messages` 新增 `usage` 列，旧库启动时自愈补列），无需手动操作。
- 可选环境变量：
  - `MIND_BASE_SEARXNG_URL`：优先使用自建 SearxNG 搜索；
  - `MIND_BASE_RERANK=off`：关闭检索精排；`MIND_BASE_RERANK_MODEL` / `MIND_BASE_RERANK_URL`：覆盖精排模型/端点；
  - `MIND_BASE_STREAM_USAGE=off`：个别 provider 不接受 `stream_options` 时关闭用量采集；
  - `MIND_BASE_TOOL_TIMEOUT_SECS`：工具超时秒数（默认 180）。

## ⚠️ 已知限制

- 图片只随本轮请求发送，不写入历史（刷新后不重放）；
- 联网搜索与精排依赖网络与 DashScope 密钥；
- macOS 构建仍为 Beta。

**完整变更**：CHANGELOG.md（0.1.14 段）与 PR #156。
# Changelog

本文件记录 MindBase 当前版本的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 更早版本的完整记录见 git 历史；本文件只保留本次（2026-11-28）的改动。

## [Unreleased] — 2026-11-28

### Added

- **推理强度改为连续滑杆**：聊天输入栏推理强度从 min/mid/high/max 四档改为 **0–100 连续拖动**（Codex 风格绿→紫渐变轨道，支持键盘微调与本地持久化，旧值自动迁移）；请求字段 `reasoning_effort` 改为数字（后端兼容旧标签与数字字符串），app-ts 新增 `src/agent/reasoning-effort.ts` 统一归一化并映射到网关枚举，附 `test/reasoning-effort.test.ts`。

- **Coding Plan 轮次 token 计量**：用户自带套餐的轮次也按真实 input/output token 记账（独立 5h/日/月窗口 + 按模型拆分，**不扣平台额度**），`GET /quota/summary` 新增 `codingPlan` 段，账户页展示今日/本月已用 token 并注明不计入平台 Credits。

- **聊天右侧消息历史轨迹条**：新增 `chat-history-rail.tsx`，每条用户消息一个锚点，悬停预览、点击平滑跳转、按滚动位置高亮当前项；窄屏隐藏、不遮挡内容。

- **云盘多选 + 批量操作**：列表/网格/回收站支持 checkbox、ctrl/cmd 切换、shift 连选、全选；新增批量删除/恢复/彻底删除端点（1–200 项、逐项失败隔离，复用单文件语义）；多选分享按同一配置逐文件建链，支持进度、复制与单项重试。

- **管理台 SKU 目录 CRUD**：`pay_product` 成为权威商品表（Flyway V11 幂等播种，app-pay 不再硬编码种子）；app-admin 新增商品增删改查（校验/订单引用安全/双审计），frontend-admin 商品页改为完整 CRUD；新增 `app-go/app-admin/tests/` 黑盒测试包。

### Changed

- **聊天默认模型 = Coding Plan 默认套餐模型**：默认选中启用且 `is_default` 的套餐模型并标注「Coding Plan 默认 · 具体型号」，用户显式选择优先并持久化；显式选「平台默认模型」可覆盖套餐默认。

- **用户端移除沙箱**：删除 `/sandbox` 页面、`components/sandbox/`、`lib/api/sandbox.ts`、导航项与导出（沙箱只服务 agent 的 `run_code`，管理后台 `/sandbox` 控制台保留）。

- **删除确认弹窗改用 MUI 标准组件**：`confirm-dialog.tsx` 直接采用 MUI `Dialog / DialogTitle / DialogContent / DialogActions / Button` 的标准 AlertDialog 写法，去掉渐变、毛玻璃与自定义配色（危险操作使用 MUI 标准 `color="error"` 红色）；「定时任务删除」「Coding Plan 删除」两个原生 `window.confirm` 同步替换。

- **compose 默认启动沙箱**：`app-sandbox`、`sandbox-tls`、`opensandbox-server` 纳入默认 profile，`docker compose up -d` 即启动沙箱（`--profile sandbox` 仍可用于单独拉起），app-ts 的 `run_code` 默认可用。

- **构建健壮性**：`app-cloud` 与 `frontend-admin` Dockerfile 的 Go/npm 镜像源改为可覆盖的 build args（受限网络可指定镜像源重建）。

### Fixed

- **流式空闲超时（不再无限「思考中」）**：新增后端看门狗 `agent.streamIdleTimeoutMs`（默认 120s）与前端客户端兜底（130s）——连续超时无任何 SSE 帧且当前没有工具在执行时，中止本轮并返回明确错误「长时间无输出，已中止」；工具执行期间豁免（长任务仍由 `turnTimeoutMs` 兜底）。附带 `app-ts/test/stream-idle.test.ts`，前端 error 气泡提示可直接重试。

- **云盘视频播放性能**：修复三个叠加根因——① 边缘对 **带 Range 的播放请求**限速（8MiB Range TTFB 2.0–8.4s → 0.03–0.07s，整文件下载仍保留限速兜底）；② HLS token 读错 Redis 库导致已转码视频 `/hls/` 全部 403 并回退原画（修复后 200）；③ 前端把异步转码当播放前置条件、且无状态视频被伪报 `processing` 永久转圈。现在原画立即播放、HLS 懒入队并渐进升级，不再阻塞首帧。

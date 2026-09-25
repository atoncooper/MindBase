# Changelog

本文件记录 MindBase 各版本的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] — 2026-09-25

### Added

- **聊天·按轮重写与编辑**：任意一轮回答可重新生成（服务端截断该轮及其后历史再重问，历史与 LLM 上下文保持一致）；自己发的消息支持 ChatGPT 式内联编辑后重发（`DELETE /chat/history/from/{msg_id}` 新端点支撑）。
- **聊天·体验打磨**：loading 指示与头像同水平线（波浪点 + 流光动画）；失败消息带重试按钮；停止生成不再留下空白泡；滚动贴底跟随（上翻阅读不被拽回，提供"回到底部"悬浮按钮）；消息操作栏移动端常显。
- **代码块折叠**：聊天中超过 200 行的代码块默认折叠为约 24 行预览（展开/折叠切换，复制始终全量）。
- **首页 Apple 式交错展示**：首屏 Hero 之下新增 6 段「文字 ⇄ 动画演示」交错展示（智能问答 / 收藏夹→知识库 / 笔记+思维导图 / 练习+定时出题 / 云盘 / 知识图谱），未登录落地页与登录后首页共用；动画为纯 CSS/framer-motion 手工 mockup，离屏自动暂停、循环淡出衔接、尊重 reduced-motion。
- **统一 TLS 证书供给**：新增 `scripts/gen-certs.sh` + compose `cert-gen` 一次性 init 服务，fresh clone 直接 `docker compose up` 即可获得全栈可用证书（nginx / app-board / app-board-mcp / app-pay 共享单一 CA，标准主题 `C=CN/ST=Sichuan/L=Chengdu/O=MindBase`，CN 一律为产品名）；幂等（到期前 30 天自动重签）。

### Changed

- 登录后首页重构：移除与顶部导航重复的快捷入口网格，改为与未登录页一致的功能展示页（各段 CTA 直达对应功能）。
- 顶栏移除头像旁的设置齿轮图标（设置页仍可经个人中心进入）。

### Removed

- **用量计费（/billing）与任务监控（/tasks）前端暂时下线**：路由页、API 模块、导航入口与个人中心入口按钮一并移除（后端端点保留；恢复可从 git 历史找回）。

### Fixed

- `/task-quiz` 页面预取 301→404：nginx 对无斜杠裸路径的规定性 301 使页面预取落进 API 通道；双精确钉死页面路由后实测四态全对。
- TLS 供给脚本两处健壮性：Git Bash 下 `-subj` 被路径转换、busybox date 解析不了证书日期导致每次运行全部重签（改用 `openssl x509 -checkend`）。

# app-mobile — MindBase Flutter 移动端

> 🚧 **开发状态：测试阶段（WIP）**
> app-mobile **尚未开发完成**，正处于内部测试阶段：功能覆盖、协议对齐与 UI 仍在推进，
> 接口与页面可能随时变动，**请勿用于生产环境**。已完成 / 未完成范围见下方「功能范围」表
> 与「当前限制」；欢迎测试反馈，但不承诺稳定性。

MindBase（B站收藏知识库 RAG 系统）的 Flutter 客户端。**零后端改动**：与 frontendv2 走同一套 APISIX 网关路由，协议语义与 `frontendv2/lib/api/`、`frontendv2/lib/chat-stream.ts` 逐条对齐。

开发规范见 [AGENTS.md](AGENTS.md)。

## 当前限制（测试阶段）

- **联调形态**：桌面端（Windows）为主力联调环境；Android 真机可跑，iOS 未实测
- **未完成**：推送通知（FCM/厂商通道）、云盘后台上传（workmanager）、思维导图/白板（明确不在移动端范围）
- **字体**：MiSans 全字重随包分发（约 30MB），子集化优化未做
- **支付**：会员中心 UI 已就绪，支付链路依赖 app-pay 环境（MOCK/当面付），仅建议测试环境验证
- **协议同步**：SSE 帧语义与 frontendv2 逐条对齐，两端改动需同步（见 AGENTS.md）

## 功能范围

| 模块 | 状态 | 说明 |
|------|------|------|
| 服务器配置 | ✅ | 首启引导 / 设置页可改；**统一域名预留位**（见下） |
| 聊天多模态 | ✅ | 图片附件：拍照（系统相机）/ 相册多选 / 文件（桌面端为文件选择；data URL，需当前模型 vision=true） |
| 登录 | ✅ | B站扫码（QR 展示 + 轮询 + 复制链接/唤起B站App）+ 邮箱/手机密码登录（图形验证码） |
| 聊天 | ✅ | **ChatGPT 移动端风格**：主界面即对话 + 抽屉式会话列表（按日期分组/搜索/重命名/删除）、流式回答、reasoning 面板、检索步骤、来源、artifact、排队/委派横幅、停止生成、单轮重新生成、图片附加 |
| 收藏夹 | ✅ | 文件夹列表、分P列表、同步触发、向量化状态 |
| 笔记 | ✅ | 列表/查看(Markdown)/创建/编辑/删除，If-Match 乐观并发（409 冲突提示） |
| 云盘 | ✅ | 列表、上传（multipart）、删除、向量化状态展示 |
| 测验 | ✅ | 测验历史/答题；定时任务测验列表/作答 |
| 会员/支付 | ✅ | 会员态、商品、下单、收款码展示 + 轮询 DELIVERED、订单列表/取消（渠道由 `/pay/channels` 决定，不硬编码 MOCK） |
| 设置 | ✅ | 服务器地址、自签证书调试开关、当前用户、登出当前/全部设备 |
| 推送通知 | ⏳ | task-quiz 截止提醒的厂商推送需要 FCM/厂商通道平台配置，见「后续工作」 |
| 后台上传 | ⏳ | 云盘大文件后台上传需平台侧 workmanager/后台任务配置 |
| 思维导图/白板 | ⏳ | board 画布渲染重，暂不在移动端范围 |

## 字体策略

全平台统一使用 **MiSans**（小米官方字体，免费商用），随应用打包 4 个字重
（Regular / Medium / Demibold / Bold，见 `assets/fonts/` + `pubspec.yaml`）。

- 选型理由：苹果官方 SF Pro 受许可限制不可在非苹果平台分发；MiSans 是免费可商用
  字体里观感最接近苹方的（Latin + CJK 一体，圆润中性）
- 回退链：苹方（iOS）→ 微软雅黑（Windows）→ 系统无衬线（`app_theme.dart`）
- 体积优化（可选）：当前 4 个字重约 30MB；如需缩减，用 `fonttools` 对 CJK 做子集化
  （`pyftsubset MiSans-Regular.ttf --text-file=used_chars.txt`）后替换

### 字体解析探针（排查歪扭/不统一）

debug/profile 构建会注册 VM service 扩展 `ext.app.fontProbe`（release 恒为 no-op）。
应用运行中执行 `flutter run` 后在终端按 `v` 打开 DevTools，或直接对 VM service 发
`ext.app.fontProbe`，返回各字体/字重的实测宽度：

- `miSansWidth != missingWidth` → 资产 MiSans 真实被引擎解析；
- `w400/w500/w600/w700Width` 互不相等 → 真实字重（**伪粗体不改变 advance 宽度**，
  宽度相等 = 合成加粗，是笔画糊/歪的经典来源）；
- `codeWidth` → 代码等宽链解析结果。

真机上若出现字体异常，先跑此探针再定位，避免肉眼猜测。守护测试见
`test/font_render_test.dart`（资产解析 + 字重映射 + 斜体/等宽链三重守护）。

## 统一域名预留（重要）

移动端与 web 端共用一套网关接口，部署拿到**统一域名**后无需改任何页面代码：

- 预留位：`lib/core/config/app_config.dart` 的 `unifiedApiDomain` 常量，填入正式域名即可全端默认生效；
- 生效优先级：`--dart-define=API_BASE_URL`（发布固化）> 设置页手动覆盖（联调用）> 统一域名默认值；
- 未填统一域名且无任何配置时，首次启动进入「服务器配置」页引导；设置页会展示完整解析链并支持一键回退统一域名。

## 快速开始

前置：Flutter SDK >= 3.24（Dart >= 3.5）。

### 在电脑上运行（Windows 桌面）

```bash
# 平台壳已生成（windows/）；Windows 桌面要求 VS「使用 C++ 的桌面开发」工作负载，
# 且需包含 ATL 组件（flutter_secure_storage_windows 依赖 atlmfc）：
#   VS Installer → 修改 → 单个组件 → 勾选「适用于最新 v1xx 生成工具的 C++ ATL」
flutter run -d windows
```

Windows 桌面端联调最省事：同一台机器可直接填 `http://localhost:9080`（APISIX），
不受 Android cleartext 限制。⚠️ **Chrome/Web 跑不了**：网络层使用 dart:io
（自签证书回调 + 分片直传），是有意为之的取舍。

```bash
# 1. 生成平台目录（本仓库只提交 Dart 层，platform 壳由脚手架生成）
cd app-mobile
flutter create . --project-name app_mobile --org com.mindbase --platforms android,ios

# 2. 拉依赖
flutter pub get

# 3. 运行（局域网联调示例；也可不带 dart-define，在首启的"服务器配置"页填写）
flutter run --dart-define=API_BASE_URL=https://192.168.1.10:9443
```

### 测试与分析

```bash
flutter analyze
flutter test            # 含 chat_stream 解析器协议对齐测试
```

## 联调要求（与后端/网关）

1. **可达性**：真机必须能访问 APISIX（或前置 nginx）地址。开发期最常见的问题是 dev 自签证书的 SAN 只覆盖 `localhost` —— 用 `app-pay/scripts/gen-dev-cert.*` 或对应脚本把真机访问的 IP/域名加进 SAN，或走 nginx 的正式证书域名。
2. **HTTPS**：Android 默认禁止 cleartext，iOS 有 ATS —— 服务器地址必须是 `https://`。自签证书联调时，可在「设置 → 允许自签证书（仅调试）」临时打开；该开关 `kReleaseMode` 下强制无效。
3. **鉴权**：与 web 端一致，登录后持 `Authorization: Bearer <bili_session>`；401 统一清 token 跳登录。B站 cookie 仍在服务端，移动端只管 token。
4. **SSE**：直连网关 `POST /chat/ask/agent/stream`，不要经任何会缓冲响应的代理。

## 协议对齐说明

- SSE 帧语义以 `frontendv2/lib/chat-stream.ts` 与后端 `agent_sse.py` / app-ts `transport/sse.ts` 为权威；本端解析器是它的 Dart 移植，配离线测试 `test/chat_stream_test.dart` 守护。
- `reset` 帧清正文但**保留 reasoning**（后端 reset 后不重放思考内容）。
- 流结束但未收到 `done`/`[DONE]` = 异常中断，必须报错，不能当作正常完成。
- 请求体 snake_case；响应经 snake→camel 后进 DTO。
- 笔记更新带 `If-Match` 乐观并发，409 时提示刷新。

## 后续工作

- 推送通知（task-quiz 截止提醒）：接入 FCM / 厂商通道需要 Android google-services 配置与 APNs 证书，并需后端新增 push token 上报端点（**显式加 APISIX 路由**）。
- 后台上传：workmanager / flutter_uploader 平台壳。
- 微信登录：依赖微信 OpenSDK 平台配置（universal link / app id），且后端 `/auth/wechat/*` 面向 web redirect 流，移动端需另行评估 OAuth 形态。

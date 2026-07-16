# mind-base 黑盒 GUI 自动化测试设计文档

> 课程设计配套文档 · 2026-06-22
> 工具栈:Playwright (Python) + Pytest + Allure

---

## 一、被测系统概述

| 项 | 值 |
|---|---|
| 系统名 | mind-base(B站收藏知识库 RAG 系统) |
| 仓库 | `D:\code\app\mind-base\mind-base` |
| 前端 | Next.js 15(App Router) @ `http://localhost:3000` |
| 后端 | FastAPI @ `http://localhost:8000` |
| 核心链路 | B站数据 → 内容提取 → 向量化 → 检索 → LLM 生成 |
| 测试类型 | PC 端黑盒 GUI 自动化 |

### 1.1 业务架构

```
┌─────────────────────────── Frontend (Next.js) ────────────────────────────┐
│                                                                            │
│   page.tsx (顶层状态: session / user / folderIds / chatSessionId)         │
│        │                                                                   │
│        ├── QRLoginModal / PasswordLoginModal  ← M1 认证                    │
│        ├── DockBar (底部 Dock 栏,9 个模块入口)                              │
│        │     ├── chat           (对话)            ← M4 聊天                │
│        │     ├── chat-history   (历史会话)                                 │
│        │     ├── quiz           (题目练习)        ← M5 Quiz                │
│        │     ├── favorites      (收藏夹)          ← M2 收藏夹              │
│        │     ├── cloud-drive    (云盘)                                     │
│        │     ├── settings       (API 设置)                                 │
│        │     ├── account        (个人中心)                                 │
│        │     ├── tasks          (任务监控)                                 │
│        │     └── billing        (用量计费)                                 │
│        └── lib/api.ts (唯一 API 调用入口)                                  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────── Backend (FastAPI) ──────────────────────────────┐
│   routers/auth.py        ← M1                                              │
│   routers/favorites_v2   ← M2                                              │
│   routers/knowledge      ← M3                                              │
│   routers/chat           ← M4                                              │
│   routers/quiz           ← M5                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、测试范围

### 2.1 5 个核心业务模块

| 模块 | 路由前缀 | 关键功能 |
|------|---------|---------|
| **M1 认证** | `/auth` | 扫码登录、邮箱密码登录、会话查询、退出 |
| **M2 收藏夹** | `/favorites/v2` | 列表、同步、多选、整理预览、视频分页 |
| **M3 知识库** | `/knowledge` | 统计、构建、状态轮询、向量化分P |
| **M4 聊天** | `/chat` | 流式问答(SSE)、来源展示、历史管理 |
| **M5 Quiz(加分)** | `/quiz` | 出题、答题、批改、错题本 |

### 2.2 4 项端到端业务场景

| 场景 | 跨模块 | 描述 |
|------|--------|------|
| S1 | M1 | 扫码/密码登录 → 进入工作台 |
| S2 | M1+M2 | 登录 → 打开收藏夹 → 同步 → 多选 |
| S3 | M1+M2+M3 | 登录 → 打开收藏夹 → 触发构建 → 轮询状态 |
| S4 | M1+M3+M4 | 登录 → 聊天 → SSE 流式回答 → 展示来源 |

---

## 三、接口清单(从 `frontend/lib/api.ts` 提取)

### M1 认证
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/qrcode` | 获取登录二维码 |
| GET | `/auth/qrcode/poll/{qrcode_key}` | 轮询扫码状态 |
| POST | `/auth/login` | 邮箱密码登录 |
| GET | `/auth/me` | 获取当前用户 |
| DELETE | `/auth/token` | 退出当前设备 |
| DELETE | `/auth/tokens` | 退出所有设备 |

### M2 收藏夹(v2)
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/favorites/v2/list` | 收藏夹列表 |
| POST | `/favorites/v2/sync` | 同步收藏夹 |
| PATCH | `/favorites/v2/{id}/selected` | 切换选中 |
| DELETE | `/favorites/v2/{id}` | 删除收藏夹 |
| GET | `/favorites/v2/media/{media_id}/videos` | 视频分页 |
| GET | `/favorites/v2/video/{bvid}/pages` | 视频分P |

### M3 知识库
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/knowledge/stats` | 统计 |
| POST | `/knowledge/build` | 构建 |
| GET | `/knowledge/build/status/{task_id}` | 构建状态 |
| GET | `/knowledge/folders/status` | 收藏夹入库状态 |
| POST | `/knowledge/folders/sync` | 同步入向量库 |
| DELETE | `/knowledge/clear` | 清空 |
| DELETE | `/knowledge/video/{bvid}` | 删除视频向量 |
| GET | `/knowledge/pages/vectorized` | 已向量化分P |

### M4 聊天
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/chat/ask` | 普通问答 |
| POST | `/chat/ask/stream` | 流式问答(SSE) |
| POST | `/chat/search` | 语义搜索 |
| GET | `/chat/sessions` | 会话列表 |
| POST | `/chat/sessions` | 创建会话 |
| GET | `/chat/history` | 历史消息 |
| DELETE | `/chat/history` | 清空历史 |

### M5 Quiz
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/quiz/generate` | 生成题目 |
| GET | `/quiz/{quiz_uuid}` | 获取题目集 |
| POST | `/quiz/submit` | 提交答案 |
| GET | `/quiz/history` | 答题历史 |
| GET | `/quiz/wrong-answers` | 错题本 |

---

## 四、UI 功能点(可交互元素清单)

### 登录页
- 二维码图片(`img[alt="QR Code"]`)
- "重新获取"按钮(二维码过期时)
- 邮箱输入框(`input[type="email"]`)
- 密码输入框(`input[type="password"]`)
- "下一步"提交按钮(`button[type="submit"]`)
- "使用扫码登录"切换按钮

### Dock 栏
- 9 个模块图标(按 `aria-label` 识别): 对话/历史会话/题目练习/收藏夹/云盘/API设置/个人中心/任务监控/用量计费

### 收藏夹面板
- 标题: "收藏夹" + 副标题(N 个)
- "快速整理默认收藏夹"按钮
- "刷新"按钮
- 文件夹项列表(可展开/收起)
- 多选 checkbox

### 聊天面板
- 消息列表(用户/AI 气泡)
- 输入框(`placeholder="输入问题..."`)
- "发送"按钮
- "清空"按钮(垃圾桶图标)
- 来源链接列表(`.source-link`)

### Quiz 面板
- "生成题目"按钮
- 题目列表(每题含题干 + 选项/输入)
- "提交"按钮
- 得分/结果展示

---

## 五、手工测试用例矩阵(节选,完整版见 `manual_test_cases.md`)

| ID | 模块 | 标题 | 优先级 | 类型 |
|----|------|------|--------|------|
| TC-M1-001 | M1 | 打开首页应自动弹出登录入口 | P0 | 正向 |
| TC-M1-002 | M1 | 二维码加载完成后应可识别 | P0 | 正向 |
| TC-M1-003 | M1 | 空邮箱应触发验证提示 | P1 | 异常 |
| TC-M1-004 | M1 | 错误密码应返回错误信息 | P0 | 异常 |
| TC-M1-005 | M1 | 登录成功后 localStorage 应有 bili_session | P0 | 正向 |
| TC-M1-006 | M1 | 退出登录应清除 session | P0 | 正向 |
| TC-M2-001 | M2 | 打开收藏夹面板应加载列表 | P0 | 正向 |
| TC-M2-002 | M2 | 刷新按钮应保持列表一致 | P1 | 正向 |
| TC-M2-003 | M2 | 点击文件夹应切换选中 | P1 | 正向 |
| TC-M2-004 | M2 | 整理预览应显示统计 | P1 | 正向 |
| TC-M3-001 | M3 | 知识库统计应渲染 | P0 | 正向 |
| TC-M3-002 | M3 | 构建按钮应触发 POST /knowledge/build | P0 | 正向 |
| TC-M3-003 | M3 | 无选中时应阻止构建 | P1 | 异常 |
| TC-M4-001 | M4 | 输入为空时发送按钮应禁用 | P0 | 异常 |
| TC-M4-002 | M4 | 发送问题应触发 SSE 流 | P0 | 正向 |
| TC-M4-003 | M4 | SSE 应至少产生 chunk/done 事件 | P0 | 正向 |
| TC-M4-004 | M4 | 回车键应等同发送 | P1 | 正向 |
| TC-M5-001 | M5 | 生成按钮应触发 /quiz/generate | P0 | 正向 |
| TC-M5-002 | M5 | 提交应触发 /quiz/submit | P0 | 正向 |

---

## 六、自动化脚本结构

```
testing/e2e/
├── conftest.py                 # pytest fixtures (browser/context/page/auth_page)
├── pytest.ini                  # pytest + playwright + allure 配置
├── requirements.txt
├── .env.example
├── pages/                      # Page Object 层
│   ├── base_page.py
│   ├── login_page.py
│   ├── dock_page.py
│   ├── favorites_page.py
│   ├── chat_page.py
│   ├── knowledge_page.py
│   └── quiz_page.py
├── tests/                      # 测试用例
│   ├── test_m1_auth.py         # 8 条
│   ├── test_m2_favorites.py    # 7 条
│   ├── test_m3_knowledge.py    # 5 条
│   ├── test_m4_chat.py         # 8 条
│   ├── test_m5_quiz.py         # 5 条
│   └── test_scenarios.py       # 5 个端到端场景 (S1-S5)
├── utils/                      # 工具函数
├── reports/                    # 报告输出(gitignored)
└── data/                       # storage_state 等测试数据
```

**用例统计:** 38 条自动化用例,覆盖 5 模块 + 5 端到端场景。

---

## 七、工具选型理由

| 候选 | 选用? | 理由 |
|------|------|------|
| Playwright (Python) | ✅ | 原生支持 SSE、异步、跨浏览器、对 Next.js 兼容好 |
| Selenium | ❌ | SSE 流处理较弱,API 较旧 |
| Airtest | ❌ | 主要面向移动端/游戏,Web 支持不如 Playwright |
| Cucumber | ❌ | BDD 风格不适合本项目(RAG 链路复杂,Gherkin 表达力受限) |

---

## 八、风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| B站真实扫码无法自动化 | 🔴 高 | 优先用邮箱密码登录(`.env` 配置测试账号);备用方案:手动登录一次保存 `storage_state` |
| LLM API Key 依赖 | 🟡 中 | 测试中遇到 LLM 超时/不可用则 `pytest.skip`,不视为失败 |
| ASR/向量化耗时长 | 🟡 中 | 知识库构建测试只断言请求发出,不等待完成 |
| B站 API 限流 | 🟡 中 | 收藏夹测试使用小数据集账号 |
| UI 选择器稳定性 | 🟡 中 | 项目无 data-testid,依赖文本/类名;后续可推动前端加 testid |

---

## 九、执行方式

### 9.1 准备
```bash
cd testing/e2e
pip install -r requirements.txt
playwright install chromium
cp .env.example .env
# 编辑 .env 填入测试账号
```

### 9.2 运行
```bash
# 全量
pytest

# 按模块
pytest -m m1_auth
pytest -m scenario

# 跳过慢用例
pytest -m "not slow"

# 生成 Allure 报告
allure serve reports/allure-results
```

### 9.3 报告
- HTML: `reports/report.html`
- Allure: `reports/allure-results/`
- 截图/视频/Trace: `reports/screenshots/`

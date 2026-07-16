# mind-base E2E 黑盒 GUI 自动化测试

> 课程设计项目 · 使用 Playwright (Python) 驱动 PC 端黑盒测试

## 目录结构
```
testing/e2e/
├── conftest.py              # Pytest fixtures
├── pytest.ini               # 配置
├── requirements.txt
├── run.py                   # 便捷执行入口
├── .env.example             # 环境变量模板
├── pages/                   # Page Object 层
├── tests/                   # 测试用例(38 条)
├── utils/                   # SSE 收集器等工具
├── docs/                    # 设计文档 + 手工用例矩阵
├── reports/                 # 报告输出(gitignored)
└── data/                    # storage_state
```

## 快速开始

### 1. 安装依赖
```bash
cd testing/e2e
pip install -r requirements.txt
playwright install chromium
```

### 2. 配置环境
```bash
cp .env.example .env
# 编辑 .env:
#   BASE_URL=http://localhost:3000
#   API_BASE_URL=http://localhost:8000
#   LOGIN_METHOD=password
#   TEST_EMAIL=your-test-account
#   TEST_PASSWORD=your-password
```

### 3. 启动被测系统
```bash
# 后端
cd D:/code/app/mind-base/mind-base
uvicorn app.main:app --reload --port 8000

# 前端(新终端)
cd frontend
npm run dev
```

### 4. 运行测试
```bash
# 全量
python run.py

# 按模块
python run.py --module m1_auth

# 仅端到端场景
python run.py --scenario

# 无头模式
python run.py --headless

# 生成 Allure 报告
python run.py --report
```

## 测试覆盖

| 模块 | 用例数 | 文件 |
|------|--------|------|
| M1 认证 | 8 | `tests/test_m1_auth.py` |
| M2 收藏夹 | 7 | `tests/test_m2_favorites.py` |
| M3 知识库 | 5 | `tests/test_m3_knowledge.py` |
| M4 聊天 | 8 | `tests/test_m4_chat.py` |
| M5 Quiz | 5 | `tests/test_m5_quiz.py` |
| 端到端场景 | 5 | `tests/test_scenarios.py` |
| **合计** | **38** | |

详见 `docs/test_design.md` 与 `docs/manual_test_cases.md`。

## 设计要点

- **Page Object 模式**: 所有 UI 交互封装在 `pages/` 下,选择器集中管理
- **登录态复用**: 通过 `conftest.auth_page` fixture 一次登录多用例复用
- **SSE 流测试**: `utils/sse_collector.py` 解析流式事件
- **失败截图**: `pytest.ini` 配置 `--screenshot only-on-failure`
- **Allure 报告**: 步骤、截图、视频集成

## 已知限制

1. **B站扫码无法自动化**: 必须使用邮箱密码登录的测试账号
2. **LLM 依赖**: 涉及 LLM 的用例在 API Key 失效时会 skip 而非 fail
3. **UI 选择器稳定性**: 项目当前无 `data-testid`,依赖文本/类名,后续可推动前端补充

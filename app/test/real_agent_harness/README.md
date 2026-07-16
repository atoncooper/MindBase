# Real Agent/Harness Integration Tests

这个目录用于测试当前未提交代码中 Agent/Harness 工程改动的真实运行效果。

这些测试**不是 mock 测试**：

- 不使用 `mock` / `patch` / `AsyncMock` / `MagicMock`
- 会真实启动 `AgentHarness`
- 会真实执行 `ToolManager.discover()` 工具发现
- 会真实注册 `chat` / `memory` / `quiz` agent
- 会真实调用已配置的 LLM
- 会真实连接项目配置里的数据库
- `vector_search` 测试会真实读取配置的向量库数据

## 覆盖范围

测试文件：

```bash
app/test/real_agent_harness/test_real_agent_harness.py
```

当前包含 4 个真实测试：

1. `test_real_harness_startup_discovers_tools_and_agents`
   - 启动真实 `AgentHarness`
   - 验证工具自动发现无失败
   - 验证 `chat` / `memory` / `quiz` agent 注册成功
   - 验证核心工具已注册：
     - `vector_search`
     - `list_videos`
     - `get_video_summaries`
     - `search_chat_history`
     - `get_recent_context`
     - `get_full_history`
     - `get_compressed_summary`

2. `test_real_runtime_executes_registered_context_tool`
   - 通过真实 `AgentRuntime.execute()` 执行 `get_recent_context`
   - 验证返回真实 `ToolMessage`
   - 验证 runtime metrics 真实记录调用次数

3. `test_real_vector_search_tool_uses_configured_vector_store`
   - 先用真实 `RAGService.search()` 检查向量库是否有数据
   - 再通过真实 `AgentRuntime.execute()` 调用 `vector_search`
   - 如果当前向量库没有数据，该测试会 `skip`，不是通过 mock 伪造结果

4. `test_real_chat_agent_invokes_llm_and_returns_answer`
   - 通过真实 `AgentHarness.invoke("chat", ...)` 调用 Chat Agent
   - 会真实请求配置的 LLM
   - 验证返回非空答案

## 运行前置条件

### 1. 安装依赖

在项目根目录执行：

```bash
pip install -r requirements.txt
pip install pytest pytest-asyncio
```

### 2. 配置真实环境变量

至少需要真实 LLM Key。

Linux/macOS 示例：

```bash
export BILIRAG_REAL_AGENT_HARNESS_TESTS=1
export LLM__API_KEY="你的真实 LLM Key"
```

Windows PowerShell 示例：

```powershell
$env:BILIRAG_REAL_AGENT_HARNESS_TESTS="1"
$env:LLM__API_KEY="你的真实 LLM Key"
```

Windows CMD 示例：

```cmd
set BILIRAG_REAL_AGENT_HARNESS_TESTS=1
set LLM__API_KEY=你的真实 LLM Key
```

如果你使用 DashScope/OpenAI 兼容配置，也可以按项目配置系统设置对应变量，例如：

Linux/macOS：

```bash
export DASHSCOPE_API_KEY="你的真实 DashScope Key"
export LLM__API_KEY="$DASHSCOPE_API_KEY"
```

Windows PowerShell：

```powershell
$env:DASHSCOPE_API_KEY="你的真实 DashScope Key"
$env:LLM__API_KEY=$env:DASHSCOPE_API_KEY
```

Windows CMD：

```cmd
set DASHSCOPE_API_KEY=你的真实 DashScope Key
set LLM__API_KEY=%DASHSCOPE_API_KEY%
```

数据库建议显式指定，避免连到错误环境：

Linux/macOS：

```bash
export RDBMS__URL="sqlite+aiosqlite:///./data/mind_base.db"
```

Windows PowerShell：

```powershell
$env:RDBMS__URL="sqlite+aiosqlite:///./data/mind_base.db"
```

Windows CMD：

```cmd
set RDBMS__URL=sqlite+aiosqlite:///./data/mind_base.db
```

如果你要测真实 Milvus/向量库，请确保 `app/config/default.yaml`、`app/config/config.yaml`、`app/config/local.yaml` 或环境变量里的 Milvus 配置指向你的真实实例。

### 3. 准备真实数据

如果只想验证 harness 启动、工具发现、context tool 和 LLM 调用，不需要先构建知识库。

如果要让 `vector_search` 测试真正执行检索并通过，需要先保证向量库里已有数据。可以先运行项目已有诊断脚本：

```bash
python -m app.test.diagnose_rag
```

你应看到类似：

```text
向量库总文档数: 123
✅ 向量库有数据。
搜索结果数量: 3
```

如果向量库为空，`test_real_vector_search_tool_uses_configured_vector_store` 会被跳过。

## 运行命令

只运行这个真实测试目录：

```bash
pytest app/test/real_agent_harness -v -s
```

运行单个测试：

```bash
pytest app/test/real_agent_harness/test_real_agent_harness.py::test_real_harness_startup_discovers_tools_and_agents -v -s
```

运行真实 Chat Agent + LLM 测试：

```bash
pytest app/test/real_agent_harness/test_real_agent_harness.py::test_real_chat_agent_invokes_llm_and_returns_answer -v -s
```

## 预期结果

理想情况下：

```text
4 passed
```

如果没有向量数据，可能是：

```text
3 passed, 1 skipped
```

这里的 `skipped` 表示当前真实向量库没有可检索数据，不表示 mock 成功。

## 常见失败说明

### 没设置开关

如果没有设置真实测试开关，测试会全部 skip，避免误把真实测试混入普通测试套件。

Linux/macOS：

```bash
export BILIRAG_REAL_AGENT_HARNESS_TESTS=1
```

Windows PowerShell：

```powershell
$env:BILIRAG_REAL_AGENT_HARNESS_TESTS="1"
```

Windows CMD：

```cmd
set BILIRAG_REAL_AGENT_HARNESS_TESTS=1
```

### LLM 未配置

错误类似：

```text
真实 LLM 未配置：请设置 LLM__API_KEY 或兼容配置
```

说明 `_get_harness_llm()` 没能构造真实 LLM。

### 工具发现失败

如果 `health["tools"]["failed"] != 0`，说明 `ToolManager.discover()` 中有工具真实加载失败。请查看 pytest 输出和日志里的 `[TOOLS]` 报告。

### Chat Agent 超时

`test_real_chat_agent_invokes_llm_and_returns_answer` 默认 timeout 是 90 秒。如果失败，通常是：

- LLM Key 不可用
- base_url 配错
- 网络不可达
- 模型名不可用

### vector_search 被 skip

先运行：

```bash
python -m app.test.diagnose_rag
```

确认真实向量库有数据后再跑。

## 注意事项

这些测试会消耗真实 LLM 调用额度。

不要用：

```bash
pytest app/test
```

来评估真实 Agent/Harness 效果，因为 `app/test` 下仍有大量 mock 单元测试。请只运行：

```bash
pytest app/test/real_agent_harness -v -s
```

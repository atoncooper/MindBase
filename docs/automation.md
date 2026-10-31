# 自动化任务（AI 监督型长任务）

面向「AI 通过工具发起、可能运行数分钟到上百小时」的任务（模型训练、长构建、批处理脚本）。
核心原则：**日志正文只落文件系统，数据库只存索引；AI 只拿有界摘要；等待与上报由后台完成，模型不轮询。**

## 1. 目录与数据库

~~~text
<data_dir>/automation/<task_id>/<YYYY-MM-DD>/<YYYY-MM-DD>T<HH-mm-ss>_run-<run_id>.log
<data_dir>/automation/<task_id>/<YYYY-MM-DD>/<YYYY-MM-DD>T<HH-mm-ss>_run-<run_id>.err.log
~~~

| 表 | 作用 |
|---|---|
| automation_tasks | 任务定义：command/cwd/interval_secs/max_attempts/state/attempt/last_report_at |
| automation_runs | 每次尝试：pid、started_at/ended_at、exit_code、state、restart_reason |
| automation_logs | 日志段指针：path/kind/offset/bytes（正文不入库） |
| automation_reports | 每次上报的摘要 + 尾部片段（供事后追溯，不重放给模型） |

## 2. 工具面（agent 层）

| 工具 | 作用 | 返回预算 |
|---|---|---|
| automation_start | 启动长任务，立即返回 task_id | < 500B |
| automation_status | 状态 + 已运行时长 + 尾部 4KB + 日志路径 + 最近报告 | < 6KB |
| automation_log_search | 关键字检索（最多 50 条命中 + 行号） | < 8KB |
| automation_log_read | 按 offset/limit 读最新 stdout | <= 64KB |
| automation_kill | 杀进程树，标记 stopped | < 100B |
| automation_retry | 在 max_attempts 内重试，reason 写入 runs | < 300B |
| automation_due | 调度器入口：返回到期任务的上下文包并落报告 | 有界摘要 |
| automation_list | 列出最近任务 | 20 行以内 |

## 3. 报告节奏与去重

- 调度器（应用后台，不是模型）定时调用 automation_due；
- running 任务：距上次报告 >= interval_secs 才到期；
- 终态（succeeded/failed/interrupted/stopped）：首次出现立即到期一次；
- 同一种 kind 的报告不会连续重复（latest_report_kind 去重）；
- 多个任务同时到期时一次返回（合并成一次 AI 回合）。

## 4. 中断 / 重试 / 恢复

- 进程退出由监控线程写回 automation_runs / automation_tasks；
- 应用重启：Child 句柄丢失 -> 启动时 supervisor::reconcile 把所有 running/pending
  任务标记 interrupted，避免「以为还在跑」；
- 重试：automation_retry（attempt+1，受 max_attempts 限制，reason 落库）；
- 建议训练类任务自带 checkpoint，重试从断点续跑。

## 5. 上下文管理（省 token）

- 模型每次只看 automation_status / automation_due 的上下文包：状态 + 尾部日志 + 指针；
- 需要细节时按需 automation_log_search / automation_log_read（offset/limit）；
- 历史报告完整内容在 automation_reports，模型上下文只保留最近 3 条摘要；
- 单次工具返回均有硬上限；长任务不要在 ReAct 循环里反复 automation_status，
  等待由后台线程/调度器完成。

## 6. Token 消耗统计（DSH 风格）

- 每个完成的 assistant 回合写一行 llm_usage：session_id / purpose / model / task_id +
  input_tokens / output_tokens / cached_tokens / total_tokens；
- 缓存命中字段兼容 DeepSeek（prompt_cache_hit_tokens）、OpenAI（prompt_tokens_details.cached_tokens）、
  Anthropic（cache_read_input_tokens）；
- usage_stats 工具（近 N 天，默认 1，最多 30）：总览 + 按模型 + 会话 Top 5 + 按天；
  自动化任务建议用 automation-<task_id> 作为会话 id，即可在会话排行里看到它的成本；
  传 task_id 可查单任务累计（等调度器把 task_id 写入账本后生效）；
- 前端后续可在设置页直接展示同一套聚合（infra::usage 已抽出 summary_text）。

## 7. 测试

- tests/automation/（非 agent，直接驱动包 API）：日志分区、成功/失败/终止、报告去重；
- tests/agent/automation.rs：工具门禁与 start -> status -> search -> kill 全链路。

## 8. 后续

- UI 任务卡（进度/取消/重试）；
- 应用退出时是否允许子进程继续运行（detached + pid reattach）；
- 日志配额清理（按 task 总大小淘汰最旧 run）；
- 失败签名识别（OOM/CUDA/网络）与自动重试策略。

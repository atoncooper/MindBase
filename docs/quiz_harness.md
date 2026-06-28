# Quiz AI 质量评测 Harness

离线评测 Quiz 出题与批改质量，用于 Prompt / 模型 / schema 改动前后的回归对比。
**不耦合线上请求路径**，独立 CLI 运行。

## 运行

```bash
# 默认 3 轮，结果打印到 stdout
python -m scripts.run_quiz_harness

# 指定轮数与输出文件
python -m scripts.run_quiz_harness --rounds 5 --output reports/quiz_harness_20260625.json
```

## 指标定义

| 指标 | 含义 | 建议阈值 |
|------|------|---------|
| `generation_success_rate` | 成功生成题目的轮数占比 | ≥ 0.95 |
| `schema_parse_rate` | LLM 返回合法 structured output 的比例 | ≥ 0.95 |
| `traceability_rate` | 答案能溯源到原文的题目占比 | ≥ 0.85 |
| `type_distribution_match_rate` | 实际题型分布匹配请求分布的比例 | ≥ 0.90 |
| `grading_consistency_max_variance` | 同题 3 次批改分数的最大方差 | ≤ 2.0 |
| `avg_token_cost` | 单题平均 token 消耗 | 用于成本监控，无硬阈值 |

## 使用场景

1. **Prompt 改动**：改动 `app/agent/quiz/prompts.py` 前后各跑一次，对比指标
2. **模型切换**：切换 `settings.llm_model` 后跑 harness 确认质量未下降
3. **Schema 变更**：改动 `app/agent/quiz/schemas.py` 后验证 LLM 仍能稳定产出
4. **定期回归**：CI 中定期跑，监控 LLM provider 升级带来的质量漂移

## 样本集

当前样本集在 `app/agent/quiz/harness/__init__.py:SAMPLE_CHUNKS`，包含 2 个固定知识片段。
扩充样本集时需同步更新 golden 预期（待实现）。

## 局限

- 依赖真实 LLM API（需配置 `LLM__API_KEY`）
- 非确定性结果，建议多轮取均值
- 当前未实现 golden 题目集对比（仅指标采集）

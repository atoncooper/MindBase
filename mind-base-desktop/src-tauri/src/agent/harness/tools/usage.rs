//! usage_stats 工具：LLM token 消耗统计（DeepSeek-Harness 风格：输入/输出/缓存/合计）。

use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::infra::usage;

use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};
use super::common::spec;

fn conn(ctx: &ToolContext) -> std::sync::Arc<Mutex<Connection>> {
    ctx.db.conn.clone()
}

pub(crate) struct UsageStatsTool;

static SPEC_USAGE_STATS: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "usage_stats",
        "统计 LLM token 消耗（近 N 天，默认 1，最多 30）：调用次数、输入/输出/缓存命中/合计，\
         并按模型、会话 Top 5、按天分组。用于回答「这个任务/今天花了多少 token」。\
         数据来自 llm_usage 账本：每个完成的 assistant 回合一行；自动化任务建议使用 \
         automation-<task_id> 作为会话 id，即可在「会话 Top 5」里看到它的消耗。",
        json!({
            "type": "object",
            "properties": {
                "days": {"type": "integer", "minimum": 1, "maximum": 30, "description": "统计最近多少天（默认 1）"},
                "task_id": {"type": "integer", "minimum": 1, "description": "可选：只看某个自动化任务的累计消耗"}
            }
        }),
    )
});

impl LocalTool for UsageStatsTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_USAGE_STATS
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
        let days = value
            .get("days")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 30) as u32;
        let db = conn(ctx);
        let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
        let mut out = String::new();
        if let Some(task_id) = value.get("task_id").and_then(Value::as_i64) {
            let since = crate::automation::now_secs() - days as i64 * 86_400;
            let totals = usage::totals_for_task(&guard, task_id, since)?;
            out.push_str(&format!(
                "自动化任务 #{task_id}（近 {days} 天）：{} 次 · 输入 {} · 输出 {} · 缓存 {} · 合计 {}\n\n",
                totals.calls,
                totals.input_tokens,
                totals.output_tokens,
                totals.cached_tokens,
                totals.total_tokens
            ));
        }
        out.push_str(&usage::summary_text(&guard, days)?);
        Ok(ToolOutput::text(out))
    }
}

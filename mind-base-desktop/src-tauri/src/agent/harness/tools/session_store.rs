//! Conversation-store readers: history index, turn/error readers and full-text session search.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::common::{optional_int, optional_str, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// Store readers + agent private memory (plan/1.0.10-AgentMemory §4):
// summary-first progressive disclosure over the conversation store, plus
// per-agent self-managed memory files.
// ---------------------------------------------------------------------------

fn conversations_root(ctx: &ToolContext) -> Result<PathBuf, String> {
    let dir = ctx
        .db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
    Ok(dir.join("conversations").join(&ctx.session_id))
}


fn render_index_digest(records: &[Value], limit: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for record in records.iter().rev().take(limit) {
        let turn_id = record["turn_id"].as_str().unwrap_or("?");
        let preview = record["q_preview"].as_str().unwrap_or("");
        let summary = record["summary"].as_str().unwrap_or("");
        let status = record["status"].as_str().unwrap_or("completed");
        lines.push(format!(
            "- [{turn_id} · {status}] 问：{preview} → {summary}"
        ));
    }
    lines
}

pub(crate) struct ListHistoryTool;

impl LocalTool for ListHistoryTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_LIST_HISTORY
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let limit = optional_int(arguments, "limit").unwrap_or(20).clamp(1, 100) as usize;
        let root = conversations_root(ctx)?;
        let records = crate::infra::store::list_records(&root.join("index.jsonl"))?;
        if records.is_empty() {
            return Ok(ToolOutput::text(
                "【会话历史索引】本会话尚无存储的问答。".to_string(),
            ));
        }
        let lines = render_index_digest(&records, limit);
        Ok(ToolOutput::text(format!(
            "【会话历史索引 — 总结清单（新→旧）；需要全文时用 read_turn(turn_id, \"full\")】\n{}",
            lines.join("\n")
        )))
    }
}

static SPEC_LIST_HISTORY: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "list_history",
        "列出本会话的历史问答索引（每条含总结，新→旧）。回忆本会话聊过什么、定位某个此前的回答时调用；先看总结，需要全文再用 read_turn。",
        json!({
            "type": "object",
            "properties": {
                "limit": { "type": "integer", "description": "条数，默认 20" }
            }
        }),
    )
});

pub(crate) struct ReadTurnTool;

impl LocalTool for ReadTurnTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_READ_TURN
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let turn_id = super::super::registry::require_string_arg(arguments, "turn_id")?;
        let section = optional_str(arguments, "section").unwrap_or_else(|| "summary".to_string());
        let root = conversations_root(ctx)?;
        let records = crate::infra::store::list_records(&root.join("index.jsonl"))?;
        let record = records
            .iter()
            .find(|record| record["turn_id"].as_str() == Some(turn_id.as_str()))
            .ok_or_else(|| format!("未找到 turn `{turn_id}`；可用清单见 list_history"))?;

        if section == "summary" {
            return Ok(ToolOutput::text(format!(
                "[{turn_id} · {}]\n{}",
                record["agent"].as_str().unwrap_or("?"),
                record["summary"].as_str().unwrap_or("")
            )));
        }
        let user: crate::infra::store::Span =
            serde_json::from_value(record["user"].clone()).map_err(|err| err.to_string())?;
        let resp: crate::infra::store::Span =
            serde_json::from_value(record["resp"].clone()).map_err(|err| err.to_string())?;
        let user_text = crate::infra::store::read_span(&root, &user)?;
        let resp_text = crate::infra::store::read_span(&root, &resp)?;
        Ok(ToolOutput::text(format!(
            "{user_text}\n\n---\n\n{resp_text}"
        )))
    }
}

static SPEC_READ_TURN: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "read_turn",
        "读取本会话某一次问答的内容。默认返回总结；section=\"full\" 返回完整问答原文。",
        json!({
            "type": "object",
            "properties": {
                "turn_id": { "type": "string", "description": "问答 id（list_history 清单方括号内）" },
                "section": { "type": "string", "description": "summary（默认）或 full" }
            },
            "required": ["turn_id"]
        }),
    )
});

pub(crate) struct ListErrorsTool;

impl LocalTool for ListErrorsTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_LIST_ERRORS
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let limit = optional_int(arguments, "limit").unwrap_or(20).clamp(1, 100) as usize;
        let root = conversations_root(ctx)?;
        let records = crate::infra::store::list_records(&root.join("errors.jsonl"))?;
        let open: Vec<&Value> = records.iter().rev().take(limit).collect();
        if open.is_empty() {
            return Ok(ToolOutput::text(
                "【错误索引】本会话暂无错误记录。".to_string(),
            ));
        }
        let lines: Vec<String> = open
            .iter()
            .map(|record| {
                format!(
                    "- [{} · {} · {}] {}",
                    record["err_id"].as_str().unwrap_or("?"),
                    record["error_kind"].as_str().unwrap_or("?"),
                    record["status"].as_str().unwrap_or("?"),
                    record["summary"].as_str().unwrap_or("")
                )
            })
            .collect();
        Ok(ToolOutput::text(format!(
            "【错误索引（新→旧）；需要完整 traceback 时用 read_error(err_id, full=true)】\n{}",
            lines.join("\n")
        )))
    }
}

static SPEC_LIST_ERRORS: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "list_errors",
        "列出本会话记录的错误清单（每条含摘要与状态）。排查此前执行失败、回顾故障时调用。",
        json!({
            "type": "object",
            "properties": {
                "limit": { "type": "integer", "description": "条数，默认 20" }
            }
        }),
    )
});

pub(crate) struct ReadErrorTool;

impl LocalTool for ReadErrorTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_READ_ERROR
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let err_id = super::super::registry::require_string_arg(arguments, "err_id")?;
        let full = arguments.contains("\"full\": true") || arguments.contains("\"full\":true");
        let root = conversations_root(ctx)?;
        let records = crate::infra::store::list_records(&root.join("errors.jsonl"))?;
        let record = records
            .iter()
            .find(|record| record["err_id"].as_str() == Some(err_id.as_str()))
            .ok_or_else(|| format!("未找到错误 `{err_id}`；可用清单见 list_errors"))?;
        let summary = format!(
            "[{} · {} · {}]\n{}",
            record["err_id"].as_str().unwrap_or("?"),
            record["error_kind"].as_str().unwrap_or("?"),
            record["status"].as_str().unwrap_or("?"),
            record["summary"].as_str().unwrap_or("")
        );
        if !full {
            return Ok(ToolOutput::text(summary));
        }
        let detail: crate::infra::store::Span =
            serde_json::from_value(record["detail"].clone()).map_err(|err| err.to_string())?;
        let text = crate::infra::store::read_span(&root, &detail)?;
        Ok(ToolOutput::text(format!(
            "{summary}\n\n--- 完整记录 ---\n{text}"
        )))
    }
}

static SPEC_READ_ERROR: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "read_error",
        "读取一条错误记录。默认返回摘要；full=true 返回完整 traceback/输出。按需决定阅读深度。",
        json!({
            "type": "object",
            "properties": {
                "err_id": { "type": "string", "description": "错误 id（list_errors 清单方括号内）" },
                "full": { "type": "boolean", "description": "true = 展开完整记录" }
            },
            "required": ["err_id"]
        }),
    )
});

pub(crate) struct SearchContentTool;

impl LocalTool for SearchContentTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_SEARCH_CONTENT
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let query = super::super::registry::require_string_arg(arguments, "query")?;
        let root = conversations_root(ctx)?;
        let hits = crate::infra::store::grep_parts(&root, &query)?;
        if hits.is_empty() {
            return Ok(ToolOutput::text(format!(
                "（本会话存储中没有匹配「{query}」的内容）"
            )));
        }
        // Resolve each hit back to its turn via the index spans.
        let records = crate::infra::store::list_records(&root.join("index.jsonl"))?;
        let lines: Vec<String> = hits
            .iter()
            .map(|(file, line_no, line)| {
                let owner = records
                    .iter()
                    .find(|record| {
                        ["user", "resp"].iter().any(|side| {
                            let span = &record[side];
                            span["file"].as_str() == Some(file.as_str())
                                && span["start"]
                                    .as_u64()
                                    .map(|s| *line_no as u64 >= s)
                                    .unwrap_or(false)
                                && span["end"]
                                    .as_u64()
                                    .map(|e| *line_no as u64 <= e)
                                    .unwrap_or(false)
                        })
                    })
                    .map(|record| format!("（属于 {}）", record["turn_id"].as_str().unwrap_or("?")))
                    .unwrap_or_default();
                format!("- {file}:{line_no}{owner} · {line}")
            })
            .collect();
        Ok(ToolOutput::text(format!(
            "【会话内容检索 — {query}】\n{}",
            lines.join("\n")
        )))
    }
}

static SPEC_SEARCH_CONTENT: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "search_content",
        "在本会话的存储全文（对话正文/错误记录）中按关键词 grep，命中会标注所属问答 id。精确回忆某个词句出现过的位置时调用。",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "要检索的关键词（子串匹配）" }
            },
            "required": ["query"]
        }),
    )
});

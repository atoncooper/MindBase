//! Note tools: thin wrappers over the connection-scoped notes.rs internals.

use serde_json::{json, Value};

use super::common::{lock_err, now_secs_helper, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// Note tools — thin wrappers over notes.rs connection-scoped internals
// ---------------------------------------------------------------------------

pub(crate) struct SaveNoteTool;

impl LocalTool for SaveNoteTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_SAVE_NOTE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let title = value
            .get("title")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("未命名笔记")
            .to_string();
        let content_md = value
            .get("content_md")
            .and_then(|c| c.as_str())
            .unwrap_or_default();

        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let id = crate::workspace::notes::note_create_internal(&conn, &title)?;
        let result = crate::workspace::notes::note_update_internal(
            &conn,
            &id,
            content_md,
            crate::workspace::notes::note_updated_at(&conn, &id)?,
            now_secs_helper(),
        )?;
        Ok(ToolOutput::text(format!(
            "已保存笔记《{}》（{} 字）",
            title, result.char_count
        )))
    }
}

static SPEC_SAVE_NOTE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "save_note",
        "创建一篇 Markdown 笔记并保存。",
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "笔记标题" },
                "content_md": { "type": "string", "description": "完整 Markdown 正文" }
            },
            "required": ["title", "content_md"]
        }),
    )
});

pub(crate) struct ListNotesTool;

impl LocalTool for ListNotesTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_LIST_NOTES
    }

    fn execute(&self, ctx: &ToolContext, _arguments: &str) -> Result<ToolOutput, String> {
        let guard = ctx.db.conn.lock().map_err(lock_err)?;
        let rows = crate::workspace::notes::notes_list_internal(&guard, None)?;
        if rows.is_empty() {
            return Ok(ToolOutput::text("（还没有任何笔记）"));
        }
        let lines: Vec<String> = rows
            .iter()
            .map(|row| {
                format!(
                    "- 《{}》 id={} · {} 字 · {}",
                    if row.title.is_empty() {
                        "未命名笔记"
                    } else {
                        &row.title
                    },
                    row.id,
                    row.char_count,
                    crate::agent::chat::epoch_to_date(row.updated_at)
                )
            })
            .collect();
        Ok(ToolOutput::text(format!(
            "共 {} 篇笔记：\n{}",
            rows.len(),
            lines.join("\n")
        )))
    }
}

static SPEC_LIST_NOTES: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "list_notes",
        "列出用户的全部笔记（标题与 id）。",
        json!({ "type": "object", "properties": {} }),
    )
});

pub(crate) struct GetNoteTool;

impl LocalTool for GetNoteTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_GET_NOTE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let note_id = super::super::registry::require_string_arg(arguments, "note_id")?;
        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let detail = crate::workspace::notes::get_detail_conn(&conn, &note_id)?
            .ok_or_else(|| "笔记不存在：请先用 list_notes 确认 id".to_string())?;
        Ok(ToolOutput::text(format!(
            "《{}》（{} 字）\n{}",
            detail.title,
            detail.content.chars().count(),
            detail.content
        )))
    }
}

static SPEC_GET_NOTE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "get_note",
        "读取一篇笔记的完整 Markdown 正文。修改前必须先调用它获取当前内容。",
        json!({
            "type": "object",
            "properties": {
                "note_id": { "type": "string", "description": "笔记 id（来自 list_notes）" }
            },
            "required": ["note_id"]
        }),
    )
});

pub(crate) struct UpdateNoteTool;

impl LocalTool for UpdateNoteTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_UPDATE_NOTE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let note_id = value
            .get("note_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let content_md = value
            .get("content_md")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let title = value
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty());

        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let expected = crate::workspace::notes::note_updated_at(&conn, &note_id)?;
        let result = crate::workspace::notes::note_update_internal(
            &conn,
            &note_id,
            &content_md,
            expected,
            now_secs_helper(),
        )?;
        if let Some(title) = title {
            crate::workspace::notes::rename_note_internal(&conn, &note_id, title, now_secs_helper())?;
        }
        Ok(ToolOutput::text(format!(
            "已更新笔记（{} 字）",
            result.char_count
        )))
    }
}

static SPEC_UPDATE_NOTE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "update_note",
        "全量替换一篇笔记的正文（修改前必须先 get_note 获取现状）。可选同时改标题。",
        json!({
            "type": "object",
            "properties": {
                "note_id": { "type": "string", "description": "笔记 id" },
                "content_md": { "type": "string", "description": "替换后的完整 Markdown 正文" },
                "title": { "type": "string", "description": "可选的新标题" }
            },
            "required": ["note_id", "content_md"]
        }),
    )
});

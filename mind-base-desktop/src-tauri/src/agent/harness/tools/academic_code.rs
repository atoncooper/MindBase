//! academic_code — 科研项目内的代码/文档读写工具。
//!
//! 让科研 agent 能自己把分析脚本、研究计划、论文草稿落到项目目录：
//! - 所有路径都锚定在 `<data_dir>/research/<project_id>` 内，越界（含 .. / 绝对路径逃逸）拒绝；
//! - 只允许写代码/文本白名单扩展名；不写 `data/original` 下的原始数据；
//! - 每次写入追加 `project_events` 事件（type=code.written），审计失败不影响写入。

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};
use super::common::spec;

/// 单次读取上限（超出截断并提示）。
const READ_CAP: usize = 200 * 1024;
/// 单次写入上限。
const WRITE_CAP: usize = 2 * 1024 * 1024;
/// 目录列举上限。
const LIST_CAP: usize = 200;

/// 允许写入的扩展名（小写比较，.r/.R、.yaml/.yml 均可）。
const ALLOWED_EXT: [&str; 10] = [
    "py", "r", "sh", "sql", "ipynb", "md", "txt", "json", "yaml", "yml",
];

fn conn(ctx: &ToolContext) -> std::sync::Arc<std::sync::Mutex<rusqlite::Connection>> {
    ctx.db.conn.clone()
}

fn project_root(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir.join("research").join(project_id)
}

/// 词法规约 `.` / `..`（与 tools::files 同一套边界策略，但锚点是项目根）。
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = out.pop();
            }
            Component::Normal(segment) => out.push(segment),
        }
    }
    out
}

/// canonicalize 最近的已存在祖先，再把不存在的尾段拼回去（符号链接安全）。
fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(mut resolved) => {
                for segment in tail.iter().rev() {
                    resolved.push(segment);
                }
                return Ok(resolved);
            }
            Err(_) => match existing.file_name().map(|name| name.to_os_string()) {
                Some(name) => {
                    tail.push(name);
                    if !existing.pop() {
                        return Err("无法解析路径（没有可用的祖先目录）".to_string());
                    }
                }
                None => return Err("无法解析路径（没有可用的祖先目录）".to_string()),
            },
        }
    }
}

const PATH_ESCAPE_MESSAGE: &str = "路径越界：只能访问当前科研项目目录内的文件";

/// 把工具给的 path 解析成项目根内的真实路径。
fn resolve_in_project(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("path 不能为空".to_string());
    }
    // 项目目录按需创建（新建项目/首次写代码时可能还没有目录）。
    std::fs::create_dir_all(root)
        .map_err(|err| format!("创建项目目录失败（{}）：{err}", root.display()))?;
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|err| format!("无法解析项目目录（{}）：{err}", root.display()))?;
    let raw_path = Path::new(raw);
    let candidate = if raw_path.is_absolute() {
        lexical_normalize(raw_path)
    } else {
        lexical_normalize(&root.join(raw_path))
    };
    let resolved = canonicalize_with_missing_tail(&candidate)?;
    if resolved.starts_with(&canonical_root) {
        Ok(candidate)
    } else {
        Err(PATH_ESCAPE_MESSAGE.to_string())
    }
}

/// 相对项目根的展示路径（统一用 `/` 分隔）。
fn relative_to_root(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

fn ensure_project(ctx: &ToolContext, project_id: &str) -> Result<(), String> {
    let db_conn = conn(ctx);
    let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
    let exists = crate::repositories::research::projects::exists(&guard, project_id)
        .map_err(String::from)?;
    if exists {
        Ok(())
    } else {
        Err(format!("研究项目不存在：{project_id}"))
    }
}

/// 追加一条项目事件（审计旁路：失败不影响主流程）。
fn record_event(ctx: &ToolContext, project_id: &str, kind: &str, payload: &Value) {
    {
        let db_conn = conn(ctx);
        if let Ok(guard) = db_conn.lock() {
            let _ = crate::repositories::research::events::append(
                &guard,
                project_id,
                "agent",
                kind,
                &payload.to_string(),
                crate::automation::now_secs(),
            );
        };
    }
}

fn read_text(root: &Path, raw: &str) -> Result<String, String> {
    let path = resolve_in_project(root, raw)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|err| format!("无法读取文件信息（{}）：{err}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "{} 不是文件（目录请用 action=list）",
            path.display()
        ));
    }
    let bytes =
        std::fs::read(&path).map_err(|err| format!("读取文件失败（{}）：{err}", path.display()))?;
    if bytes.contains(&0) {
        return Err("这是二进制文件，无法按文本读取".to_string());
    }
    let rel = relative_to_root(root, &path);
    let truncated = bytes.len() > READ_CAP;
    let slice = &bytes[..bytes.len().min(READ_CAP)];
    let text = String::from_utf8_lossy(slice).to_string();
    let mut header = format!(
        "已读取 {rel}（{} 字节 / {} 行）",
        metadata.len(),
        text.lines().count()
    );
    if truncated {
        header.push_str(&format!(
            "；文件超过 {} KB，已截断（如需更多请用 read_file 分段读取绝对路径 {}）",
            READ_CAP / 1024,
            path.display()
        ));
    }
    Ok(format!("{header}：\n{text}"))
}

fn write_text(
    ctx: &ToolContext,
    project_id: &str,
    root: &Path,
    raw: &str,
    content: &str,
) -> Result<String, String> {
    let path = resolve_in_project(root, raw)?;
    let rel = relative_to_root(root, &path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXT.contains(&extension.as_str()) {
        return Err(format!(
            "不允许写入该扩展名「{}」（仅支持 {}）",
            if extension.is_empty() {
                "无扩展名"
            } else {
                extension.as_str()
            },
            ALLOWED_EXT.join(" / ")
        ));
    }
    let lower_rel = rel.to_ascii_lowercase();
    if lower_rel == "data/original" || lower_rel.starts_with("data/original/") {
        return Err("data/original 下是原始数据，不允许写入或覆盖".to_string());
    }
    if path.is_dir() {
        return Err(format!("{} 是目录，请给出完整的文件路径", path.display()));
    }
    if content.len() > WRITE_CAP {
        return Err(format!(
            "内容过大（{} 字节，上限 {WRITE_CAP}）",
            content.len()
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建目录失败（{}）：{err}", parent.display()))?;
    }
    std::fs::write(&path, content)
        .map_err(|err| format!("写入文件失败（{}）：{err}", path.display()))?;
    let bytes = content.len();
    let lines = content.lines().count();
    record_event(
        ctx,
        project_id,
        "code.written",
        &json!({"path": rel, "bytes": bytes}),
    );
    Ok(format!(
        "已写入 {rel}（{bytes} 字节 / {lines} 行）。依赖已导入数据集时可再用 academic_evidence(analysis_run) 运行脚本并登记实验；回复中给出该相对路径。"
    ))
}

fn list_dir(root: &Path, raw: Option<&str>) -> Result<String, String> {
    let dir = match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => resolve_in_project(root, raw)?,
        None => root.to_path_buf(),
    };
    if !dir.is_dir() {
        return Err(format!("{} 不是目录", dir.display()));
    }
    let entries = std::fs::read_dir(&dir)
        .map_err(|err| format!("无法列出目录（{}）：{err}", dir.display()))?;
    let mut lines: Vec<String> = Vec::new();
    let mut sorted: Vec<(String, bool, u64)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏目录/文件（.git / .venv 等）不进上下文。
        if name.starts_with('.') {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        sorted.push((name, metadata.is_dir(), metadata.len()));
    }
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, is_dir, len) in sorted {
        if lines.len() == LIST_CAP {
            lines.push(format!("…（超过 {LIST_CAP} 项，已截断）"));
            break;
        }
        let display = relative_to_root(root, &dir.join(&name));
        if is_dir {
            lines.push(format!("[目录] {display}/"));
        } else {
            lines.push(format!("[文件] {display}（{len} 字节）"));
        }
    }
    let shown = relative_to_root(root, &dir);
    let shown = if shown.is_empty() {
        "（项目根）".to_string()
    } else {
        format!("{shown}/")
    };
    if lines.is_empty() {
        return Ok(format!("{shown} 是空目录"));
    }
    Ok(format!("{shown}：\n{}", lines.join("\n")))
}

pub(crate) struct AcademicCodeTool;

static SPEC_ACADEMIC_CODE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "academic_code",
        "科研项目代码/文档工具：往当前科研项目目录（<data_dir>/research/<project_id>）写分析脚本、研究计划或论文草稿，并列出/读取项目文件。\
         action：list=列项目目录（可选 path，默认项目根；不含 .git 等隐藏项）；read=读文本文件（≤200KB，超出截断）；\
         write=写入/覆盖文本文件（自动建父目录；扩展名限 .py/.r/.sh/.sql/.ipynb/.md/.txt/.json/.yaml/.yml；每次写入记 code.written 事件）。\
         需要 project_id；read/write 需要 path（项目内相对路径，如 analysis/scripts/run.py）。\
         用于写分析代码与计划/草稿；写完可用 academic_evidence(action=analysis_run) 在项目根运行脚本并登记实验。\
         不要写 data/original 下的原始数据；不要编造脚本运行结果。",
        json!({
            "type": "object",
            "required": ["action", "project_id"],
            "properties": {
                "action": {"type": "string", "enum": ["list", "read", "write"]},
                "project_id": {"type": "string", "description": "研究项目 id"},
                "path": {"type": "string", "description": "项目内相对路径（如 analysis/scripts/run.py；list 可省略=项目根）"},
                "content": {"type": "string", "description": "write 的完整文本内容"}
            }
        }),
    )
});

impl LocalTool for AcademicCodeTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_ACADEMIC_CODE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let project_id = value
            .get("project_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or("缺少 project_id")?;
        ensure_project(ctx, project_id)?;
        let data_dir = ctx
            .db
            .data_dir
            .lock()
            .map_err(|err| format!("获取数据目录锁失败：{err}"))?
            .clone();
        let root = project_root(std::path::Path::new(&data_dir), project_id);
        match action {
            "list" => {
                let path = value.get("path").and_then(Value::as_str);
                Ok(ToolOutput::text(list_dir(&root, path)?))
            }
            "read" => {
                let path = value
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("read 需要 path")?;
                Ok(ToolOutput::text(read_text(&root, path)?))
            }
            "write" => {
                let path = value
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("write 需要 path")?;
                let content = value
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or("write 需要 content")?;
                Ok(ToolOutput::text(write_text(
                    ctx, project_id, &root, path, content,
                )?))
            }
            other => Err(format!(
                "不支持的 action：{other}（可选 list / read / write）"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn test_ctx(tag: &str) -> (ToolContext, PathBuf, String) {
        let conn = rusqlite::Connection::open_in_memory().expect("内存数据库");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL)
            .expect("建表");
        let data_dir = std::env::temp_dir().join(format!(
            "mb-academic-code-{tag}-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&data_dir).expect("数据目录");
        let project_id = format!("project-code-{tag}");
        let project = crate::workspace::research::ResearchProject {
            id: project_id.clone(),
            title: "代码测试项目".to_string(),
            paper_kind: "journal".to_string(),
            field: String::new(),
            language: "zh".to_string(),
            target_venue: String::new(),
            current_stage: "experiment".to_string(),
            privacy: "local".to_string(),
            deadline: String::new(),
            meta_json: "{}".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        crate::repositories::research::projects::insert(&conn, &project).expect("insert project");
        let ctx = ToolContext {
            db: crate::infra::db::Db {
                conn: Arc::new(Mutex::new(conn)),
                data_dir: Arc::new(Mutex::new(data_dir.clone())),
                default_dir: data_dir.clone(),
            },
            embed_client: None,
            chat_client: None,
            session_id: "test".to_string(),
            agent: crate::agent::agents::AgentKind::Research,
            delegate: None,
        };
        (ctx, data_dir, project_id)
    }

    fn run(ctx: &ToolContext, project_id: &str, mut args: Value) -> Result<String, String> {
        if let Some(object) = args.as_object_mut() {
            object.insert("project_id".to_string(), json!(project_id));
        }
        AcademicCodeTool
            .execute(ctx, &args.to_string())
            .map(|output| output.content)
    }

    #[test]
    fn write_creates_file_and_records_code_written_event() {
        let (ctx, data_dir, project_id) = test_ctx("write");
        let out = run(
            &ctx,
            &project_id,
            json!({"action": "write", "path": "analysis/scripts/run.py", "content": "print('hi')\n"}),
        )
        .expect("write");
        assert!(out.contains("analysis/scripts/run.py"), "unexpected: {out}");
        let path = data_dir
            .join("research")
            .join(&project_id)
            .join("analysis/scripts/run.py");
        assert!(path.is_file(), "file must be written");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "print('hi')\n"
        );

        let guard = ctx.db.conn.lock().expect("db lock");
        let (kind, payload): (String, String) = guard
            .query_row(
                "SELECT type, payload_json FROM project_events WHERE project_id = ?1 ORDER BY id DESC LIMIT 1",
                rusqlite::params![project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("event row");
        assert_eq!(kind, "code.written");
        let payload: Value = serde_json::from_str(&payload).expect("payload json");
        assert_eq!(payload["path"], "analysis/scripts/run.py");
        assert_eq!(payload["bytes"], 12);
        drop(guard);

        // list 能看到刚写入的文件；read 能读回正文。
        let listed = run(&ctx, &project_id, json!({"action": "list"})).expect("list");
        assert!(listed.contains("analysis/"), "unexpected list: {listed}");
        let read = run(
            &ctx,
            &project_id,
            json!({"action": "read", "path": "analysis/scripts/run.py"}),
        )
        .expect("read");
        assert!(read.contains("print('hi')"), "unexpected read: {read}");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn write_rejects_escape_and_unknown_extension() {
        let (ctx, data_dir, project_id) = test_ctx("reject");
        let escape = run(
            &ctx,
            &project_id,
            json!({"action": "write", "path": "../escape.py", "content": "x"}),
        )
        .expect_err("escape must fail");
        assert!(
            escape.contains("路径越界") || escape.contains("项目"),
            "unexpected: {escape}"
        );
        let outside = data_dir.join("outside.py");
        let escape = run(
            &ctx,
            &project_id,
            json!({"action": "write", "path": outside.to_string_lossy(), "content": "x"}),
        )
        .expect_err("absolute outside must fail");
        assert!(escape.contains("路径越界"), "unexpected: {escape}");
        let ext = run(
            &ctx,
            &project_id,
            json!({"action": "write", "path": "analysis/scripts/run.exe", "content": "x"}),
        )
        .expect_err("extension must fail");
        assert!(ext.contains("扩展名"), "unexpected: {ext}");
        let raw = run(
            &ctx,
            &project_id,
            json!({"action": "write", "path": "data/original/raw.py", "content": "x"}),
        )
        .expect_err("raw data must be read-only");
        assert!(raw.contains("data/original"), "unexpected: {raw}");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn unknown_project_is_reported_clearly() {
        let (ctx, data_dir, _project_id) = test_ctx("missing");
        let err = run(&ctx, "no-such-project", json!({"action": "list"}))
            .expect_err("missing project must fail");
        assert!(err.contains("研究项目不存在"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}

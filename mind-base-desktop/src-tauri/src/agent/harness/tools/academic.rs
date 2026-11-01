//! 学术工具：文献检索/导入/导出 + 科研项目简报/阶段流转。
//!
//! 这些工具包住 workspace 里已有的学术能力，让 academic / research agent 不再
//! 只能「动嘴」：能查 Crossref、把文献落库、导出 BibTeX、读项目简报、推进阶段。

use serde_json::{json, Value};

use crate::workspace::literature;
use crate::workspace::research;

use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};
use super::common::spec;

fn conn(ctx: &ToolContext) -> std::sync::Arc<std::sync::Mutex<rusqlite::Connection>> {
    ctx.db.conn.clone()
}

// ---------------------------------------------------------------------------
// academic_literature
// ---------------------------------------------------------------------------

pub(crate) struct AcademicLiteratureTool;

static SPEC_ACADEMIC_LITERATURE: std::sync::LazyLock<ToolSpec> =
    std::sync::LazyLock::new(|| {
        spec(
            "academic_literature",
            "学术文献工具（Crossref + 项目文献库）。action：\
             search=按标题/作者/关键词检索 Crossref（返回标题/作者/年份/期刊/DOI/URL，前 5 条）；\
             list=列出研究项目已导入文献（cite_key/标题/年份/状态）；\
             import=把 BibTeX 或 CSL-JSON 文本导入项目（自动去重、落库、记录事件）；\
             export_bibtex=导出项目全部文献的 BibTeX。\
             search 不需要 project_id；其余 action 需要 project_id（研究项目 id，可用 research_projects_list 或项目控制台获得）。",
            json!({
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": {"type": "string", "enum": ["search", "list", "import", "export_bibtex", "verify", "download"]},
                    "project_id": {"type": "string", "description": "研究项目 id（search 可省略）"},
                    "query": {"type": "string", "description": "search 的检索词（标题/作者/主题）"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 10, "description": "search 返回条数（默认 5）"},
                    "format": {"type": "string", "enum": ["bibtex", "csl"], "description": "import 的输入格式"},
                    "content": {"type": "string", "description": "import 的 BibTeX / CSL-JSON 文本"},
                    "ref_id": {"type": "string", "description": "verify / download 的文献 id（list 返回）"}
                }
            }),
        )
    });

impl LocalTool for AcademicLiteratureTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_ACADEMIC_LITERATURE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let project_id = value
            .get("project_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let require_project = |project: &str| -> Result<(), String> {
            if project.is_empty() {
                Err("该 action 需要 project_id（研究项目 id）".to_string())
            } else {
                Ok(())
            }
        };
        match action {
            "search" => {
                let query = value
                    .get("query")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                let limit = value
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(5)
                    .clamp(1, 10) as usize;
                let hits = literature::search(query, limit)?;
                if hits.is_empty() {
                    return Ok(ToolOutput::text(format!("Crossref 没有检索到「{query}」")));
                }
                let mut out = format!("Crossref 检索「{query}」：\n");
                for (index, hit) in hits.iter().enumerate() {
                    out.push_str(&format!(
                        "{}. {}\n   作者：{} · 年份：{} · 期刊：{}\n   DOI：{} · URL：{}\n",
                        index + 1,
                        hit.title,
                        if hit.authors.is_empty() {
                            "未知".to_string()
                        } else {
                            hit.authors.join(", ")
                        },
                        hit.year.map(|value| value.to_string()).unwrap_or_else(|| "未知".to_string()),
                        if hit.venue.is_empty() { "未知" } else { hit.venue.as_str() },
                        if hit.doi.is_empty() { "无" } else { hit.doi.as_str() },
                        hit.url
                    ));
                }
                out.push_str("提示：确认后可用 import 把 BibTeX/CSL 文本导入项目。");
                Ok(ToolOutput::text(out))
            }
            "list" => {
                require_project(&project_id)?;
                let db_conn = conn(ctx);
                let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
                let refs = literature::list_refs(&guard, &project_id)?;
                if refs.is_empty() {
                    return Ok(ToolOutput::text(format!("项目 {project_id} 暂无文献")));
                }
                let mut out = format!("项目 {project_id} 文献（{} 条）：\n", refs.len());
                for item in refs.iter().take(50) {
                    out.push_str(&format!(
                        "- [{}] {}（{}）· {} · DOI {}\n",
                        item.cite_key,
                        item.title,
                        item.year.map(|value| value.to_string()).unwrap_or_else(|| "年份未知".to_string()),
                        item.status,
                        if item.doi.is_empty() { "无" } else { item.doi.as_str() }
                    ));
                }
                Ok(ToolOutput::text(out))
            }
            "import" => {
                require_project(&project_id)?;
                let format = value
                    .get("format")
                    .and_then(Value::as_str)
                    .unwrap_or("bibtex");
                let content = value
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let db_conn = conn(ctx);
                let mut guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
                let result = literature::import_text(&mut guard, &project_id, format, content)?;
                let mut out = format!(
                    "已导入 {} 条（跳过重复 {} 条，失败 {} 条）。\n",
                    result.imported, result.skipped, result.failed
                );
                for item in result.refs.iter().take(20) {
                    out.push_str(&format!("- [{}] {}\n", item.cite_key, item.title));
                }
                if !result.errors.is_empty() {
                    out.push_str(&format!("失败原因：{}\n", result.errors.join("；")));
                }
                Ok(ToolOutput::text(out))
            }
            "verify" => {
                require_project(&project_id)?;
                let ref_id = value
                    .get("ref_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .ok_or("verify 需要 ref_id（先用 list 查文献 id）")?;
                let db_conn = conn(ctx);
                let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
                let updated = literature::verify_ref(&guard, &project_id, ref_id)?;
                Ok(ToolOutput::text(format!(
                    "文献 [{}] {} 核验结果：{}（DOI {}）",
                    updated.cite_key,
                    updated.title,
                    updated.status,
                    if updated.doi.is_empty() { "无" } else { updated.doi.as_str() }
                )))
            }
            "download" => {
                require_project(&project_id)?;
                let ref_id = value
                    .get("ref_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .ok_or("download 需要 ref_id（先用 list 查文献 id）")?;
                let data_dir = {
                    let dir = ctx
                        .db
                        .data_dir
                        .lock()
                        .map_err(|_| "数据目录锁失败".to_string())?;
                    dir.clone()
                };
                let db_conn = conn(ctx);
                let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
                let pdf = crate::workspace::literature::download_pdf_conn(
                    &guard,
                    &data_dir,
                    &project_id,
                    ref_id,
                )?;
                Ok(ToolOutput::text(match &pdf.path {
                    Some(path) => format!("{}\n本地 PDF：{path}\n来源：{}", pdf.message, pdf.url),
                    None => format!("{}\n在线地址：{}", pdf.message, pdf.url),
                }))
            }
            "export_bibtex" => {
                require_project(&project_id)?;
                let db_conn = conn(ctx);
                let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
                let bibtex = literature::export_bibtex(&guard, &project_id)?;
                Ok(ToolOutput::text(bibtex))
            }
            other => Err(format!(
                "不支持的 action：{other}（可选 search / list / import / export_bibtex）"
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// academic_project
// ---------------------------------------------------------------------------

pub(crate) struct AcademicProjectTool;

static SPEC_ACADEMIC_PROJECT: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "academic_project",
        "科研项目工具。action：\
         brief=读取项目简报（阶段/证据/文献/数据/稿件摘要，回答或写作前先看）；\
         stage_update=推进/回退阶段（topic/design/advise/experiment/writing/submission；\
         status：locked/submitted/active/approved/frozen）；\
         save_advice=保存阶段建议；\
         plan_get=读取当前阶段 AI 研究计划（还没有时提示先生成）；\
         plan_generate=AI 生成当前阶段研究计划（目标/任务/交付物/验收/风险，生成后持久化）；\
         plan_task_set=勾选/取消计划任务（done=true/false，写入阶段门禁 checks）。\
         需要 project_id（研究项目 id）；plan_* 需要 stage；plan_task_set 需要 task_id + done。\
         AI 生成计划后请逐项执行，并用 plan_task_set 勾选完成；用户也可在控制台手动勾选。",
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {"type": "string", "enum": ["list", "brief", "stage_update", "save_advice", "plan_get", "plan_generate", "plan_task_set"]},
                "project_id": {"type": "string"},
                "stage": {"type": "string", "enum": ["topic", "design", "advise", "experiment", "writing", "submission"]},
                "status": {"type": "string", "enum": ["locked", "submitted", "active", "approved", "frozen"]},
                "gate_json": {"type": "string", "description": "可选：阶段门禁/检查项 JSON"},
                "notes": {"type": "string", "description": "save_advice 的建议正文（会显示在控制台「当前阶段建议」）"},
                "question": {"type": "string", "description": "可选：这条建议对应的问题"},
                "task_id": {"type": "string", "description": "plan_task_set：计划任务 id（如 t1）"},
                "done": {"type": "boolean", "description": "plan_task_set：true=完成，false=取消完成"}
            }
        }),
    )
});

impl LocalTool for AcademicProjectTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_ACADEMIC_PROJECT
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if action == "list" {
            let db_conn = conn(ctx);
            let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
            let projects = research::list_projects(&guard)?;
            if projects.is_empty() {
                return Ok(ToolOutput::text("还没有研究项目".to_string()));
            }
            let mut out = format!("研究项目（{} 个）：\n", projects.len());
            for project in projects.iter().take(50) {
                out.push_str(&format!(
                    "- {}：{}（当前阶段 {}）\n",
                    project.id, project.title, project.current_stage
                ));
            }
            return Ok(ToolOutput::text(out));
        }
        let project_id = value
            .get("project_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or("缺少 project_id（研究项目 id，可用 action=list 查询）")?;
        let db_conn = conn(ctx);
                let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        match action {
            "brief" => {
                let brief = research::project_briefing(&guard, project_id)?;
                let clipped: String = brief.chars().take(12_000).collect();
                Ok(ToolOutput::text(clipped))
            }
            "save_advice" => {
                let notes = value
                    .get("notes")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .ok_or("save_advice 需要 notes（建议正文）")?;
                let question = value
                    .get("question")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("阶段建议");
                let now = crate::automation::now_secs();
                research::save_advice(
                    &guard,
                    &crate::infra::db::local_id(),
                    project_id,
                    question,
                    notes,
                    now,
                )?;
                Ok(ToolOutput::text(format!(
                    "已保存阶段建议到控制台（{} 字）；控制台「当前阶段建议」会显示这条。",
                    notes.chars().count()
                )))
            }
            "stage_update" => {
                let stage = value
                    .get("stage")
                    .and_then(Value::as_str)
                    .ok_or("stage_update 需要 stage")?;
                let status = value
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or("stage_update 需要 status")?;
                let gate_json = value.get("gate_json").and_then(Value::as_str);
                research::update_stage(
                    &guard,
                    project_id,
                    stage,
                    status,
                    gate_json,
                    "agent",
                    crate::automation::now_secs(),
                )?;
                Ok(ToolOutput::text(format!(
                    "项目 {project_id} 阶段 {stage} 已更新为 {status}；用 action=brief 查看最新简报。"
                )))
            }
            "plan_get" => {
                let stage = value
                    .get("stage")
                    .and_then(Value::as_str)
                    .ok_or("plan_get 需要 stage")?;
                match research::plan_get(&guard, project_id, stage)? {
                    Some(plan) => Ok(ToolOutput::text(format_plan_text(&plan))),
                    None => Ok(ToolOutput::text(format!(
                        "项目 {project_id} 的 {stage} 阶段还没有 AI 研究计划；用 action=plan_generate 生成一份。"
                    ))),
                }
            }
            "plan_generate" => {
                let stage = value
                    .get("stage")
                    .and_then(Value::as_str)
                    .ok_or("plan_generate 需要 stage")?;
                // 生成要调用 LLM，先释放 DB 锁（ai 层会自己短锁读上下文/写持久化）。
                drop(guard);
                let plan = research::generate_ai_plan(
                    &db_conn,
                    project_id,
                    stage,
                    crate::automation::now_secs(),
                )?;
                Ok(ToolOutput::text(format!(
                    "已生成并保存 {stage} 阶段研究计划。\n{}",
                    format_plan_text(&plan)
                )))
            }
            "plan_task_set" => {
                let stage = value
                    .get("stage")
                    .and_then(Value::as_str)
                    .ok_or("plan_task_set 需要 stage")?;
                let task_id = value
                    .get("task_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .ok_or("plan_task_set 需要 task_id（如 t1）")?;
                let done = value
                    .get("done")
                    .and_then(Value::as_bool)
                    .ok_or("plan_task_set 需要 done（true/false）")?;
                research::plan_task_set(
                    &guard,
                    project_id,
                    stage,
                    task_id,
                    done,
                    "agent",
                    crate::automation::now_secs(),
                )?;
                Ok(ToolOutput::text(format!(
                    "计划任务 {task_id}（{stage}）已标记为{}；用户可在控制台看到勾选状态。",
                    if done { "完成" } else { "未完成" }
                )))
            }
            other => Err(format!(
                "不支持的 action：{other}（可选 list / brief / stage_update / save_advice / plan_get / plan_generate / plan_task_set）"
            )),
        }
    }
}

/// 把研究计划格式化成模型可读的文本（任务带可勾选 id）。
fn format_plan_text(plan: &crate::workspace::research::ResearchPlan) -> String {
    let mut out = format!("【{} 阶段研究计划】\n目标：{}\n任务：\n", plan.stage, plan.goal);
    for task in &plan.tasks {
        out.push_str(&format!("- [{}] {}\n", task.id, task.label));
    }
    let section = |title: &str, items: &[String]| -> String {
        if items.is_empty() {
            String::new()
        } else {
            format!("{title}：{}\n", items.join("；"))
        }
    };
    out.push_str(&section("交付物", &plan.deliverables));
    out.push_str(&section("验收标准", &plan.acceptance));
    out.push_str(&section("风险", &plan.risks));
    out.push_str(&section("自检提示", &plan.prompts));
    out.push_str("\n逐项执行后，用 action=plan_task_set（stage + task_id + done）勾选完成；用户也可在控制台手动勾选。");
    out
}

// ---------------------------------------------------------------------------
// academic_manuscript
// ---------------------------------------------------------------------------

pub(crate) struct AcademicManuscriptTool;

static SPEC_ACADEMIC_MANUSCRIPT: std::sync::LazyLock<ToolSpec> =
    std::sync::LazyLock::new(|| {
        spec(
            "academic_manuscript",
            "写作文档/章节工具。文档类型 kind：proposal=开题报告 / plan=研究计划 / draft=初稿 / revision=修改稿 / cover_letter=投稿信 / custom=自定义；每份文档有独立章节与导出。action：create_document=新建文档（kind+title+可选 sections，返回 document_id，并记 manuscript.document_created 事件）；documents=列出项目写作文档（document_id / 类型 / 标题 / 章节数 / 字数）；list=列出文档章节（字数/状态）；read=读某章节正文；export_docx=导出该文档 Word（.docx）；export_latex=导出该文档 LaTeX（.tex + 可选 .bib）；\\
             write=写入/覆盖某章节（落盘到 manuscript/documents/<document_id>/<章节>.md）。\\
             需要 project_id；可选 document_id（缺省=最近更新的文档；若还没有任何文档则自动创建「初稿」）。read/write 需要 section（如「3 方法」「摘要」）。\\
             写作产出以 Word(.docx) / LaTeX(.tex) 为主；write 的 content 用 Markdown + LaTeX 数学（$...$）；导出按文档章节自动转换并登记产物。写作前先用 academic_project(action=brief) 看证据，引用文献用 academic_literature。",
            json!({
                "type": "object",
                "required": ["action", "project_id"],
                "properties": {
                    "action": {"type": "string", "enum": ["create_document", "documents", "list", "read", "write", "export_docx", "export_latex"]},
                    "project_id": {"type": "string"},
                    "document_id": {"type": "string", "description": "写作文档 id（缺省=最近更新的文档；可用 action=documents 查看）"},
                    "kind": {"type": "string", "enum": ["proposal", "plan", "draft", "revision", "cover_letter", "custom"], "description": "create_document 的文档类型：研究计划用 plan，论文用 draft/revision，开题报告用 proposal，投稿信用 cover_letter"},
                    "title": {"type": "string", "description": "create_document 的文档标题（如「研究计划」「初稿」）"},
                    "sections": {"type": "array", "items": {"type": "string"}, "description": "create_document 的默认章节名数组（可选，按顺序建空章节）"},
                    "section": {"type": "string", "description": "章节名，例如 摘要 / 1 引言 / 3 方法"},
                    "content": {"type": "string", "description": "write 的正文（Markdown + LaTeX 数学 $...$）"}
                }
            }),
        )
    });

impl LocalTool for AcademicManuscriptTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_ACADEMIC_MANUSCRIPT
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let project_id = value
            .get("project_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or("缺少 project_id")?;
        let section = value
            .get("section")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let document_id = value
            .get("document_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let db_conn = conn(ctx);
        let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        match action {
            "create_document" => {
                let kind = value
                    .get("kind")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|kind| !kind.is_empty())
                    .unwrap_or("draft");
                let title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let sections: Vec<String> = value
                    .get("sections")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|section| !section.is_empty())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let data_dir = ctx
                    .db
                    .data_dir
                    .lock()
                    .map_err(|err| format!("获取数据目录锁失败：{err}"))?
                    .clone();
                let created = crate::workspace::manuscript::create_document(
                    &guard,
                    std::path::Path::new(&data_dir),
                    project_id,
                    kind,
                    title,
                    &sections,
                )?;
                let _ = crate::repositories::research::events::append(
                    &guard,
                    project_id,
                    "agent",
                    "manuscript.document_created",
                    &json!({
                        "documentId": created.id,
                        "kind": created.kind,
                        "title": created.title,
                    })
                    .to_string(),
                    crate::automation::now_secs(),
                );
                Ok(ToolOutput::text(format!(
                    "已创建写作文档「{}」（{}，{} 章）· document_id={}\n用 action=write + document_id 写章节；导出用 export_docx / export_latex。",
                    created.title, created.kind, created.section_count, created.id
                )))
            }
            "documents" => {
                let documents = crate::workspace::manuscript::document_list(&guard, project_id)?;
                if documents.is_empty() {
                    return Ok(ToolOutput::text(format!(
                        "项目 {project_id} 还没有写作文档（首次 write 会自动创建「初稿」）"
                    )));
                }
                let mut out = format!("写作文档（{}）：\n", documents.len());
                for document in documents {
                    out.push_str(&format!(
                        "- {}（{}，{} 章，{} 字）· document_id={}\n",
                        document.title,
                        document.kind,
                        document.section_count,
                        document.words,
                        document.id
                    ));
                }
                Ok(ToolOutput::text(out))
            }
            "list" | "read" | "write" | "export_docx" | "export_latex" => {
                let document =
                    crate::workspace::manuscript::resolve_document(&guard, project_id, document_id)?;
                match action {
                    "list" => {
                        let sections = crate::workspace::manuscript::sections(
                            &guard,
                            project_id,
                            &document.id,
                        )?;
                        if sections.is_empty() {
                            return Ok(ToolOutput::text(format!(
                                "文档「{}」（{}）还没有章节",
                                document.title, document.kind
                            )));
                        }
                        let mut out = format!(
                            "文档「{}」（{}）章节（{}）：\n",
                            document.title,
                            document.kind,
                            sections.len()
                        );
                        for item in sections {
                            out.push_str(&format!(
                                "- {}（{} 字，{}）\n",
                                item.section, item.words, item.status
                            ));
                        }
                        Ok(ToolOutput::text(out))
                    }
                    "read" => {
                        let section = section.ok_or("read 需要 section")?;
                        let sections = crate::workspace::manuscript::sections(
                            &guard,
                            project_id,
                            &document.id,
                        )?;
                        let found = sections
                            .into_iter()
                            .find(|item| item.section == section)
                            .ok_or_else(|| format!("章节不存在：{section}（先用 action=list 查看）"))?;
                        Ok(ToolOutput::text(format!(
                            "## {}（{} 字）\n\n{}",
                            found.section, found.words, found.content
                        )))
                    }
                    "write" => {
                        let section = section.ok_or("write 需要 section")?;
                        let content = value
                            .get("content")
                            .and_then(Value::as_str)
                            .ok_or("write 需要 content")?;
                        let data_dir = {
                            let dir = ctx
                                .db
                                .data_dir
                                .lock()
                                .map_err(|_| "数据目录锁失败".to_string())?;
                            dir.clone()
                        };
                        let saved = crate::workspace::manuscript::save_section(
                            &guard,
                            &data_dir,
                            project_id,
                            &document.id,
                            section,
                            content,
                        )?;
                        Ok(ToolOutput::text(format!(
                            "已写入章节「{}」（{} 字）→ {}（文档「{}」）",
                            saved.section, saved.words, saved.path, document.title
                        )))
                    }
                    "export_docx" => {
                        let data_dir = {
                            let dir = ctx
                                .db
                                .data_dir
                                .lock()
                                .map_err(|_| "数据目录锁失败".to_string())?;
                            dir.clone()
                        };
                        let (payload, sections_count, words) =
                            crate::workspace::manuscript::build_docx_payload(
                                &guard,
                                project_id,
                                &document.id,
                            )?;
                        // 渲染要起 Python 子进程：先放掉 DB 锁，避免阻塞其它命令。
                        drop(guard);
                        let out_path = crate::workspace::manuscript::docx_export_path(
                            std::path::Path::new(&data_dir),
                            crate::workspace::manuscript::payload_title(&payload),
                        )?;
                        crate::workspace::manuscript::render_docx(
                            std::path::Path::new(&data_dir),
                            &payload,
                            &out_path,
                        )?;
                        {
                            let guard =
                                db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
                            crate::workspace::manuscript::register_export_artifact(
                                &guard,
                                project_id,
                                &out_path,
                            );
                        }
                        Ok(ToolOutput::text(format!(
                            "已导出文档「{}」Word（{} 章，{} 字）：{}",
                            document.title,
                            sections_count,
                            words,
                            out_path.display()
                        )))
                    }
                    "export_latex" => {
                        let data_dir = {
                            let dir = ctx
                                .db
                                .data_dir
                                .lock()
                                .map_err(|_| "数据目录锁失败".to_string())?;
                            dir.clone()
                        };
                        let exported = crate::workspace::manuscript_latex::export_latex(
                            &guard,
                            std::path::Path::new(&data_dir),
                            project_id,
                            &document.id,
                        )?;
                        let mut out = format!(
                            "已导出文档「{}」LaTeX（{} 章，{} 字）：{}",
                            document.title, exported.sections, exported.words, exported.path
                        );
                        if !exported.bib_path.is_empty() {
                            out.push_str(&format!("\n参考文献：{}", exported.bib_path));
                        }
                        Ok(ToolOutput::text(out))
                    }
                    _ => unreachable!(),
                }
            }
            other => Err(format!(
                "不支持的 action：{other}（可选 create_document / documents / list / read / write / export_docx / export_latex）"
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// academic_evidence（数据集 / 实验记录）
// ---------------------------------------------------------------------------

pub(crate) struct AcademicEvidenceTool;

static SPEC_ACADEMIC_EVIDENCE: std::sync::LazyLock<ToolSpec> =
    std::sync::LazyLock::new(|| {
        spec(
            "academic_evidence",
            "科研证据工具。action：dataset_list=列项目数据集（行/列/路径）；\\
             dataset_import=归档本地数据文件并计算画像（行/列/列名）；analysis_run=在项目根目录跑 Python 分析脚本（120s 超时，输出落 analysis/outputs）；\\
             experiment_list=列实验运行（配置/指标/结论）；experiment_add=登记一次实验运行\\
             （名称 + 配置/指标 JSON + 状态 + 结论）。需要 project_id。\\
             数据只能来自已登记的数据集与实验：没有记录就写「待补」，不要编造数字。",
            json!({
                "type": "object",
                "required": ["action", "project_id"],
                "properties": {
                    "action": {"type": "string", "enum": ["dataset_list", "dataset_import", "analysis_run", "experiment_list", "experiment_add"]},
                    "project_id": {"type": "string"},
                    "path": {"type": "string", "description": "dataset_import 的本地文件路径（csv/xlsx/xls）"},
                    "script": {"type": "string", "description": "analysis_run 的 Python 脚本（在项目根目录执行，cwd=项目根）"},
                    "name": {"type": "string", "description": "experiment_add 的实验名 / analysis_run 的脚本名（默认 analysis）"},
                    "dataset_ids": {"type": "string", "description": "可选：关联数据集 id，逗号分隔"},
                    "config_json": {"type": "string", "description": "可选：配置 JSON（超参/模型）"},
                    "metrics_json": {"type": "string", "description": "可选：指标 JSON（loss/accuracy 等）"},
                    "status": {"type": "string", "description": "可选：planned/running/done/failed（默认 done）"},
                    "conclusion": {"type": "string", "description": "可选：结论"}
                }
            }),
        )
    });

impl LocalTool for AcademicEvidenceTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_ACADEMIC_EVIDENCE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let project_id = value
            .get("project_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or("缺少 project_id")?;
        let db_conn = conn(ctx);
        let guard = db_conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        match action {
            "dataset_list" => {
                let datasets = crate::workspace::dataset::list_datasets(&guard, project_id)?;
                if datasets.is_empty() {
                    return Ok(ToolOutput::text(format!("项目 {project_id} 还没有数据集")));
                }
                let mut out = format!("数据集（{}）：\n", datasets.len());
                for item in datasets {
                    out.push_str(&format!(
                        "- {}：{} 行 × {} 列 · {}\n",
                        item.name,
                        item.rows.map(|v| v.to_string()).unwrap_or_else(|| "?".to_string()),
                        item.cols.map(|v| v.to_string()).unwrap_or_else(|| "?".to_string()),
                        item.path
                    ));
                }
                Ok(ToolOutput::text(out))
            }
            "dataset_import" => {
                let path = value
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or("dataset_import 需要 path")?;
                let data_dir = {
                    let dir = ctx
                        .db
                        .data_dir
                        .lock()
                        .map_err(|_| "数据目录锁失败".to_string())?;
                    dir.clone()
                };
                let row = crate::workspace::dataset::import_dataset(
                    &guard,
                    &data_dir,
                    project_id,
                    std::path::Path::new(path),
                )?;
                Ok(ToolOutput::text(format!(
                    "已导入数据集「{}」：{} 行 × {} 列 · id {} · {}",
                    row.name,
                    row.rows.map(|v| v.to_string()).unwrap_or_else(|| "?".to_string()),
                    row.cols.map(|v| v.to_string()).unwrap_or_else(|| "?".to_string()),
                    row.id,
                    row.path
                )))
            }
            "analysis_run" => {
                let script = value
                    .get("script")
                    .and_then(Value::as_str)
                    .ok_or("analysis_run 需要 script")?;
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("analysis");
                let data_dir = {
                    let dir = ctx
                        .db
                        .data_dir
                        .lock()
                        .map_err(|_| "数据目录锁失败".to_string())?;
                    dir.clone()
                };
                let result = crate::workspace::dataset::run_analysis(
                    &guard,
                    &data_dir,
                    project_id,
                    name,
                    script,
                )?;
                let stdout: String = result.stdout.chars().take(4000).collect();
                let stderr: String = result.stderr.chars().take(1000).collect();
                Ok(ToolOutput::text(format!(
                    "分析完成（{}）：exit {} · 脚本 {}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                    name, result.exit_code, result.script_path, stdout, stderr
                )))
            }
            "experiment_list" => {
                let runs = crate::workspace::experiment::list(&guard, project_id)?;
                if runs.is_empty() {
                    return Ok(ToolOutput::text(format!("项目 {project_id} 还没有实验记录")));
                }
                let mut out = format!("实验记录（{}）：\n", runs.len());
                for run in runs.iter().take(30) {
                    out.push_str(&format!(
                        "- {}：{} · 指标 {}\n",
                        run.name,
                        run.status,
                        if run.metrics_json.is_empty() { "{}" } else { run.metrics_json.as_str() }
                    ));
                    if !run.conclusion.is_empty() {
                        out.push_str(&format!("  结论：{}\n", run.conclusion));
                    }
                }
                Ok(ToolOutput::text(out))
            }
            "experiment_add" => {
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .ok_or("experiment_add 需要 name")?;
                let dataset_ids = value.get("dataset_ids").and_then(Value::as_str).unwrap_or("");
                let config_json = value.get("config_json").and_then(Value::as_str).unwrap_or("{}");
                let metrics_json = value
                    .get("metrics_json")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let status = value.get("status").and_then(Value::as_str).unwrap_or("done");
                let conclusion = value
                    .get("conclusion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let run = crate::workspace::experiment::add(
                    &guard,
                    project_id,
                    name,
                    dataset_ids,
                    config_json,
                    "",
                    metrics_json,
                    status,
                    conclusion,
                    crate::automation::now_secs(),
                )?;
                Ok(ToolOutput::text(format!(
                    "已登记实验「{}」（id {}，状态 {}）；用 experiment_list 查看。",
                    run.name, run.id, run.status
                )))
            }
            other => Err(format!(
                "不支持的 action：{other}（可选 dataset_list / experiment_list / experiment_add）"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn test_ctx(tag: &str) -> (ToolContext, std::path::PathBuf, String) {
        let conn = rusqlite::Connection::open_in_memory().expect("内存数据库");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL)
            .expect("建表");
        let data_dir = std::env::temp_dir().join(format!(
            "mb-academic-tools-{tag}-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&data_dir).expect("数据目录");
        let project_id = format!("project-tools-{tag}");
        let project = crate::workspace::research::ResearchProject {
            id: project_id.clone(),
            title: "工具测试项目".to_string(),
            paper_kind: "journal".to_string(),
            field: String::new(),
            language: "zh".to_string(),
            target_venue: String::new(),
            current_stage: "writing".to_string(),
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
            agent: crate::agent::agents::AgentKind::Academic,
            delegate: None,
        };
        (ctx, data_dir, project_id)
    }

    #[test]
    fn create_document_creates_plan_and_records_event() {
        let (ctx, data_dir, project_id) = test_ctx("create-document");
        let out = AcademicManuscriptTool
            .execute(
                &ctx,
                &json!({
                    "action": "create_document",
                    "project_id": project_id,
                    "kind": "plan",
                    "title": "研究计划",
                    "sections": ["研究背景", "研究目标"],
                })
                .to_string(),
            )
            .expect("create_document");
        assert!(out.content.contains("研究计划"), "unexpected: {}", out.content);
        assert!(
            out.content.contains("document_id="),
            "document id missing: {}",
            out.content
        );

        let guard = ctx.db.conn.lock().expect("db lock");
        let (kind, payload): (String, String) = guard
            .query_row(
                "SELECT type, payload_json FROM project_events \
                 WHERE project_id = ?1 ORDER BY id DESC LIMIT 1",
                rusqlite::params![project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("event row");
        drop(guard);
        assert_eq!(kind, "manuscript.document_created");
        let payload: Value = serde_json::from_str(&payload).expect("payload json");
        assert_eq!(payload["kind"], "plan");
        assert_eq!(payload["title"], "研究计划");
        assert!(
            payload["documentId"]
                .as_str()
                .map(|id| !id.is_empty())
                .unwrap_or(false),
            "documentId missing: {payload}"
        );

        // 新文档能在 documents action 里看到（章节数 = 2）。
        let listed = AcademicManuscriptTool
            .execute(
                &ctx,
                &json!({"action": "documents", "project_id": project_id}).to_string(),
            )
            .expect("documents");
        assert!(listed.content.contains("研究计划"), "unexpected: {}", listed.content);
        assert!(listed.content.contains("2 章"), "unexpected: {}", listed.content);
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}


//! Conversation-integrated artifact tools: resume and slide-deck generation.

use serde_json::{json, Value};

use super::common::{lock_err, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conversation-integrated artifact tools (resume / slides)
// ---------------------------------------------------------------------------

/// Generate a resume from the FULL chat history and write it under
/// <data_dir>/exports/. Long-running (multi-pass LLM map-reduce) but blocking
/// is fine: the runtime executes tools on scoped threads with no timeout.
pub(crate) struct GenerateResumeTool;

impl LocalTool for GenerateResumeTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_GENERATE_RESUME
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let target_role = value
            .get("target_role")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty());
        // 用户给了保存位置（如「存到桌面」）时写到那里，否则落 exports。
        let save_path = value
            .get("save_path")
            .and_then(|p| p.as_str())
            .map(str::trim)
            .filter(|p| !p.is_empty());
        let client = ctx
            .chat_client
            .as_deref()
            .ok_or("简历生成不可用：当前未配置对话模型，请先在「API 设置」中填写 API Key")?;
        // Lock discipline: history read + data_dir resolve under one short
        // lock, then the LLM work runs lock-free.
        let path = {
            let conn = ctx.db.conn.lock().map_err(lock_err)?;
            let data_dir = ctx
                .db
                .data_dir
                .lock()
                .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
            crate::workspace::resume::generate_resume_to_file(
                &conn,
                client,
                &data_dir,
                target_role,
                save_path,
            )?
        };
        Ok(ToolOutput::text(format!(
            "简历已生成并保存到：{}。请告知用户文件路径，并简要说明简历结构（技能/项目/经历板块）；             提示用户可继续对话补充信息后重新生成（聊得越多越详细）。",
            path.display()
        )))
    }
}

static SPEC_GENERATE_RESUME: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "generate_resume",
        "把用户与助手聊过的全部历史对话提炼成一份 Markdown 简历，保存为文件并返回路径。         使用规则：① 求职方向不明时，先用【需要澄清】格式问清方向再调用；         ② 历史对话里用户聊过的项目/经历明显不足时，先提示用户多聊几句项目细节、         技术栈与量化成果（聊得越多简历越详细），再生成；         ③ 生成完成后必须告知文件保存路径、概述简历结构（技能/项目/经历板块），         并提醒：继续对话补充信息后可再次生成，内容会更充实。",
        json!({
            "type": "object",
            "properties": {
                "target_role": { "type": "string", "description": "求职方向（可选），如「前端工程师」，影响内容取舍" }
            }
        }),
    )
});

/// Generate a slide deck (.pptx) for one topic and write it under
/// <data_dir>/exports/. Outline via LLM, rendering via the python-pptx
/// sidecar (first run provisions dependencies, later runs are fast).
pub(crate) struct GenerateSlidesTool;

impl LocalTool for GenerateSlidesTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_GENERATE_SLIDES
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let topic = value
            .get("topic")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or("topic 不能为空")?
            .to_string();
        let slide_count = value
            .get("slide_count")
            .and_then(|n| n.as_u64())
            .map(|n| (n as usize).clamp(crate::workspace::slides::MIN_SLIDES, crate::workspace::slides::MAX_SLIDES))
            .unwrap_or(crate::workspace::slides::DEFAULT_SLIDES);
        let audience = value
            .get("audience")
            .and_then(|a| a.as_str())
            .map(str::trim)
            .filter(|a| !a.is_empty());
        let style = value
            .get("style")
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let client = ctx
            .chat_client
            .as_deref()
            .ok_or("PPT 生成不可用：当前未配置对话模型，请先在「API 设置」中填写 API Key")?;
        // Ground the outline in knowledge-base material by default — the
        // single biggest lever on deck quality (opt out via use_knowledge=false).
        let mut context_block = String::new();
        if value.get("use_knowledge").and_then(|u| u.as_bool()) != Some(false) {
            if let Some(embed_client) = ctx.embed_client.as_deref() {
                if let Ok(query_vector) = embed_client.embed_query(&topic) {
                    let conn = ctx.db.conn.lock().map_err(lock_err)?;
                    if let Ok(raw) =
                        crate::knowledge::vectors::hybrid_search_conn(&conn, &query_vector, &topic, 6, None)
                    {
                        if let Ok(joined_hits) = crate::knowledge::ingest::join_metadata(&conn, raw) {
                            let joined = crate::agent::chat::format_context_blocks(&joined_hits);
                            if !joined.is_empty() {
                                context_block = format!(
                                    "参考知识片段：
{joined}

"
                                );
                            }
                        }
                    }
                }
            }
        }

        let data_dir = ctx
            .db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        // 先出大纲（含可选知识库素材作为背景），再渲染成 pptx 文件。
        let outline = crate::workspace::slides::generate_outline_core(
            client,
            &topic,
            slide_count,
            audience,
            style,
            &context_block,
        )?;
        // 用户给了保存位置时写到那里，否则落 exports（有生成记录可查）。
        let save_dir = value
            .get("save_path")
            .and_then(|p| p.as_str())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from);
        let dir = save_dir.unwrap_or_else(|| crate::workspace::resume::exports_dir(&data_dir));
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("创建目录失败（{}）：{err}", dir.display()))?;
        let path = dir.join(crate::workspace::resume::export_file_name(
            &format!("PPT-{}", outline.title),
            "pptx",
        ));
        crate::workspace::slides::render_pptx_to_path(&data_dir, &outline, path.to_str().unwrap_or_default())?;

        let mut summary = String::new();
        for (index, slide) in outline.slides.iter().enumerate() {
            summary.push_str(&format!(
                "{}. {}
",
                index + 1,
                slide.title
            ));
        }
        Ok(ToolOutput::text(format!(
            "PPT 已生成并保存到：{}。
大纲：
{}请告知用户文件路径与页数，并给出每页标题的概览。",
            path.display(),
            summary
        )))
    }
}

static SPEC_GENERATE_SLIDES: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "generate_slides",
        "按主题生成一套完整演示文稿（.pptx 文件）：封面 + 每页 3-6 条具体要点 + 讲者备注，         默认先检索知识库取材，可直接用 PowerPoint/WPS 打开。         使用规则：① 主题范围过大、受众（面试官/客户/新人）、页数、侧重不明时，         先用【需要澄清】格式问 1-3 个关键问题再调用；         ② 生成完成后必须告知文件保存路径，并逐页给出大纲概览；         ③ 内容单薄时主动建议：结合知识库资料（use_knowledge 默认已开启）或补充背景后重新生成。",
        json!({
            "type": "object",
            "required": ["topic"],
            "properties": {
                "topic": { "type": "string", "description": "演示主题" },
                "slide_count": { "type": "integer", "description": "正文页数（3-15，默认 8）" },
                "audience": { "type": "string", "description": "目标受众（可选），如「技术面试官」" },
                "style": { "type": "string", "description": "内容风格（可选），如「深入浅出」" },
                "use_knowledge": { "type": "boolean", "description": "是否检索知识库素材作为大纲背景（默认 true；用户明确不需要时传 false）" },
                "save_path": { "type": "string", "description": "保存位置（可选，绝对路径；用户说「存到桌面/D盘某目录」时传入），缺省存 exports" }
            }
        }),
    )
});

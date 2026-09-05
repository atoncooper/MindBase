//! PPT 制作 agent：主题 → LLM 生成结构化大纲（标题 + 每页要点 + 讲者备注）
//! → python-pptx sidecar 渲染为 .pptx 文件。
//!
//! 大纲是一次严格 JSON 的 LLM 调用（解析容错与降级链路同 quiz）；渲染交给
//! `scripts/pptx_build.py`，走项目统一的「stdin 喂 JSON、stdout 最后一行
//! JSON 判定」sidecar 协议。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::llm_chat::ChatMessage;

/// Panel-facing caps: the outline stays in a presentable size.
const MIN_SLIDES: usize = 3;
const MAX_SLIDES: usize = 15;
const DEFAULT_SLIDES: usize = 8;
const MAX_BULLETS: usize = 6;
const BULLET_CHARS: usize = 80;
const OUTLINE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// One slide of the generated outline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideDraft {
    pub title: String,
    pub bullets: Vec<String>,
    #[serde(default)]
    pub note: String,
}

/// A full deck outline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidesOutline {
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    pub slides: Vec<SlideDraft>,
}

/// Panel-facing outline parameters.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidesOutlineRequest {
    pub topic: String,
    #[serde(default)]
    pub slide_count: Option<usize>,
    /// Optional audience hint (e.g. 面试官 / 新人培训 / 客户汇报).
    #[serde(default)]
    pub audience: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
}

/// Progress pushed while the outline generates.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SlidesEvent {
    Outlining,
}

/// Parse the strict-JSON outline reply, tolerating code fences (same
/// discipline as quiz's question parser).
fn parse_outline(reply: &str) -> Result<SlidesOutline, String> {
    let trimmed = reply.trim();
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim_start_matches('\n')
        .trim_end_matches("```")
        .trim();
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析大纲 JSON 失败：{err}"))?;
    let title = value
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("大纲缺少 title".to_string());
    }
    let raw_slides = value
        .get("slides")
        .and_then(|s| s.as_array())
        .ok_or("大纲缺少 slides 数组")?;
    let mut slides = Vec::new();
    for raw in raw_slides {
        let slide_title = raw
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if slide_title.is_empty() {
            continue;
        }
        let bullets: Vec<String> = raw
            .get("bullets")
            .and_then(|b| b.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(|text| text.chars().take(BULLET_CHARS).collect())
                    .take(MAX_BULLETS)
                    .collect()
            })
            .unwrap_or_default();
        if bullets.is_empty() {
            continue;
        }
        slides.push(SlideDraft {
            title: slide_title.chars().take(60).collect(),
            bullets,
            note: raw
                .get("note")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect(),
        });
    }
    if slides.is_empty() {
        return Err("大纲没有任何可用页面".to_string());
    }
    Ok(SlidesOutline {
        title: title.chars().take(60).collect(),
        subtitle: value
            .get("subtitle")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .chars()
            .take(80)
            .collect(),
        slides,
    })
}

/// Normalize a model reply into a validated outline (clamp page count and
/// bullets; the model occasionally overshoots the requested count).
fn normalize_outline(mut outline: SlidesOutline, max_slides: usize) -> SlidesOutline {
    outline.slides.truncate(max_slides.max(MIN_SLIDES));
    outline
}

/// Generate a deck outline for one topic; returns the structured outline.
#[tauri::command]
pub async fn slides_outline(
    app: AppHandle,
    request: SlidesOutlineRequest,
    on_event: Channel<SlidesEvent>,
) -> Result<SlidesOutline, String> {
    let topic = request.topic.trim().to_string();
    if topic.is_empty() {
        return Err("请输入演示主题".to_string());
    }
    let slide_count = request
        .slide_count
        .unwrap_or(DEFAULT_SLIDES)
        .clamp(MIN_SLIDES, MAX_SLIDES);
    let client = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        crate::llm_chat::chat_client_from_conn(&conn)?.ok_or_else(|| {
            "未配置对话模型，请先在「API 设置」中填写 DashScope 或 OpenRouter Key".to_string()
        })?
    };

    let audience_line = request
        .audience
        .as_deref()
        .map(|a| format!("目标受众：{a}。"))
        .unwrap_or_default();
    let style_line = request
        .style
        .as_deref()
        .map(|s| format!("内容风格：{s}。"))
        .unwrap_or_default();
    let system = "你是专业的演示文稿策划师。只输出一个 JSON 对象，不解释、不加代码围栏，形如：\n\
                  {\"title\":\"…\",\"subtitle\":\"…\",\"slides\":[{\"title\":\"…\",\
                  \"bullets\":[\"…\"],\"note\":\"讲者备注\"}]}\n\
                  规则：结构完整（开场/主体/收尾），每页 2-6 条要点，每条 ≤60 字，\
                  要点是陈述而非问句；note 是给演讲者的一两句话提示。";
    let user = format!(
        "主题：{topic}\n页数：{slide_count} 页（正文页，不含封面）。\n{audience_line}{style_line}请生成大纲。"
    );

    let _ = on_event.send(SlidesEvent::Outlining);
    tauri::async_runtime::spawn_blocking(move || {
        let messages = [
            ChatMessage::new("system", system),
            ChatMessage::new("user", user),
        ];
        let mut last_error = String::new();
        for _ in 0..2 {
            match client
                .complete_turn(OUTLINE_TIMEOUT, &messages)
                .and_then(|reply| parse_outline(&reply))
            {
                Ok(outline) => {
                    return Ok(normalize_outline(outline, slide_count + 2));
                }
                Err(err) => last_error = err,
            }
        }
        Err(format!("大纲生成失败：{last_error}"))
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

/// Payload for [`slides_export`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidesExportRequest {
    pub outline: SlidesOutline,
    pub path: String,
}

/// Render an outline to a .pptx file via the python-pptx sidecar.
#[tauri::command]
pub async fn slides_export(app: AppHandle, request: SlidesExportRequest) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command as StdCommand, Stdio};

    let mut path = request.path.trim().to_string();
    if path.is_empty() {
        return Err("保存路径为空".to_string());
    }
    if !path.to_lowercase().ends_with(".pptx") {
        path.push_str(".pptx");
    }
    if request.outline.slides.is_empty() {
        return Err("大纲没有页面，无法导出".to_string());
    }

    let data_dir = {
        let db = app.state::<Db>();
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        dir.clone()
    };
    // Provisioning may download the embedded runtime / python-pptx (minutes on
    // first run) — run it off the async runtime.
    let exe = tauri::async_runtime::spawn_blocking(move || {
        crate::python_runtime::ensure_pptx_python(&data_dir)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;

    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("pptx_build.py");
    let script = if script.is_file() {
        script
    } else {
        std::path::Path::new("scripts").join("pptx_build.py")
    };
    if !script.is_file() {
        return Err(format!("渲染脚本缺失：{}", script.display()));
    }

    let payload = serde_json::json!({
        "path": path,
        "title": request.outline.title,
        "subtitle": request.outline.subtitle,
        "slides": request.outline.slides,
    });

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = StdCommand::new(&exe);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = StdCommand::new(&exe);
    let mut child = cmd
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("无法运行渲染器（{}）：{err}", exe.display()))?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or("渲染器 stdin 不可用")?;
        stdin
            .write_all(
                serde_json::to_string(&payload)
                    .map_err(|err| format!("序列化大纲失败：{err}"))?
                    .as_bytes(),
            )
            .map_err(|err| format!("写入渲染器输入失败：{err}"))?;
    } // stdin dropped → EOF, the script proceeds.
    let output = child
        .wait_with_output()
        .map_err(|err| format!("渲染器执行失败：{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Last non-empty line is the verdict (libs may print warnings above it).
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|text| !text.is_empty())
        .unwrap_or("");
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|err| format!("渲染器输出无法读取：{err}（片段：{}）", {
            let snippet: String = line.chars().take(120).collect();
            snippet
        }))?;
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        let error = value
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("未知原因");
        return Err(format!("PPT 渲染失败：{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outline_parser_tolerates_fences_and_drops_empty_slides() {
        let fenced = "```json\n{\"title\":\"主题\",\"subtitle\":\"副标题\",\"slides\":[\
            {\"title\":\"第一页\",\"bullets\":[\"要点一\",\"要点二\"],\"note\":\"n\"},\
            {\"title\":\"\",\"bullets\":[\"空标题丢弃\"]},\
            {\"title\":\"第三页\",\"bullets\":[],\"note\":\"空要点丢弃\"}]}\n```";
        let outline = parse_outline(fenced).expect("parse");
        assert_eq!(outline.title, "主题");
        assert_eq!(outline.slides.len(), 1);
        assert_eq!(outline.slides[0].bullets.len(), 2);
        assert!(parse_outline("no json").is_err());
    }

    #[test]
    fn outline_bullets_are_clamped() {
        let long = "x".repeat(200);
        let reply = format!(
            "{{\"title\":\"t\",\"slides\":[{{\"title\":\"s\",\"bullets\":[\"{long}\",\"{long}\",\"{long}\",\"{long}\",\"{long}\",\"{long}\",\"{long}\"]}}]}}"
        );
        let outline = parse_outline(&reply).expect("parse");
        assert_eq!(outline.slides[0].bullets.len(), MAX_BULLETS);
        assert!(outline.slides[0].bullets[0].chars().count() <= BULLET_CHARS);
    }
}

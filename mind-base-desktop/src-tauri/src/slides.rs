//! PPT 制作 agent：主题 → LLM 生成结构化大纲（标题 + 每页要点 + 讲者备注）
//! → python-pptx sidecar 渲染为 .pptx 文件。
//!
//! 大纲是一次严格 JSON 的 LLM 调用（解析容错与降级链路同 quiz）；渲染交给
//! `scripts/pptx_build.py`，走项目统一的「stdin 喂 JSON、stdout 最后一行
//! JSON 判定」sidecar 协议。

use serde::{Deserialize, Serialize};

use crate::llm_chat::{ChatClient, ChatMessage};

/// Panel-facing caps: the outline stays in a presentable size.
pub(crate) const MIN_SLIDES: usize = 3;
pub(crate) const MAX_SLIDES: usize = 15;
pub(crate) const DEFAULT_SLIDES: usize = 8;
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

/// Core outline generation — shared by the standalone command and the
/// harness tool. Blocking; retries parse failures once.
pub(crate) fn generate_outline_core(
    client: &ChatClient,
    topic: &str,
    slide_count: usize,
    audience: Option<&str>,
    style: Option<&str>,
    context_block: &str,
) -> Result<SlidesOutline, String> {
    let audience_line = audience
        .map(|a| format!("目标受众：{a}。"))
        .unwrap_or_default();
    let style_line = style.map(|s| format!("内容风格：{s}。")).unwrap_or_default();
    let system = "你是专业的演示文稿策划师。只输出一个 JSON 对象，不解释、不加代码围栏，形如：\n\
                  {\"title\":\"…\",\"subtitle\":\"…\",\"slides\":[{\"title\":\"…\",\
                  \"bullets\":[\"…\"],\"note\":\"讲者备注\"}]}\n\
                  规则：结构完整（开场/主体/收尾），每页 2-6 条要点，每条 ≤60 字，\
                  要点是陈述而非问句；note 是给演讲者的一两句话提示。";
    let user = format!(
        "{context_block}主题：{topic}\n页数：{slide_count} 页（正文页，不含封面）。\n{audience_line}{style_line}请生成大纲。"
    );
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
            Ok(outline) => return Ok(normalize_outline(outline, slide_count + 2)),
            Err(err) => last_error = err,
        }
    }
    Err(format!("大纲生成失败：{last_error}"))
}

/// Core .pptx rendering via the python sidecar — blocking, AppHandle-free.
/// `path` is the absolute output file (a `.pptx` suffix is appended if
/// missing). First call may provision the embedded Python + python-pptx
/// (minutes); later calls are instant.
pub(crate) fn render_pptx_to_path(
    data_dir: &std::path::Path,
    outline: &SlidesOutline,
    path: &str,
) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command as StdCommand, Stdio};

    let mut path = path.trim().to_string();
    if path.is_empty() {
        return Err("保存路径为空".to_string());
    }
    if !path.to_lowercase().ends_with(".pptx") {
        path.push_str(".pptx");
    }
    if outline.slides.is_empty() {
        return Err("大纲没有页面，无法导出".to_string());
    }
    let exe = crate::python_runtime::ensure_pptx_python(data_dir)?;

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
        "title": outline.title,
        "subtitle": outline.subtitle,
        "slides": outline.slides,
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
        let stdin = child.stdin.as_mut().ok_or("渲染器 stdin 不可用")?;
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
    let value: serde_json::Value = serde_json::from_str(line).map_err(|err| {
        let snippet: String = line.chars().take(120).collect();
        format!("渲染器输出无法读取：{err}（片段：{snippet}）")
    })?;
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

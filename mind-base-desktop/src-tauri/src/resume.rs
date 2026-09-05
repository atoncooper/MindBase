//! 简历生成 agent：全量聊天历史 → 分段事实提炼（map）→ 汇总成 Markdown 简历
//! （reduce）。
//!
//! 聊得越久，可提炼的事实越多，简历自然越详细——这是数据形状决定的，不需要
//! 额外开关。历史过大时分段数有上限，超出部分优先保留最近的对话（旧的先丢）。
//! 单段提炼失败不致命（best-effort 跳过），全部失败才报错。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::llm_chat::{ChatClient, ChatMessage};

/// 用户消息少于这个数时不生成——几轮寒暄提炼不出可靠履历。
const MIN_USER_MESSAGES: usize = 6;
/// 每段素材的字符预算（喂给提炼调用的对话片段大小）。
const SEGMENT_CHARS: usize = 6_000;
/// 段数上限；超出时丢弃最早的对话（保留最近）。
const MAX_SEGMENTS: usize = 12;
/// 单条消息进入素材时的截断长度。
const MESSAGE_CHARS: usize = 500;
/// 每段提炼 / 最终撰写的 LLM 超时。
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// Progress pushed to the frontend during one resume run.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ResumeEvent {
    /// Reading chat history; carries the message count found.
    Collecting { messages: usize },
    /// Extracting facts from segment `index` (0-based) of `total`.
    Extracting { index: usize, total: usize },
    /// All facts gathered; composing the final resume.
    Writing,
}

/// Panel-facing generation parameters.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeGenerateRequest {
    /// Optional target role — shifts the resume's emphasis when present.
    #[serde(default)]
    pub target_role: Option<String>,
}

/// Read the full chat history as transcript lines ("用户：…/助手：…"),
/// oldest first. Completed messages only; each clamped to [`MESSAGE_CHARS`].
fn load_transcript(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT role, content FROM chat_messages
             WHERE status = 'completed' AND role IN ('user', 'assistant')
             ORDER BY created_at, rowid",
        )
        .map_err(|err| format!("failed to read chat history: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("failed to read chat history: {err}"))?;
    let mut lines = Vec::new();
    for row in rows {
        let (role, content) = row.map_err(|err| err.to_string())?;
        let content = content.trim();
        if content.is_empty() {
            continue;
        }
        let speaker = if role == "user" { "用户" } else { "助手" };
        let clipped: String = content.chars().take(MESSAGE_CHARS).collect();
        lines.push(format!("{speaker}：{clipped}"));
    }
    Ok(lines)
}

/// Pack transcript lines into character-budgeted segments, keeping at most
/// [`MAX_SEGMENTS`] (oldest dropped first — recent context matters more).
fn pack_segments(lines: &[String]) -> Vec<String> {
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in lines {
        if current.chars().count() + line.chars().count() > SEGMENT_CHARS && !current.is_empty() {
            segments.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.is_empty() {
        segments.push(current);
    }
    if segments.len() > MAX_SEGMENTS {
        segments.split_off(segments.len() - MAX_SEGMENTS)
    } else {
        segments
    }
}

/// System prompt for the per-segment fact extraction (map step).
const EXTRACT_SYSTEM: &str = "你从用户与 AI 助手的历史对话中提取「关于用户的客观事实」。\
只输出条目列表（每行一条、以 - 开头），不要任何前后缀说明。提取维度：\
技术水平与技能栈、项目/作品、工作与教育经历、成果数据、职业目标与偏好。\
规则：只提取对话中明确体现的事实，不推测；没有可用事实时只输出「无」。";

/// Extract fact bullets from one segment; Ok(None) = nothing usable found.
fn extract_segment_facts(
    client: &ChatClient,
    segment: &str,
) -> Result<Option<Vec<String>>, String> {
    let reply = client.complete_turn(
        CALL_TIMEOUT,
        &[
            ChatMessage::new("system", EXTRACT_SYSTEM),
            ChatMessage::new("user", segment),
        ],
    )?;
    let facts: Vec<String> = reply
        .lines()
        .map(|line| line.trim())
        .filter(|line| line.starts_with('-') || line.starts_with('·'))
        .map(|line| line.trim_start_matches(['-', '·', ' ']).trim().to_string())
        .filter(|line| !line.is_empty() && line != "无")
        .collect();
    if facts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(facts))
    }
}

/// Build the final resume (reduce step) from accumulated fact bullets.
fn compose_resume(
    client: &ChatClient,
    facts: &[String],
    target_role: Option<&str>,
) -> Result<String, String> {
    let role_line = match target_role {
        Some(role) => format!("求职方向：{role}。内容取舍与措辞向该方向倾斜。"),
        None => String::new(),
    };
    let system = "你是专业简历撰写师。依据提供的用户事实素材撰写一份 Markdown 简历。\
要求：\n\
1. 结构：# 姓名（未知写「你的姓名」）→ 一句话概述 → 技能 → 项目经验 → 工作/实践经历 → 教育背景；\n\
2. 联系方式等未知信息用占位符（如「邮箱：待补充」），并在文末用「> 注：标注「待补充」的内容请自行填写，标注「推断」的内容基于历史对话总结，请核实」说明；\n\
3. 严格基于素材，不编造经历与数字；素材不足的板块宁可精简；\n\
4. 项目经验用「项目名 + 一句话背景 + 要点列表（含可量化的成果）」；\n\
5. 只输出 Markdown，不解释。";
    let user = format!(
        "用户事实素材：\n{}\n\n{}请生成简历。",
        facts.join("\n"),
        role_line
    );
    client.complete_turn(
        CALL_TIMEOUT,
        &[
            ChatMessage::new("system", system),
            ChatMessage::new("user", user),
        ],
    )
}

/// Generate a resume from the full chat history; returns Markdown.
#[tauri::command]
pub async fn resume_generate(
    app: AppHandle,
    request: ResumeGenerateRequest,
    on_event: Channel<ResumeEvent>,
) -> Result<String, String> {
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

    let handle = app.clone();
    let target_role = request.target_role;
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Db>();
        let lines = {
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            load_transcript(&conn)?
        };
        let user_messages = lines.iter().filter(|line| line.starts_with("用户：")).count();
        if user_messages < MIN_USER_MESSAGES {
            return Err(format!(
                "历史对话太少（仅 {user_messages} 条用户消息，至少需要 {MIN_USER_MESSAGES} 条）。\
                 先多和助手聊聊你的项目与技能，简历会越聊越详细"
            ));
        }
        let _ = on_event.send(ResumeEvent::Collecting { messages: lines.len() });

        let segments = pack_segments(&lines);
        let total = segments.len();
        let mut facts: Vec<String> = Vec::new();
        for (index, segment) in segments.iter().enumerate() {
            let _ = on_event.send(ResumeEvent::Extracting { index, total });
            // 单段失败不阻塞整体（best-effort）。
            if let Ok(Some(segment_facts)) = extract_segment_facts(&client, segment) {
                facts.extend(segment_facts);
            }
        }
        if facts.is_empty() {
            return Err("没能从历史对话中提炼出可用素材，无法生成简历".to_string());
        }
        let _ = on_event.send(ResumeEvent::Writing);
        compose_resume(&client, &facts, target_role.as_deref())
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

/// Write Markdown/text content to a user-chosen path (export button).
#[tauri::command]
pub async fn export_text_file(path: String, contents: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("保存路径为空".to_string());
    }
    std::fs::write(&path, contents)
        .map_err(|err| format!("写入文件失败（{path}）：{err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_segments_respects_budget_and_keeps_recent() {
        // Each line ~10 chars; budget 6000 → many lines per segment.
        let lines: Vec<String> = (0..3000)
            .map(|index| {
                if index % 2 == 0 {
                    format!("用户：消息{index}aaaaaaaa")
                } else {
                    format!("助手：回复{index}aaaaaaaa")
                }
            })
            .collect();
        let segments = pack_segments(&lines);
        assert!(!segments.is_empty());
        assert!(segments.len() <= MAX_SEGMENTS);
        // Every line survives (below the drop-oldest threshold here).
        let total_lines: usize = segments.iter().map(|s| s.lines().count()).sum();
        assert_eq!(total_lines, lines.len());

        // Beyond the cap, the oldest segments are dropped.
        let many: Vec<String> = (0..200_000)
            .map(|index| format!("用户：填充{index}"))
            .collect();
        let capped = pack_segments(&many);
        assert_eq!(capped.len(), MAX_SEGMENTS);
        assert!(
            !capped[0].contains("填充0"),
            "oldest content must be dropped first"
        );
        assert!(capped.last().unwrap().ends_with('\n') || !capped.last().unwrap().is_empty());
    }

    #[test]
    fn transcript_lines_are_speaker_prefixed() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_messages(
                 chat_session_id TEXT NOT NULL,
                 role TEXT NOT NULL,
                 content TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'completed',
                 created_at INTEGER NOT NULL);",
        )
        .unwrap();
        for (role, content, at) in [
            ("user", "我在做 RAG 项目", 1),
            ("assistant", "好的，需要我帮忙吗", 2),
            ("user", "  ", 3), // blank → skipped
        ] {
            conn.execute(
                "INSERT INTO chat_messages(chat_session_id, role, content, status, created_at)
                 VALUES('s', ?1, ?2, 'completed', ?3)",
                rusqlite::params![role, content, at],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO chat_messages(chat_session_id, role, content, status, created_at)
             VALUES('s', 'assistant', '这个消息失败了', 'failed', 3)",
            [],
        )
        .unwrap();

        let lines = load_transcript(&conn).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("用户：我在做 RAG 项目"));
        assert!(lines[1].starts_with("助手：好的"));
    }
}

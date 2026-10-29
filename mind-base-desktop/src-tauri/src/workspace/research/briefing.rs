//! Research assistant briefing: project snapshot + stage-specific prompt body.

use rusqlite::{params, Connection};

use super::store::{get_project_conn, list_artifacts_conn, list_stages_conn};
use super::{ResearchArtifact, ResearchProject, ResearchStage};
use super::{STAGE_LABELS, STAGES};

pub(super) fn stage_prompt_name(stage: &str) -> &'static str {
    match stage {
        "topic" => "选题",
        "design" => "研究设计",
        "advise" => "指导",
        "experiment" => "实验",
        "writing" => "写作",
        "submission" => "投稿",
        _ => "指导",
    }
}

pub(super) fn build_briefing(
    conn: &Connection,
    project: &ResearchProject,
    stages: &[ResearchStage],
    artifacts: &[ResearchArtifact],
) -> Result<String, String> {
    let mut out = String::new();
    out.push_str(&format!(
        "- 项目：{}（类型：{}；目标期刊：{}；截止：{}）\n",
        project.title,
        project.paper_kind,
        if project.target_venue.is_empty() {
            "未填写"
        } else {
            &project.target_venue
        },
        if project.deadline.is_empty() {
            "未填写"
        } else {
            &project.deadline
        },
    ));
    if !project.field.is_empty() {
        out.push_str(&format!("- 研究方向：{}\n", project.field));
    }
    out.push_str(&format!(
        "- 数据边界：{}（local=不出本机；summary_ok=仅发摘要；cloud_ok=可发正文）\n",
        project.privacy
    ));

    let stage_line = stages
        .iter()
        .map(|stage| format!("{}({})", stage.label, stage.status))
        .collect::<Vec<_>>()
        .join(" → ");
    out.push_str(&format!("- 阶段状态：{stage_line}\n"));
    let stage_label = STAGES
        .iter()
        .position(|candidate| candidate == &project.current_stage)
        .map(|index| STAGE_LABELS[index])
        .unwrap_or(project.current_stage.as_str());
    out.push_str(&format!("- 当前阶段：{stage_label}\n"));

    if artifacts.is_empty() {
        out.push_str("- 已有产物：无\n");
    } else {
        out.push_str("- 已有产物：\n");
        for artifact in artifacts.iter().take(12) {
            out.push_str(&format!(
                "  - [{}] {}（{}，v{}，{}）\n",
                artifact.stage, artifact.title, artifact.kind, artifact.version, artifact.status
            ));
        }
    }

    // Literature (metadata only — never bodies).
    let mut stmt = conn
        .prepare(
            "SELECT title, year, status FROM literature_refs WHERE project_id = ?1 \
             ORDER BY created_at DESC LIMIT 15",
        )
        .map_err(|err| format!("failed to prepare literature brief: {err}"))?;
    let rows = stmt
        .query_map(params![&project.id], |row| {
            let title: String = row.get(0)?;
            let year: Option<i64> = row.get(1)?;
            let status: String = row.get(2)?;
            Ok((title, year, status))
        })
        .map_err(|err| format!("failed to query literature brief: {err}"))?;
    let literature: Vec<(String, Option<i64>, String)> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read literature brief: {err}"))?;
    if literature.is_empty() {
        out.push_str("- 文献：尚未导入（提示用户用「文献」页导入 BibTeX/CSL）\n");
    } else {
        out.push_str(&format!("- 文献（最近 {} 条）：\n", literature.len()));
        for (index, (title, year, status)) in literature.iter().enumerate() {
            out.push_str(&format!(
                "  - [{}] {} ({}) {}\n",
                index + 1,
                title,
                year.map(|value| value.to_string()).unwrap_or_else(|| "n.d.".to_string()),
                status
            ));
        }
    }

    // Datasets (profile summary only — never raw rows).
    let mut stmt = conn
        .prepare(
            "SELECT name, rows, cols, privacy FROM datasets WHERE project_id = ?1 \
             ORDER BY created_at DESC LIMIT 8",
        )
        .map_err(|err| format!("failed to prepare dataset brief: {err}"))?;
    let rows = stmt
        .query_map(params![&project.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|err| format!("failed to query dataset brief: {err}"))?;
    let datasets: Vec<(String, Option<i64>, Option<i64>, String)> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read dataset brief: {err}"))?;
    if !datasets.is_empty() {
        out.push_str("- 数据集：\n");
        for (name, row_count, col_count, privacy) in datasets {
            out.push_str(&format!(
                "  - {}（{} 行 × {} 列，{}）\n",
                name,
                row_count.map(|value| value.to_string()).unwrap_or_else(|| "?".to_string()),
                col_count.map(|value| value.to_string()).unwrap_or_else(|| "?".to_string()),
                privacy
            ));
        }
    }

    // Recent decisions.
    let mut stmt = conn
        .prepare(
            "SELECT decision FROM decisions WHERE project_id = ?1 ORDER BY ts DESC LIMIT 8",
        )
        .map_err(|err| format!("failed to prepare decision brief: {err}"))?;
    let rows = stmt
        .query_map(params![&project.id], |row| row.get::<_, String>(0))
        .map_err(|err| format!("failed to query decision brief: {err}"))?;
    let decisions: Vec<String> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read decision brief: {err}"))?;
    if !decisions.is_empty() {
        out.push_str("- 最近决策：\n");
        for decision in decisions {
            out.push_str(&format!("  - {decision}\n"));
        }
    }

    Ok(out)
}

/// 主聊天用：拼装一个项目的简报（阶段/产物/文献/数据/决策摘要）。
/// 只读、不写事件；项目不存在时返回错误。
pub(crate) fn project_briefing(conn: &Connection, project_id: &str) -> Result<String, String> {
    let project = get_project_conn(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let stages = list_stages_conn(conn, project_id)?;
    let artifacts = list_artifacts_conn(conn, project_id)?;
    build_briefing(conn, &project, &stages, &artifacts)
}

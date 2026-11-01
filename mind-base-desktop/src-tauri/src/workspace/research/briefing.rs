//! Research assistant briefing: project snapshot + stage-specific prompt body.
//!
//! 只做展示文案拼装；数据访问走 repositories::research::stats 的只读摘要查询。

use rusqlite::Connection;

use crate::repositories::research::stats;

use super::service;
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
    let literature = stats::recent_literature(conn, &project.id, 15)?;
    if literature.is_empty() {
        out.push_str("- 文献：尚未导入（提示用户用「文献」页导入 BibTeX/CSL）\n");
    } else {
        out.push_str(&format!("- 文献（最近 {} 条）：\n", literature.len()));
        for (index, row) in literature.iter().enumerate() {
            out.push_str(&format!(
                "  - [{}] {} ({}) {}\n",
                index + 1,
                row.title,
                row.year
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "n.d.".to_string()),
                row.status
            ));
        }
    }

    // Datasets (profile summary only — never raw rows).
    let datasets = stats::recent_datasets(conn, &project.id, 8)?;
    if !datasets.is_empty() {
        out.push_str("- 数据集：\n");
        for row in datasets {
            out.push_str(&format!(
                "  - {}（{} 行 × {} 列，{}）\n",
                row.name,
                row.rows
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "?".to_string()),
                row.cols
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "?".to_string()),
                row.privacy
            ));
        }
    }

    // Recent decisions.
    let decisions = stats::recent_decisions(conn, &project.id, 8)?;
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
    let detail = service::detail(conn, project_id)?;
    build_briefing(conn, &detail.project, &detail.stages, &detail.artifacts)
}

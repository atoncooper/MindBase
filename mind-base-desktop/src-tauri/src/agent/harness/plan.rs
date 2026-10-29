//! Plan state machine behind the `plan` tool (create / update / revise).

use super::{ToolContext, ToolOutput};
use crate::agent::agents::AgentKind;

/// One step of an agent task plan.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PlanStepView {
    pub desc: String,
    pub status: String, // pending | in_progress | done | failed | skipped
    pub note: String,
}

/// Serialized snapshot of the current plan (frontend-facing shape).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PlanSnapshot {
    pub version: u32,
    pub steps: Vec<PlanStepView>,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanStepStatus {
    Pending,
    InProgress,
    Done,
    Failed,
    Skipped,
}

impl PlanStepStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
    fn mark(&self) -> &'static str {
        match self {
            Self::Pending => "·",
            Self::InProgress => "▶",
            Self::Done => "✓",
            Self::Failed => "✗",
            Self::Skipped => "⊘",
        }
    }
}

#[derive(Debug, Clone)]
struct PlanStep {
    desc: String,
    status: PlanStepStatus,
    note: String,
}

/// Per-run plan state — created via the plan tool, mutated as the run
/// proceeds, logged as checkpoint events.
#[derive(Debug, Clone, Default)]
pub(super) struct PlanState {
    version: u32,
    steps: Vec<PlanStep>,
    replans: u32,
}

impl PlanState {
    pub(super) fn snapshot(&self) -> PlanSnapshot {
        let done = self
            .steps
            .iter()
            .filter(|step| matches!(step.status, PlanStepStatus::Done | PlanStepStatus::Skipped))
            .count();
        PlanSnapshot {
            version: self.version,
            total: self.steps.len(),
            done,
            steps: self
                .steps
                .iter()
                .map(|step| PlanStepView {
                    desc: step.desc.clone(),
                    status: step.status.as_str().to_string(),
                    note: step.note.clone(),
                })
                .collect(),
        }
    }

    fn render(&self) -> String {
        let done = self
            .steps
            .iter()
            .filter(|step| matches!(step.status, PlanStepStatus::Done | PlanStepStatus::Skipped))
            .count();
        let mut lines = vec![format!(
            "【任务计划 v{} · {}/{} 完成】",
            self.version,
            done,
            self.steps.len()
        )];
        for (index, step) in self.steps.iter().enumerate() {
            let mark = step.status.mark();
            let line = format!("{} {}. {}", mark, index + 1, step.desc);
            lines.push(if step.note.is_empty() {
                line
            } else {
                format!("{line} —— {}", step.note)
            });
        }
        lines.join(
            "
",
        )
    }
}

const PLAN_REVISE_LIMIT: u32 = 3;

/// Handle one `plan` tool call against the run's plan state machine.
/// Every mutation is logged as a checkpoint event (events.jsonl) and pushed
/// to the frontend via the on_plan callback.
pub(super) fn apply_plan(
    plan: &mut Option<PlanState>,
    arguments: &str,
    ctx: &ToolContext,
    kind: AgentKind,
    step_no: u32,
) -> ToolOutput {
    let value: serde_json::Value = match serde_json::from_str(arguments) {
        Ok(value) => value,
        Err(err) => return ToolOutput::text(format!("plan 参数解析失败：{err}")),
    };
    let action = value.get("action").and_then(|a| a.as_str()).unwrap_or("");

    fn parse_steps(value: &serde_json::Value) -> Vec<PlanStep> {
        value
            .get("steps")
            .and_then(|steps| steps.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let desc =
                            item.as_str()
                                .map(str::trim)
                                .map(str::to_string)
                                .or_else(|| {
                                    item.get("desc")
                                        .and_then(|d| d.as_str())
                                        .map(|s| s.trim().to_string())
                                })?;
                        if desc.is_empty() {
                            return None;
                        }
                        Some(PlanStep {
                            desc,
                            status: PlanStepStatus::Pending,
                            note: String::new(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn log_checkpoint(ctx: &ToolContext, kind: AgentKind, step_no: u32, what: &str, status: &str) {
        if let Ok(dir) = ctx.db.data_dir.lock() {
            let root = dir.join("conversations").join(&ctx.session_id);
            let _ = crate::infra::store::append_event(
                &root,
                serde_json::json!({
                    "ev": "checkpoint",
                    "agent": kind.name(),
                    "step": step_no,
                    "what": what,
                    "status": status,
                }),
            );
        }
    }

    match action {
        "create" => {
            if plan.is_some() {
                return ToolOutput::text(
                    "计划已存在。调整剩余步骤用 action=revise；更新步骤状态用 action=update。",
                );
            }
            let steps = parse_steps(&value);
            if steps.is_empty() {
                return ToolOutput::text("steps 不能为空（每项为一步的描述）");
            }
            *plan = Some(PlanState {
                version: 1,
                steps,
                replans: 0,
            });
            log_checkpoint(ctx, kind, step_no, "created", "计划创建");
            ToolOutput::text(current_render(plan))
        }
        "update" => {
            let Some(state) = plan.as_mut() else {
                return ToolOutput::text("尚未创建计划（先用 action=create）");
            };
            let no = value.get("step").and_then(|s| s.as_u64()).unwrap_or(0) as usize;
            if no == 0 || no > state.steps.len() {
                return ToolOutput::text(format!("步骤编号无效：{no}（1-{}）", state.steps.len()));
            }
            let status = value
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("done");
            let parsed = match status {
                "pending" => PlanStepStatus::Pending,
                "in_progress" => PlanStepStatus::InProgress,
                "done" => PlanStepStatus::Done,
                "failed" => PlanStepStatus::Failed,
                "skipped" => PlanStepStatus::Skipped,
                other => {
                    return ToolOutput::text(format!(
                        "未知状态 {other}（pending|in_progress|done|failed|skipped）"
                    ))
                }
            };
            let note = value
                .get("note")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let step = &mut state.steps[no - 1];
            step.status = parsed;
            step.note = note;
            log_checkpoint(ctx, kind, step_no, &format!("step {no}"), status);
            ToolOutput::text(current_render(plan))
        }
        "revise" => {
            let Some(state) = plan.as_mut() else {
                return ToolOutput::text("尚未创建计划");
            };
            if state.replans >= PLAN_REVISE_LIMIT {
                return ToolOutput::text(
                    "计划修订次数已达上限（3 次）。请基于当前计划继续执行，或直接总结已完成的产出。",
                );
            }
            let steps = parse_steps(&value);
            if steps.is_empty() {
                return ToolOutput::text("steps 不能为空");
            }
            state.replans += 1;
            state.version += 1;
            state.steps = steps;
            let reason = value
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            log_checkpoint(
                ctx,
                kind,
                step_no,
                &format!("revised v{}", state.version),
                &reason,
            );
            ToolOutput::text(current_render(plan))
        }
        other => ToolOutput::text(format!(
            "未知 action：{other}（可用：create 创建计划 / update 更新步骤状态 / revise 修订计划）"
        )),
    }
}

fn current_render(plan: &Option<PlanState>) -> String {
    plan.as_ref().map(PlanState::render).unwrap_or_default()
}

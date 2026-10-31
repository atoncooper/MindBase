//! 进行中回合的实时快照（切走 / 切会话 / 刷新后恢复用）。
//!
//! 流式事件原本只通过 Tauri Channel 发给当前挂载的 ChatView；一旦切视图或
//! 切会话，前端状态就丢了。这里在 Rust 侧保留一份轻量快照（步骤 / 增量正文 /
//! 计划 / 当前子代理），前端回到会话时轮询 chat_live_state 恢复现场。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::agent::harness::PlanSnapshot;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveToolStep {
    pub step: u32,
    pub action: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSubStep {
    pub step: u32,
    pub agent: String,
    pub action: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgentView {
    pub name: String,
    pub action: String,
    pub step: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTurnView {
    pub session_id: String,
    pub question: String,
    pub answer: String,
    pub steps: Vec<LiveToolStep>,
    pub sub_steps: Vec<LiveSubStep>,
    pub live_agent: Option<LiveAgentView>,
    pub plan: Option<PlanSnapshot>,
    pub started_at: i64,
}

#[derive(Debug, Clone, Default)]
struct LiveTurn {
    question: String,
    answer: String,
    steps: Vec<LiveToolStep>,
    sub_steps: Vec<LiveSubStep>,
    live_agent: Option<LiveAgentView>,
    plan: Option<PlanSnapshot>,
    started_at: i64,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn registry() -> &'static Mutex<HashMap<String, LiveTurn>> {
    static LIVE: OnceLock<Mutex<HashMap<String, LiveTurn>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn start(session_id: &str, question: &str) {
    if let Ok(mut map) = registry().lock() {
        map.insert(
            session_id.to_string(),
            LiveTurn {
                question: question.to_string(),
                started_at: now_secs(),
                ..Default::default()
            },
        );
    }
}

pub(crate) fn set_step(session_id: &str, step: u32, action: &str, query: &str) {
    if let Ok(mut map) = registry().lock() {
        if let Some(turn) = map.get_mut(session_id) {
            turn.steps.push(LiveToolStep {
                step,
                action: action.to_string(),
                query: query.to_string(),
            });
            turn.live_agent = Some(LiveAgentView {
                name: String::new(),
                action: action.to_string(),
                step,
            });
        }
    }
}

pub(crate) fn set_sub_step(
    session_id: &str,
    step: u32,
    agent: &str,
    action: &str,
    query: &str,
) {
    if let Ok(mut map) = registry().lock() {
        if let Some(turn) = map.get_mut(session_id) {
            turn.sub_steps.push(LiveSubStep {
                step,
                agent: agent.to_string(),
                action: action.to_string(),
                query: query.to_string(),
            });
            turn.live_agent = Some(LiveAgentView {
                name: format!("{agent}（子代理）"),
                action: action.to_string(),
                step,
            });
        }
    }
}

pub(crate) fn set_plan(session_id: &str, plan: &PlanSnapshot) {
    if let Ok(mut map) = registry().lock() {
        if let Some(turn) = map.get_mut(session_id) {
            turn.plan = Some(plan.clone());
        }
    }
}

pub(crate) fn append_answer(session_id: &str, delta: &str) {
    if let Ok(mut map) = registry().lock() {
        if let Some(turn) = map.get_mut(session_id) {
            turn.answer.push_str(delta);
        }
    }
}

pub(crate) fn clear(session_id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(session_id);
    }
}

pub(crate) fn snapshot(session_id: &str) -> Option<LiveTurnView> {
    let map = registry().lock().ok()?;
    let turn = map.get(session_id)?;
    Some(LiveTurnView {
        session_id: session_id.to_string(),
        question: turn.question.clone(),
        answer: turn.answer.clone(),
        steps: turn.steps.clone(),
        sub_steps: turn.sub_steps.clone(),
        live_agent: turn.live_agent.clone(),
        plan: turn.plan.clone(),
        started_at: turn.started_at,
    })
}

/// 前端切回会话 / 刷新页面时读取进行中回合；None = 当前没有在跑。
#[tauri::command]
pub fn chat_live_state(session_id: String) -> Result<Option<LiveTurnView>, String> {
    Ok(snapshot(&session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_snapshot_tracks_steps_answer_and_plan_then_clears() {
        start("live-test", "正在搜索");
        set_step("live-test", 1, "vector_search", "记忆机制");
        set_sub_step("live-test", 2, "academic", "literature", "相关文献");
        append_answer("live-test", "第一段");
        append_answer("live-test", "第二段");
        let plan = PlanSnapshot {
            version: 1,
            steps: vec![],
            done: 0,
            total: 0,
        };
        set_plan("live-test", &plan);
        let view = snapshot("live-test").expect("live snapshot");
        assert_eq!(view.answer, "第一段第二段");
        assert_eq!(view.steps.len(), 1);
        assert_eq!(view.sub_steps.len(), 1);
        assert_eq!(view.sub_steps[0].agent, "academic");
        assert!(view.live_agent.is_some());
        assert_eq!(view.plan.expect("plan").version, 1);
        clear("live-test");
        assert!(snapshot("live-test").is_none());
    }
}

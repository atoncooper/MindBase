//! AgentRuntime — concurrent tool execution with per-tool metrics and
//! sibling-isolated failures. Desktop counterpart of app/harness/runtime.py.
//!
//! Backend semantics preserved: one failing tool becomes a `工具执行失败: …`
//! result instead of killing its siblings, results normalize to
//! `{content, extras}`, and every call feeds the per-tool metrics map.
//!
//! Desktop hardening: every call gets its own OS thread plus a hard
//! wall-clock timeout (`MIND_BASE_TOOL_TIMEOUT_SECS`, default 180s). A stuck
//! tool can no longer freeze the ReAct turn — its slot degrades to a readable
//! `工具执行超时…` result, the remaining calls still return, and the turn
//! continues. The abandoned worker is detached (it owns its `Arc` pieces),
//! so cleanup needs no join.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use super::registry::{ToolContext, ToolOutput};
use crate::llm::client::ToolCallReq;

/// Default hard wall-clock cap for one tool call.
const DEFAULT_TOOL_TIMEOUT_SECS: u64 = 180;
/// Environment override for the per-call timeout (whole seconds).
const TOOL_TIMEOUT_ENV: &str = "MIND_BASE_TOOL_TIMEOUT_SECS";

/// Per-tool rolling metrics, exposed via [`AgentRuntime::monitor`].
#[derive(Debug, Default, Clone)]
pub(crate) struct ToolMetrics {
    pub call_count: u64,
    pub error_count: u64,
    pub total_duration_ms: f64,
    pub last_error: Option<String>,
}

/// Registry plus rolling execution metrics and the per-call hard timeout.
pub(crate) struct AgentRuntime {
    registry: super::registry::ToolRegistry,
    metrics: Mutex<HashMap<String, ToolMetrics>>,
    tool_timeout: Duration,
}

/// One executed call: request plus its isolated outcome.
pub(crate) struct ExecutedCall {
    pub call: ToolCallReq,
    /// Always `Ok` — execution errors are already degraded into
    /// `工具执行失败: …` text results by the isolation layer.
    pub outcome: Result<ToolOutput, String>,
}

/// Parse the timeout override; invalid / zero values fall back to the default.
fn timeout_secs_from_raw(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(DEFAULT_TOOL_TIMEOUT_SECS)
}

fn tool_timeout_from_env() -> Duration {
    let raw = std::env::var(TOOL_TIMEOUT_ENV).ok();
    Duration::from_secs(timeout_secs_from_raw(raw.as_deref()))
}

/// Human-readable timeout label (whole seconds stay clean, sub-second shows
/// milliseconds so tests / logs don't read "0s").
fn timeout_label(timeout: Duration) -> String {
    let secs = timeout.as_secs_f64();
    if secs >= 1.0 && secs.fract() == 0.0 {
        format!("{}s", secs as u64)
    } else {
        format!("{secs:.3}s")
    }
}

impl AgentRuntime {
    pub(crate) fn new() -> Self {
        Self {
            registry: super::registry::ToolRegistry::default(),
            metrics: Mutex::new(HashMap::new()),
            tool_timeout: tool_timeout_from_env(),
        }
    }

    /// Test-only constructor with an explicit timeout (millisecond granularity
    /// is needed to exercise the timeout path without slow tests).
    #[cfg(test)]
    pub(crate) fn with_tool_timeout(timeout: Duration) -> Self {
        let mut runtime = Self::new();
        runtime.tool_timeout = timeout;
        runtime
    }

    pub(crate) fn registry_mut(&mut self) -> &mut super::registry::ToolRegistry {
        &mut self.registry
    }

    /// Read-only registry view (test support / tool lookup).
    pub(crate) fn registry(&self) -> &super::registry::ToolRegistry {
        &self.registry
    }

    /// Wire specs of every registered tool (agent-status UI / tool listing).
    pub(crate) fn tool_specs(&self) -> Vec<super::registry::ToolSpec> {
        self.registry.specs()
    }

    /// OpenAI tools array restricted to an explicit allow-list — one agent
    /// binds only its own subset of the registry.
    pub(crate) fn schema_for_names(&self, allowed: &[&str]) -> serde_json::Value {
        serde_json::Value::Array(
            allowed
                .iter()
                .filter_map(|name| {
                    let tool = self.registry.get(name)?;
                    let spec = tool.spec();
                    Some(json!({
                        "type": "function",
                        "function": {
                            "name": spec.name,
                            "description": spec.description,
                            "parameters": spec.parameters
                        }
                    }))
                })
                .collect(),
        )
    }

    fn record(&self, name: &str, duration_ms: f64, error: Option<&str>) {
        let mut metrics = self.metrics.lock().expect("runtime metrics poisoned");
        let entry = metrics.entry(name.to_string()).or_default();
        entry.call_count += 1;
        entry.total_duration_ms += duration_ms;
        if let Some(error_text) = error {
            entry.error_count += 1;
            entry.last_error = Some(error_text.to_string());
        }
    }

    /// Execute every call on its own thread, waiting at most `tool_timeout`
    /// per call; outcomes always return in input order.
    ///
    /// A timed-out call is abandoned (thread detached, it owns cloned `Arc`
    /// handles) and degrades to a readable `工具执行超时…` text result, so the
    /// rest of the turn keeps moving. Unknown tools and thread panics become
    /// ordinary isolated errors — never a process panic.
    pub(crate) fn execute(&self, ctx: &ToolContext, calls: &[ToolCallReq]) -> Vec<ExecutedCall> {
        if calls.is_empty() {
            return Vec::new();
        }

        let (sender, receiver) = mpsc::channel::<(usize, f64, Result<ToolOutput, String>)>();
        let available = self.registry.names().join(", ");
        let mut outcomes: Vec<Option<(f64, Result<ToolOutput, String>)>> =
            (0..calls.len()).map(|_| None).collect();

        for (index, call) in calls.iter().enumerate() {
            let tool = self.registry.get(&call.name);
            let name = call.name.clone();
            let arguments = call.arguments.clone();
            let worker_ctx = ctx.clone();
            let worker_sender = sender.clone();
            let available = available.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("tool-{name}"))
                .spawn(move || {
                    let started = Instant::now();
                    // Panic isolation: a panicking tool reports back as an
                    // ordinary error instead of unwinding across threads.
                    let result = match tool {
                        Some(tool) => std::panic::catch_unwind(AssertUnwindSafe(|| {
                            tool.execute(&worker_ctx, &arguments)
                        }))
                        .unwrap_or_else(|_| Err("工具线程异常退出（panic）".to_string())),
                        None => Err(format!("未知工具：{name}（可用：{available}）")),
                    };
                    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
                    // Receiver may be gone when this call already timed out.
                    let _ = worker_sender.send((index, duration_ms, result));
                });
            if let Err(err) = spawned {
                outcomes[index] = Some((0.0, Err(format!("无法启动工具线程：{err}"))));
            }
        }
        // Only the workers hold senders now: when they all finish the channel
        // disconnects instead of hanging forever.
        drop(sender);

        let mut buffered: HashMap<usize, (f64, Result<ToolOutput, String>)> = HashMap::new();
        for index in 0..calls.len() {
            if outcomes[index].is_some() {
                continue;
            }
            if let Some(done) = buffered.remove(&index) {
                outcomes[index] = Some(done);
                continue;
            }
            loop {
                match receiver.recv_timeout(self.tool_timeout) {
                    Ok((worker_index, duration_ms, result)) => {
                        if worker_index == index {
                            outcomes[index] = Some((duration_ms, result));
                            break;
                        }
                        buffered.insert(worker_index, (duration_ms, result));
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        let message = format!(
                            "工具执行超时（超过 {}）：{}，已跳过本次等待",
                            timeout_label(self.tool_timeout),
                            calls[index].name
                        );
                        eprintln!("[RUNTIME] {message}");
                        outcomes[index] =
                            Some((self.tool_timeout.as_secs_f64() * 1000.0, Err(message)));
                        break;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        let message =
                            format!("工具线程异常退出（通道断开）：{}", calls[index].name);
                        outcomes[index] = Some((0.0, Err(message)));
                        break;
                    }
                }
            }
        }

        calls
            .iter()
            .zip(outcomes)
            .map(|(call, done)| {
                let (duration_ms, outcome) =
                    done.unwrap_or_else(|| (0.0, Err("工具线程未返回结果".to_string())));
                match &outcome {
                    Ok(_) => self.record(&call.name, duration_ms, None),
                    Err(error) => self.record(&call.name, duration_ms, Some(error)),
                }
                // Sibling isolation: an execution error degrades to plain text
                // so the remaining calls stay meaningful to the model.
                let isolated = outcome
                    .unwrap_or_else(|error| ToolOutput::text(format!("工具执行失败: {error}")));
                ExecutedCall {
                    call: call.clone(),
                    outcome: Ok(isolated),
                }
            })
            .collect()
    }

    /// Runtime facts for a future health panel; also consumed by tests.
    pub(crate) fn monitor(&self) -> serde_json::Value {
        let metrics = self.metrics.lock().expect("runtime metrics poisoned");
        let mut totals_call = 0u64;
        let mut totals_error = 0u64;
        let tools: Vec<serde_json::Value> = metrics
            .iter()
            .map(|(name, entry)| {
                totals_call += entry.call_count;
                totals_error += entry.error_count;
                json!({
                    "name": name,
                    "callCount": entry.call_count,
                    "errorCount": entry.error_count,
                    "totalDurationMs": entry.total_duration_ms,
                    "lastError": entry.last_error,
                })
            })
            .collect();
        json!({
            "tools": tools,
            "totals": { "callCount": totals_call, "errorCount": totals_error },
            "registeredTools": self.registry.names(),
            "toolTimeoutSecs": self.tool_timeout.as_secs_f64(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::harness::registry::{LocalTool, ToolSpec};
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    struct ScriptedTool {
        spec: ToolSpec,
        fail: bool,
        sleep_ms: u64,
        calls: AtomicU32,
    }

    impl LocalTool for ScriptedTool {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        fn execute(&self, _ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.sleep_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.sleep_ms));
            }
            if self.fail {
                Err(format!("boom {arguments}"))
            } else {
                Ok(ToolOutput::text(format!("done:{arguments}")))
            }
        }
    }

    fn scripted(name: &'static str, fail: bool, sleep_ms: u64) -> Box<ScriptedTool> {
        Box::new(ScriptedTool {
            spec: ToolSpec {
                name,
                description: name.into(),
                parameters: json!({}),
            },
            fail,
            sleep_ms,
            calls: AtomicU32::new(0),
        })
    }

    /// A tool that always panics — proves panic isolation across threads.
    struct PanicTool {
        spec: ToolSpec,
    }

    impl LocalTool for PanicTool {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        fn execute(&self, _ctx: &ToolContext, _arguments: &str) -> Result<ToolOutput, String> {
            panic!("tool exploded");
        }
    }

    fn memory_db() -> crate::infra::db::Db {
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");
        crate::infra::db::Db {
            conn: Arc::new(Mutex::new(conn)),
            data_dir: Arc::new(Mutex::new(std::path::PathBuf::from("."))),
            default_dir: std::path::PathBuf::from("."),
        }
    }

    fn test_ctx(db: &crate::infra::db::Db) -> ToolContext {
        ToolContext {
            db: db.clone(),
            embed_client: None,
            chat_client: None,
            session_id: "s".to_string(),
            agent: crate::agent::agents::AgentKind::Chat,
            delegate: None,
        }
    }

    fn call(name: &str) -> ToolCallReq {
        ToolCallReq {
            id: name.to_string(),
            name: name.to_string(),
            arguments: "{}".to_string(),
        }
    }

    #[test]
    fn sibling_isolation_keeps_other_results_alive() {
        let mut runtime = AgentRuntime::new();
        runtime
            .registry_mut()
            .register(scripted("ok_tool", false, 0));
        runtime
            .registry_mut()
            .register(scripted("bad_tool", true, 0));

        let db = memory_db();
        let ctx = test_ctx(&db);
        let calls = vec![call("bad_tool"), call("ok_tool")];

        let executed = runtime.execute(&ctx, &calls);
        assert_eq!(executed.len(), 2);
        // The failing call degrades to isolated text…
        assert!(executed[0]
            .outcome
            .as_ref()
            .unwrap()
            .content
            .starts_with("工具执行失败: "));
        // …while its sibling still succeeds.
        assert_eq!(executed[1].outcome.as_ref().unwrap().content, "done:{}");

        let monitor = runtime.monitor();
        assert_eq!(monitor["totals"]["callCount"], 2);
        assert_eq!(monitor["totals"]["errorCount"], 1);
    }

    #[test]
    fn unknown_tool_fails_in_place_with_available_names() {
        let mut runtime = AgentRuntime::new();
        runtime.registry_mut().register(scripted("known", false, 0));
        let db = memory_db();
        let ctx = test_ctx(&db);
        let executed = runtime.execute(&ctx, &[call("nope")]);
        let text = executed[0].outcome.as_ref().unwrap().content.clone();
        assert!(text.contains("未知工具：nope"));
        assert!(text.contains("known"));
    }

    #[test]
    fn concurrent_execution_overlaps_sleeps() {
        let mut runtime = AgentRuntime::new();
        runtime
            .registry_mut()
            .register(scripted("slow_a", false, 120));
        runtime
            .registry_mut()
            .register(scripted("slow_b", false, 120));

        let db = memory_db();
        let ctx = test_ctx(&db);
        let started = Instant::now();
        let executed = runtime.execute(&ctx, &[call("slow_a"), call("slow_b")]);
        assert_eq!(executed.len(), 2);
        // Two 120 ms sleeps run concurrently → well under their serial sum.
        assert!(
            started.elapsed() < std::time::Duration::from_millis(260),
            "calls must overlap: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn stuck_tool_times_out_and_does_not_block_the_turn() {
        let mut runtime = AgentRuntime::with_tool_timeout(Duration::from_millis(50));
        runtime
            .registry_mut()
            .register(scripted("stuck", false, 300));
        runtime.registry_mut().register(scripted("quick", false, 0));

        let db = memory_db();
        let ctx = test_ctx(&db);
        let started = Instant::now();
        let executed = runtime.execute(&ctx, &[call("stuck"), call("quick")]);
        let elapsed = started.elapsed();
        // The 300 ms tool must be cut at ~50 ms, not awaited.
        assert!(
            elapsed < Duration::from_millis(250),
            "timeout must return early, elapsed={elapsed:?}"
        );
        let stuck_text = executed[0].outcome.as_ref().unwrap().content.clone();
        assert!(stuck_text.contains("工具执行超时"), "{stuck_text}");
        assert!(stuck_text.contains("stuck"), "{stuck_text}");
        // The sibling that finished in time still reports its normal result.
        assert_eq!(executed[1].outcome.as_ref().unwrap().content, "done:{}");

        let monitor = runtime.monitor();
        assert_eq!(monitor["totals"]["callCount"], 2);
        assert_eq!(monitor["totals"]["errorCount"], 1);
        assert_eq!(monitor["toolTimeoutSecs"], 0.05);
    }

    #[test]
    fn panicking_tool_becomes_an_isolated_error() {
        let mut runtime = AgentRuntime::new();
        runtime.registry_mut().register(Box::new(PanicTool {
            spec: ToolSpec {
                name: "panic_tool",
                description: "panics".into(),
                parameters: json!({}),
            },
        }));
        let db = memory_db();
        let ctx = test_ctx(&db);
        let executed = runtime.execute(&ctx, &[call("panic_tool")]);
        let text = executed[0].outcome.as_ref().unwrap().content.clone();
        assert!(text.contains("工具线程异常退出（panic）"), "{text}");
        assert_eq!(runtime.monitor()["totals"]["errorCount"], 1);
    }

    #[test]
    fn timeout_override_parses_and_falls_back() {
        assert_eq!(timeout_secs_from_raw(None), DEFAULT_TOOL_TIMEOUT_SECS);
        assert_eq!(timeout_secs_from_raw(Some(" 42 ")), 42);
        assert_eq!(timeout_secs_from_raw(Some("0")), DEFAULT_TOOL_TIMEOUT_SECS);
        assert_eq!(timeout_secs_from_raw(Some("-3")), DEFAULT_TOOL_TIMEOUT_SECS);
        assert_eq!(
            timeout_secs_from_raw(Some("abc")),
            DEFAULT_TOOL_TIMEOUT_SECS
        );
        assert_eq!(timeout_label(Duration::from_secs(180)), "180s");
    }
}

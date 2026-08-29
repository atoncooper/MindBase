//! AgentRuntime — concurrent tool execution with per-tool metrics and
//! sibling-isolated failures. Desktop counterpart of app/harness/runtime.py.
//!
//! Backend semantics preserved: one failing tool becomes a `工具执行失败: …`
//! result instead of killing its siblings, results normalize to
//! `{content, extras}`, and every call feeds the per-tool metrics map.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::json;

use super::registry::{ToolContext, ToolOutput};
use crate::llm_chat::ToolCallReq;

/// Per-tool rolling metrics, exposed via [`AgentRuntime::monitor`].
#[derive(Debug, Default, Clone)]
pub(crate) struct ToolMetrics {
    pub call_count: u64,
    pub error_count: u64,
    pub total_duration_ms: f64,
    pub last_error: Option<String>,
}

/// Registry plus rolling execution metrics.
#[derive(Default)]
pub(crate) struct AgentRuntime {
    registry: super::registry::ToolRegistry,
    metrics: Mutex<HashMap<String, ToolMetrics>>,
}

/// One executed call: request plus its isolated outcome.
pub(crate) struct ExecutedCall {
    pub call: ToolCallReq,
    /// Always `Ok` — execution errors are already degraded into
    /// `工具执行失败: …` text results by the isolation layer.
    pub outcome: Result<ToolOutput, String>,
}

impl AgentRuntime {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn registry_mut(&mut self) -> &mut super::registry::ToolRegistry {
        &mut self.registry
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

    /// Execute every call concurrently (scoped threads mirror the backend's
    /// gather over per-call tasks) and return outcomes in input order.
    /// Unknown tool names fail in-place like any other execution error.
    pub(crate) fn execute(
        &self,
        ctx: &ToolContext<'_>,
        calls: &[ToolCallReq],
    ) -> Vec<ExecutedCall> {
        if calls.is_empty() {
            return Vec::new();
        }

        let outputs: Vec<(f64, Result<ToolOutput, String>)> =
            std::thread::scope(|scope| {
                let handles: Vec<_> = calls
                    .iter()
                    .map(|call| {
                        scope.spawn(move || {
                            let started = Instant::now();
                            let outcome = match self.registry.get(&call.name) {
                                Some(tool) => tool.execute(ctx, &call.arguments),
                                None => Err(format!(
                                    "未知工具：{}（可用：{}）",
                                    call.name,
                                    self.registry.names().join(", ")
                                )),
                            };
                            ((started.elapsed().as_secs_f64() * 1000.0), outcome)
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().expect("tool thread panicked"))
                    .collect()
            });

        calls
            .iter()
            .zip(outputs)
            .map(|(call, (duration_ms, outcome))| {
                match &outcome {
                    Ok(_) => self.record(&call.name, duration_ms, None),
                    Err(error) => self.record(&call.name, duration_ms, Some(error)),
                }
                // Sibling isolation: an execution error degrades to plain text
                // so the remaining calls stay meaningful to the model.
                let isolated =
                    outcome.unwrap_or_else(|error| ToolOutput::text(format!("工具执行失败: {error}")));
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::registry::{LocalTool, ToolSpec};
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

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
        fn execute(&self, _ctx: &ToolContext<'_>, arguments: &str) -> Result<ToolOutput, String> {
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

    fn memory_db() -> crate::db::Db {
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("schema");
        crate::db::Db {
            conn: Mutex::new(conn),
            data_dir: Mutex::new(std::path::PathBuf::from(".")),
            default_dir: std::path::PathBuf::from("."),
        }
    }

    #[test]
    fn sibling_isolation_keeps_other_results_alive() {
        let mut runtime = AgentRuntime::new();
        runtime.registry_mut().register(scripted("ok_tool", false, 0));
        runtime.registry_mut().register(scripted("bad_tool", true, 0));

        let db = memory_db();
        let ctx = ToolContext {
            db: &db,
            embed_client: None,
            chat_client: None,
            session_id: "s",
            delegate: None,
        };
        let calls = vec![
            ToolCallReq {
                id: "1".into(),
                name: "bad_tool".into(),
                arguments: r#"{"x":"1"}"#.into(),
            },
            ToolCallReq {
                id: "2".into(),
                name: "ok_tool".into(),
                arguments: r#"{"x":"2"}"#.into(),
            },
        ];

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
        assert_eq!(executed[1].outcome.as_ref().unwrap().content, "done:{\"x\":\"2\"}");

        let monitor = runtime.monitor();
        assert_eq!(monitor["totals"]["callCount"], 2);
        assert_eq!(monitor["totals"]["errorCount"], 1);
    }

    #[test]
    fn unknown_tool_fails_in_place_with_available_names() {
        let mut runtime = AgentRuntime::new();
        runtime.registry_mut().register(scripted("known", false, 0));
        let db = memory_db();
        let ctx = ToolContext {
            db: &db,
            embed_client: None,
            chat_client: None,
            session_id: "s",
            delegate: None,
        };
        let executed = runtime.execute(
            &ctx,
            &[ToolCallReq {
                id: "9".into(),
                name: "nope".into(),
                arguments: "{}".into(),
            }],
        );
        let text = executed[0].outcome.as_ref().unwrap().content.clone();
        assert!(text.contains("未知工具：nope"));
        assert!(text.contains("known"));
    }

    #[test]
    fn concurrent_execution_overlaps_sleeps() {
        let mut runtime = AgentRuntime::new();
        runtime.registry_mut().register(scripted("slow_a", false, 120));
        runtime.registry_mut().register(scripted("slow_b", false, 120));

        let db = memory_db();
        let ctx = ToolContext {
            db: &db,
            embed_client: None,
            chat_client: None,
            session_id: "s",
            delegate: None,
        };
        let started = Instant::now();
        let executed = runtime.execute(
            &ctx,
            &[
                ToolCallReq { id: "a".into(), name: "slow_a".into(), arguments: "{}".into() },
                ToolCallReq { id: "b".into(), name: "slow_b".into(), arguments: "{}".into() },
            ],
        );
        assert_eq!(executed.len(), 2);
        // Two 120 ms sleeps run concurrently → well under their serial sum.
        assert!(
            started.elapsed() < std::time::Duration::from_millis(220),
            "calls must overlap"
        );
    }
}

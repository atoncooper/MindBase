//! usage_stats 工具：token 消耗统计的可读输出。

use mind_base_desktop_lib::TestHarness;

#[test]
fn usage_stats_reports_recorded_turns() {
    let h = TestHarness::new("agent-usage-stats");
    h.record_usage("chat-1", "deepseek-chat", 1000, 300, 600);
    let output = h.run_tool("chat", "usage_stats", "{}").expect("usage_stats");
    assert!(output.contains("总览：调用 1 次"), "missing totals: {output}");
    assert!(output.contains("deepseek-chat"), "missing model: {output}");
    assert!(output.contains("缓存命中 600"), "missing cached: {output}");
}

#[test]
fn usage_stats_is_empty_before_any_turn() {
    let h = TestHarness::new("agent-usage-empty");
    let output = h.run_tool("chat", "usage_stats", "{}").expect("usage_stats");
    assert!(output.contains("调用 0 次"), "unexpected: {output}");
}

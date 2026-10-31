//! infra::usage：token 账本与聚合统计（输入/输出/缓存/合计、按模型/会话/天）。

use mind_base_desktop_lib::TestHarness;

#[test]
fn usage_ledger_aggregates_totals_and_cache_hit_rate() {
    let h = TestHarness::new("infra-usage-totals");
    h.record_usage("chat-1", "deepseek-chat", 1000, 300, 600);
    h.record_usage("chat-1", "deepseek-chat", 500, 100, 200);
    h.record_usage("automation-7", "qwen-plus", 2000, 500, 0);
    let (calls, input, output, cached, total) = h.usage_totals(1);
    assert_eq!(calls, 3);
    assert_eq!(input, 3500);
    assert_eq!(output, 900);
    assert_eq!(cached, 800);
    assert_eq!(total, 4400);
}

#[test]
fn summary_lists_overall_models_sessions_and_days() {
    let h = TestHarness::new("infra-usage-summary");
    h.record_usage("chat-1", "deepseek-chat", 1000, 300, 600);
    h.record_usage("automation-7", "qwen-plus", 2000, 500, 0);
    let summary = h.usage_summary(1);
    assert!(summary.contains("总览：调用 2 次"), "missing totals: {summary}");
    assert!(summary.contains("缓存命中 600（20.0%）"), "missing cache rate: {summary}");
    assert!(summary.contains("deepseek-chat"), "missing model: {summary}");
    assert!(summary.contains("automation-7"), "missing automation session: {summary}");
    assert!(summary.contains("按天："), "missing daily: {summary}");
}

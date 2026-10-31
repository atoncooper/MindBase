//! 自定义 agent：create_agent / list_agents 工具与持久化。

use mind_base_desktop_lib::TestHarness;

#[test]
fn create_agent_persists_and_lists() {
    let h = TestHarness::new("agent-custom-create");
    let output = h
        .run_tool(
            "chat",
            "create_agent",
            "{\"name\":\"data-cleaner\",\"description\":\"清洗数据\",\"system_prompt\":\"你是数据清洗工程师，输出检查清单。\"}",
        )
        .expect("create_agent should succeed");
    assert!(output.contains("data-cleaner"), "missing agent name: {output}");
    assert_eq!(h.custom_agent_names(), vec!["data-cleaner".to_string()]);
    assert!(h
        .custom_agent_prompt("data-cleaner")
        .unwrap_or_default()
        .contains("数据清洗工程师"));

    let listed = h.run_tool("chat", "list_agents", "{}").expect("list_agents");
    assert!(listed.contains("data-cleaner"), "list missing custom agent: {listed}");
    assert!(listed.contains("academic"), "list missing builtins: {listed}");
}

#[test]
fn duplicate_name_updates_the_role_prompt() {
    let h = TestHarness::new("agent-custom-update");
    let first = "{\"name\":\"reviewer\",\"system_prompt\":\"你是代码审查员。\"}";
    let second = "{\"name\":\"reviewer\",\"system_prompt\":\"你是安全审查员，只报风险。\"}";
    h.run_tool("chat", "create_agent", first).expect("first create");
    h.run_tool("chat", "create_agent", second).expect("update create");
    assert_eq!(h.custom_agent_names(), vec!["reviewer".to_string()]);
    assert!(h
        .custom_agent_prompt("reviewer")
        .unwrap_or_default()
        .contains("安全审查员"));
}

#[test]
fn invalid_names_and_empty_prompts_are_rejected() {
    let h = TestHarness::new("agent-custom-invalid");
    let bad_name = h
        .run_tool(
            "chat",
            "create_agent",
            "{\"name\":\"Bad Name\",\"system_prompt\":\"x\"}",
        )
        .expect_err("bad name must fail");
    assert!(bad_name.contains("小写字母"), "unexpected: {bad_name}");

    let empty_prompt = h
        .run_tool("chat", "create_agent", "{\"name\":\"ok-name\",\"system_prompt\":\"  \"}")
        .expect_err("empty prompt must fail");
    assert!(empty_prompt.contains("system_prompt"), "unexpected: {empty_prompt}");
}

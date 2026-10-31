//! automation_* 工具适配层测试：启动 / 状态 / 日志检索 / 终止。

use std::time::Duration;

use mind_base_desktop_lib::TestHarness;

fn task_id_from(text: &str) -> i64 {
    text.split('#')
        .nth(1)
        .and_then(|rest| rest.split(|ch: char| !ch.is_ascii_digit()).next())
        .and_then(|digits| digits.parse::<i64>().ok())
        .expect("task id in output")
}

#[test]
fn automation_tools_are_gated_by_shell_switch() {
    let h = TestHarness::new("agent-automation-gate");
    let err = h
        .run_tool(
            "chat",
            "automation_start",
            "{\"name\":\"x\",\"command\":\"echo hi\"}",
        )
        .expect_err("automation_start must be gated");
    assert!(err.contains("命令执行已关闭"), "unexpected error: {err}");
}

#[test]
fn start_status_search_and_kill_flow() {
    let h = TestHarness::new("agent-automation-flow");
    h.set_shell_enabled(true);
    let started = h
        .run_tool(
            "chat",
            "automation_start",
            "{\"name\":\"agent-echo\",\"command\":\"echo agent-automation\",\"interval_secs\":60}",
        )
        .expect("automation_start should run");
    let task_id = task_id_from(&started);

    let mut status = String::new();
    let mut succeeded = false;
    for _ in 0..100 {
        status = h
            .run_tool("chat", "automation_status", &format!("{{\"task_id\":{task_id}}}"))
            .expect("automation_status");
        if status.contains("succeeded") {
            succeeded = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(succeeded, "task did not finish: {status}");
    assert!(status.contains("agent-automation"), "tail missing marker: {status}");

    let search = h
        .run_tool(
            "chat",
            "automation_log_search",
            &format!("{{\"task_id\":{task_id},\"query\":\"agent-automation\"}}"),
        )
        .expect("automation_log_search");
    assert!(search.contains("agent-automation"), "search missed: {search}");

    let list = h
        .run_tool("chat", "automation_list", "{}")
        .expect("automation_list");
    assert!(list.contains("agent-echo"), "list missing task: {list}");

    let killed = h
        .run_tool("chat", "automation_kill", &format!("{{\"task_id\":{task_id}}}"))
        .expect("automation_kill");
    assert!(killed.contains("已终止") || killed.contains("没有运行"));
}

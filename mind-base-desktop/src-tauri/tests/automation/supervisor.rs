//! automation::supervisor：启动 / 完成 / 失败 / 终止 / 状态包。

use std::time::Duration;

use mind_base_desktop_lib::testing::AutomationTestEnv;

fn echo_command() -> &'static str {
    "echo automation-ok"
}

fn sleep_command() -> &'static str {
    if cfg!(windows) {
        "Start-Sleep -Seconds 30"
    } else {
        "sleep 30"
    }
}

#[test]
fn short_task_succeeds_and_writes_partitioned_log() {
    let env = AutomationTestEnv::new("automation-ok");
    let task_id = env.start("echo", echo_command(), 600).expect("start");
    let state = env.wait_done(task_id, Duration::from_secs(20)).expect("wait");
    assert_eq!(state, "succeeded");
    let pack = env.context_pack(task_id).expect("pack");
    assert!(pack.get("tail").and_then(|v| v.as_str()).unwrap_or("").contains("automation-ok"));
    let paths = env.log_paths(task_id).expect("logs");
    assert!(paths.iter().any(|path| path.to_string_lossy().contains("_run-")));
    let hits = env.search_logs(task_id, "automation-ok", 10).expect("search");
    assert!(!hits.is_empty(), "log search should find the marker");
}

#[test]
fn failing_task_is_marked_failed_with_exit_code() {
    let env = AutomationTestEnv::new("automation-fail");
    let task_id = env.start("fail", "exit 3", 600).expect("start");
    let state = env.wait_done(task_id, Duration::from_secs(20)).expect("wait");
    assert_eq!(state, "failed");
    let pack = env.context_pack(task_id).expect("pack");
    assert_eq!(pack.get("last_exit_code").and_then(|v| v.as_i64()), Some(3));
}

#[test]
fn kill_marks_task_stopped() {
    let env = AutomationTestEnv::new("automation-kill");
    let task_id = env.start("sleep", sleep_command(), 600).expect("start");
    std::thread::sleep(Duration::from_millis(300));
    env.kill(task_id).expect("kill");
    let state = env.wait_done(task_id, Duration::from_secs(10)).expect("wait");
    assert_eq!(state, "stopped");
}

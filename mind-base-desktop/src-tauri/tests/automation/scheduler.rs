//! automation::scheduler：到期报告与去重。

use std::time::Duration;

use mind_base_desktop_lib::testing::AutomationTestEnv;

fn sleep_command() -> &'static str {
    if cfg!(windows) {
        "Start-Sleep -Seconds 30"
    } else {
        "sleep 30"
    }
}

#[test]
fn running_task_becomes_due_immediately_then_only_once() {
    let env = AutomationTestEnv::new("automation-due");
    let task_id = env.start("due", sleep_command(), 60).expect("start");
    assert!(
        env.due_reports().expect("due").iter().any(|item| item.task_id == task_id),
        "new running task should be due"
    );
    let recorded = env.record_due_reports().expect("record");
    assert!(recorded >= 1);
    assert!(
        !env.due_reports()
            .expect("due after record")
            .iter()
            .any(|item| item.task_id == task_id),
        "a scheduled report must not repeat immediately"
    );
    env.kill(task_id).expect("kill");
    let _ = env.wait_done(task_id, Duration::from_secs(10));
}

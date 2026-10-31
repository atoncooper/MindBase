//! toolkit::git 端到端测试（直接调用 toolkit 包 API，不涉及 agent/harness）。

use crate::common::{init_temp_repo, temp_dir};
use std::path::PathBuf;

use mind_base_desktop_lib::toolkit::git::{self, GitAction};
use serde_json::json;

fn logs_dir(tag: &str) -> PathBuf {
    let root = temp_dir(tag);
    let logs = root.join("logs");
    std::fs::create_dir_all(&logs).expect("logs");
    logs
}

#[test]
fn args_for_read_actions_are_stable() {
    assert_eq!(
        git::build_args(GitAction::Status, &json!({"action": "status"})).unwrap(),
        vec!["status", "--short", "--branch"]
    );
    assert_eq!(
        git::build_args(
            GitAction::Diff,
            &json!({"staged": true, "stat": true, "path": "src/lib.rs"}),
        )
        .unwrap(),
        vec!["diff", "--staged", "--stat", "--", "src/lib.rs"]
    );
    let args = git::build_args(GitAction::Log, &json!({"limit": 999})).unwrap();
    assert_eq!(args[0], "log");
    assert!(args.contains(&"200".to_string()), "limit clamps: {args:?}");
}

#[test]
fn write_actions_validate_required_inputs() {
    assert!(git::build_args(GitAction::Commit, &json!({})).is_err());
    assert!(git::build_args(GitAction::Add, &json!({})).is_err());
    assert_eq!(
        git::build_args(GitAction::Commit, &json!({"message": "feat: x"})).unwrap(),
        vec!["commit", "-m", "feat: x"]
    );
    assert_eq!(
        git::build_args(GitAction::Add, &json!({"all": true})).unwrap(),
        vec!["add", "-A"]
    );
}

#[test]
fn status_runs_on_a_real_temp_repo() {
    let parent = temp_dir("toolkit-git-status");
    let Some(repo) = init_temp_repo(&parent) else {
        eprintln!("git 不可用，跳过真实仓库用例");
        return;
    };
    let logs = logs_dir("toolkit-git-status-logs");
    let run = git::run(GitAction::Status, &json!({}), &repo, &logs).expect("git status should run");
    assert_eq!(run.capture.exit_code, Some(0), "bad exit: {}", run.command_line);
    let stdout = std::fs::read_to_string(&run.capture.stdout_path).unwrap_or_default();
    assert!(stdout.contains("a.txt"), "missing file: {stdout}");
    assert!(run.command_line.starts_with("git status"));
}

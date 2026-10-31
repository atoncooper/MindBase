//! toolkit::process 端到端测试（直接调用进程执行原语）。

use crate::common::temp_dir;
use std::path::PathBuf;
use std::time::Duration;

use mind_base_desktop_lib::toolkit::process;

fn echo_invocation() -> (&'static str, Vec<String>) {
    if cfg!(windows) {
        ("cmd", vec!["/C".to_string(), "echo toolkit-process".to_string()])
    } else {
        ("sh", vec!["-c".to_string(), "echo toolkit-process".to_string()])
    }
}

fn exit_code_invocation() -> (&'static str, Vec<String>) {
    if cfg!(windows) {
        ("cmd", vec!["/C".to_string(), "exit 3".to_string()])
    } else {
        ("sh", vec!["-c".to_string(), "exit 3".to_string()])
    }
}

fn env(tag: &str) -> (PathBuf, PathBuf) {
    let root = temp_dir(tag);
    let work = root.join("work");
    let logs = root.join("logs");
    std::fs::create_dir_all(&work).expect("work");
    std::fs::create_dir_all(&logs).expect("logs");
    (work, logs)
}

#[test]
fn captures_stdout_and_exit_code_to_files() {
    let (work, logs) = env("toolkit-process-echo");
    let (program, args) = echo_invocation();
    let capture = process::run_to_files(program, &args, &work, Duration::from_secs(30), &logs, "cli")
        .expect("process should run");
    assert_eq!(capture.exit_code, Some(0));
    assert_eq!(capture.status_text(), "退出码 0");
    let stdout = std::fs::read_to_string(&capture.stdout_path).unwrap_or_default();
    assert!(stdout.contains("toolkit-process"));
    assert!(capture.sections().contains("完整输出"));
}

#[test]
fn propagates_non_zero_exit_code() {
    let (work, logs) = env("toolkit-process-exit");
    let (program, args) = exit_code_invocation();
    let capture = process::run_to_files(program, &args, &work, Duration::from_secs(30), &logs, "cli")
        .expect("process should run");
    assert_eq!(capture.exit_code, Some(3));
    assert!(!capture.timed_out);
}

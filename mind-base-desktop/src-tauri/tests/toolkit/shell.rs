//! toolkit::shell 端到端测试（直接调用 toolkit 包 API，不涉及 agent/harness）。

use crate::common::{large_output_command, sleep_command, temp_dir};
use std::path::PathBuf;
use std::time::Duration;

use mind_base_desktop_lib::toolkit::shell::{self, NetworkMode, ShellKind};

struct Env {
    root: PathBuf,
    work: PathBuf,
    logs: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Self {
        let root = temp_dir(tag);
        let work = root.join("work");
        let logs = root.join("logs");
        std::fs::create_dir_all(&work).expect("work dir");
        std::fs::create_dir_all(&logs).expect("logs dir");
        Self { root, work, logs }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn shell_and_network_parsing() {
    assert_eq!(ShellKind::parse(None).unwrap(), ShellKind::platform_default());
    assert_eq!(ShellKind::parse(Some("powershell")).unwrap(), ShellKind::Pwsh);
    assert_eq!(ShellKind::parse(Some(" sh ")).unwrap(), ShellKind::Bash);
    assert!(ShellKind::parse(Some("zsh")).is_err());
    assert_eq!(NetworkMode::parse(None).unwrap(), NetworkMode::Inherit);
    assert_eq!(NetworkMode::parse(Some("off")).unwrap(), NetworkMode::Off);
    assert!(NetworkMode::parse(Some("airgap")).is_err());
    assert_eq!(shell::clamp_timeout(None), shell::DEFAULT_TIMEOUT_MS);
    assert_eq!(shell::clamp_timeout(Some(0)), shell::MIN_TIMEOUT_MS);
    assert_eq!(shell::clamp_timeout(Some(999_999)), shell::MAX_TIMEOUT_MS);
}

#[test]
fn invocation_shape_matches_platform() {
    #[cfg(windows)]
    {
        let (program, args) = shell::build_invocation(ShellKind::Pwsh, "Get-Date", NetworkMode::Inherit).unwrap();
        assert_eq!(program, "pwsh");
        assert_eq!(args.last().unwrap(), "Get-Date");
        let (program, args) = shell::build_invocation(ShellKind::Cmd, "dir", NetworkMode::Inherit).unwrap();
        assert_eq!(program, "cmd");
        assert_eq!(args, vec!["/C".to_string(), "dir".to_string()]);
        // Windows 没有用户态断网机制：显式报错而不是静默降级。
        assert!(shell::build_invocation(ShellKind::Pwsh, "dir", NetworkMode::Off).is_err());
    }
    #[cfg(not(windows))]
    {
        let (program, args) = shell::build_invocation(ShellKind::Bash, "echo hi", NetworkMode::Inherit).unwrap();
        assert_eq!(program, "bash");
        assert_eq!(args, vec!["-lc".to_string(), "echo hi".to_string()]);
        assert!(shell::build_invocation(ShellKind::Pwsh, "Get-Date", NetworkMode::Inherit).is_err());
    }
}

#[test]
fn echo_runs_and_output_lands_in_file() {
    let env = Env::new("toolkit-shell-echo");
    let capture = shell::run(
        "echo toolkit-shell",
        ShellKind::platform_default(),
        NetworkMode::Inherit,
        &env.work,
        Duration::from_secs(60),
        &env.logs,
        "shell",
    )
    .expect("shell should run");
    assert_eq!(capture.exit_code, Some(0));
    let stdout = std::fs::read_to_string(&capture.stdout_path).unwrap_or_default();
    assert!(stdout.contains("toolkit-shell"), "missing stdout: {stdout}");
    assert!(capture.sections().contains("完整输出"));
}

#[test]
fn large_output_is_written_to_file_and_summarized() {
    let env = Env::new("toolkit-shell-large");
    let capture = shell::run(
        large_output_command(),
        ShellKind::platform_default(),
        NetworkMode::Inherit,
        &env.work,
        Duration::from_secs(120),
        &env.logs,
        "shell",
    )
    .expect("large command should run");
    assert!(capture.stdout_bytes > 20 * 1024, "expected big log, got {}", capture.stdout_bytes);
    let summary = capture.sections();
    assert!(summary.len() < 16 * 1024, "summary too large: {}", summary.len());
    assert!(summary.contains("完整输出"));
}

#[test]
fn timeout_terminates_the_command() {
    let env = Env::new("toolkit-shell-timeout");
    let capture = shell::run(
        sleep_command(),
        ShellKind::platform_default(),
        NetworkMode::Inherit,
        &env.work,
        Duration::from_millis(1_000),
        &env.logs,
        "shell",
    )
    .expect("timeout is not an execution error");
    assert!(capture.timed_out);
    assert_eq!(capture.status_text(), "超时终止");
}

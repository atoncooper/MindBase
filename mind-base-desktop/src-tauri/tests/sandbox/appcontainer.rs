//! `sandbox` 包（OS 级沙箱原语）的端到端测试。
//!
//! 直接调用 `mind_base_desktop_lib::sandbox::{run, backend_name, ...}`，**不经过**
//! agent / harness / 工具注册表——这一层只验证操作系统隔离本身。
//! 工具适配层（run_sandboxed：配置开关、审计、输出摘要）在 `e2e_agent_tools.rs`。
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use mind_base_desktop_lib::sandbox::{self, SandboxNetwork, SandboxShell};

const TIMEOUT: Duration = Duration::from_secs(120);

/// 独立沙箱环境：临时根目录 + sandbox 工作区 + 执行日志目录。
struct SandboxEnv {
    root: PathBuf,
    work_dir: PathBuf,
    log_dir: PathBuf,
}

impl SandboxEnv {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("mb-sandbox-unit-{tag}-{}", std::process::id()));
        let work_dir = root.join("work");
        let log_dir = root.join("logs");
        std::fs::create_dir_all(&work_dir).expect("create sandbox work dir");
        std::fs::create_dir_all(&log_dir).expect("create log dir");
        Self { root, work_dir, log_dir }
    }

    fn run(&self, command: &str, shell: SandboxShell, network: SandboxNetwork) -> sandbox::SandboxOutput {
        sandbox::run(command, shell, &self.work_dir, TIMEOUT, network, &self.log_dir)
            .expect("sandboxed command should run")
    }

    fn read_stdout(&self, output: &sandbox::SandboxOutput) -> String {
        std::fs::read_to_string(&output.stdout_path).unwrap_or_default()
    }
}

impl Drop for SandboxEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn backend_is_appcontainer_on_windows() {
    assert_eq!(sandbox::backend_name(), "appcontainer");
}

#[test]
fn runs_powershell_inside_appcontainer() {
    let env = SandboxEnv::new("run");
    let output = env.run("Write-Output sandbox-ok", SandboxShell::Pwsh, SandboxNetwork::Off);
    assert_eq!(output.exit_code, Some(0));
    assert!(env.read_stdout(&output).contains("sandbox-ok"));
    assert!(output.stdout_bytes > 0);
}

#[test]
fn cannot_write_outside_the_sandbox() {
    let env = SandboxEnv::new("escape");
    let escape = std::env::temp_dir().join(format!("mb-sandbox-escape-{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&escape);
    let command = format!(
        "Set-Content -LiteralPath '{}' -Value escaped",
        escape.display().to_string().replace('\\', "\\\\")
    );
    // 命令可能以非 0 退出（访问被拒），这里只断言沙箱外没有文件落地。
    let _ = sandbox::run(&command, SandboxShell::Pwsh, &env.work_dir, TIMEOUT, SandboxNetwork::Off, &env.log_dir);
    assert!(!escape.exists(), "AppContainer 逃逸：文件被写到沙箱外");
}

#[test]
fn bash_is_rejected_on_windows_sandbox() {
    let env = SandboxEnv::new("bash");
    let err = sandbox::run("echo hi", SandboxShell::Bash, &env.work_dir, TIMEOUT, SandboxNetwork::Off, &env.log_dir)
        .expect_err("bash must be rejected");
    assert!(err.contains("不支持 bash"), "unexpected error: {err}");
}

#[test]
fn invalid_network_mode_is_rejected() {
    assert!(SandboxNetwork::parse(Some("airgap")).is_err());
    assert!(SandboxShell::parse(Some("zsh")).is_err());
}

#[test]
fn large_output_is_written_to_file() {
    let env = SandboxEnv::new("large");
    let output = env.run(
        "1..4000 | ForEach-Object { 'sandbox-line-' + $_ }",
        SandboxShell::Pwsh,
        SandboxNetwork::Off,
    );
    assert!(output.stdout_bytes > 20 * 1024, "expected full output on disk, got {} bytes", output.stdout_bytes);
    let stdout = env.read_stdout(&output);
    assert!(stdout.contains("sandbox-line-1"));
    assert!(Path::new(&output.stderr_path).exists());
}

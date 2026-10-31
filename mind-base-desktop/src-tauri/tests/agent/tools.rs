//! agent 工具适配层集成测试（会初始化 harness / 工具注册表）。
//!
//! 只验证「agent 层契约」：配置开关、工具注册、输出摘要格式。
//! 命令执行 / git / gh 的纯实现由 e2e_toolkit_* 直接测，不依赖本层。

use crate::common::{command_json, init_temp_repo};
use mind_base_desktop_lib::TestHarness;

fn disabled_error(harness: &TestHarness, tool: &str, arguments: &str) -> String {
    harness
        .run_tool("chat", tool, arguments)
        .expect_err("tool must be gated while shell execution is disabled")
}

#[test]
fn command_family_tools_are_gated_by_shell_switch() {
    let h = TestHarness::new("agent-gate");
    for (tool, arguments) in [
        ("run_command", command_json("echo hi")),
        ("git", "{\"action\":\"status\"}".to_string()),
        ("gh", "{\"action\":\"auth_status\"}".to_string()),
        ("run_sandboxed", command_json("Write-Output hi")),
    ] {
        let err = disabled_error(&h, tool, &arguments);
        assert!(err.contains("命令执行已关闭"), "{tool}: unexpected error: {err}");
    }
}

#[test]
fn run_command_reports_output_summary() {
    let h = TestHarness::new("agent-run-command");
    h.set_shell_enabled(true);
    let output = h
        .run_tool("chat", "run_command", &command_json("echo agent-e2e"))
        .expect("run_command should run");
    assert!(output.contains("agent-e2e"), "missing stdout: {output}");
    assert!(output.contains("完整输出"), "log path missing: {output}");
}

#[test]
fn git_tool_runs_on_a_real_repo() {
    let h = TestHarness::new("agent-git");
    let Some(repo) = init_temp_repo(h.data_dir()) else {
        eprintln!("git 不可用，跳过真实仓库用例");
        return;
    };
    let arguments = serde_json::json!({
        "action": "status",
        "repo": repo.to_string_lossy(),
    })
    .to_string();
    h.set_shell_enabled(true);
    let output = h.run_tool("chat", "git", &arguments).expect("git should run");
    assert!(output.contains("退出码 0"), "bad status: {output}");
    assert!(output.contains("a.txt"), "missing file: {output}");
}

#[cfg(windows)]
#[test]
fn sandbox_tool_reports_backend_and_log_path() {
    let h = TestHarness::new("agent-sandbox");
    h.set_shell_enabled(true);
    let output = h
        .run_tool("chat", "run_sandboxed", &command_json("Write-Output sandbox-ok"))
        .expect("run_sandboxed should run");
    assert!(output.contains("sandbox-ok"), "missing stdout: {output}");
    assert!(output.contains("backend=appcontainer"), "wrong backend: {output}");
    assert!(output.contains("完整输出"), "log path missing: {output}");
}

#[test]
fn command_family_tools_are_registered() {
    let h = TestHarness::new("agent-registry");
    let names = h.registered_tools();
    for expected in ["run_command", "git", "gh", "run_sandboxed", "read_file"] {
        assert!(
            names.iter().any(|name| name == expected),
            "tool {expected} missing from registry"
        );
    }
}

#[test]
fn cwd_outside_data_dir_is_rejected() {
    let h = TestHarness::new("agent-cwd");
    h.set_shell_enabled(true);
    let err = h
        .run_tool(
            "chat",
            "run_command",
            "{\"command\":\"echo hi\",\"cwd\":\"../..\"}",
        )
        .expect_err("cwd escape must be rejected");
    assert!(err.contains("路径越界"), "unexpected error: {err}");
}

#[test]
fn read_file_pages_large_logs_with_offset_and_limit() {
    let h = TestHarness::new("agent-paging");
    h.set_shell_enabled(true);
    h.run_tool("chat", "run_command", &command_json(crate::common::large_output_command()))
        .expect("command should run");
    let log = std::fs::read_dir(h.exec_log_dir())
        .expect("exec log dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().ends_with(".out.log"))
                .unwrap_or(false)
        })
        .expect("stdout log file");
    let arguments = serde_json::json!({
        "path": log.to_string_lossy(),
        "offset": 0,
        "limit": 200,
    })
    .to_string();
    let paged = h.run_tool("chat", "read_file", &arguments).expect("paged read");
    assert!(paged.contains("offset=0"), "header missing: {paged}");
    assert!(paged.contains("line-1"), "content missing: {paged}");
}

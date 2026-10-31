//! tests/ 共享辅助（Rust 集成测试约定：子目录文件通过 mod common; 引入）。
//!
//! 注意：本文件**不引用 agent/harness**。非 agent 测试（toolkit / sandbox）直接用这里
//! 的临时目录与命令工具；需要 harness 的 agent 层测试自行 use TestHarness。

#![allow(dead_code)] // 各测试 crate 只用到其中一部分 helper

use std::path::{Path, PathBuf};

/// 新建一个临时测试目录（调用方负责删除，或依赖 std::env::temp_dir 清理）。
pub fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mindbase-e2e-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// run_command / run_sandboxed 的 {"command": ...} 参数（仅 agent 工具测试用）。
pub fn command_json(command: &str) -> String {
    format!("{{\"command\":{}}}", serde_json::to_string(command).expect("json"))
}

/// 产生大量 stdout 的平台相关命令（用于「输出落文件」断言）。
pub fn large_output_command() -> &'static str {
    if cfg!(windows) {
        "1..4000 | ForEach-Object { 'line-' + $_ }"
    } else {
        "for i in $(seq 1 4000); do echo line-$i; done"
    }
}

/// 会阻塞数秒的命令（超时用例）。
pub fn sleep_command() -> &'static str {
    if cfg!(windows) {
        "Start-Sleep -Seconds 5"
    } else {
        "sleep 5"
    }
}

/// 在指定父目录下创建一个真实临时 git 仓库并返回路径（git 不可用时返回 None）。
pub fn init_temp_repo(parent: &Path) -> Option<PathBuf> {
    let repo = parent.join("repo");
    std::fs::create_dir_all(&repo).ok()?;
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status();
    match status {
        Ok(code) if code.success() => {
            std::fs::write(repo.join("a.txt"), "hello").ok()?;
            Some(repo)
        }
        _ => None,
    }
}

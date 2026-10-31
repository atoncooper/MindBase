//! 长时自动化任务（AI 监督型）。
//!
//! 定位：由 AI 发起、可能运行数分钟到上百小时的本机任务（训练、构建、批处理）。
//!
//! 设计要点（见 docs/automation.md）：
//! - 日志正文只落文件系统，按 任务 / 日期 / run 分区；
//! - 数据库只存任务 / 运行 / 日志段指针 / 报告（不存正文）；
//! - supervisor 负责托管进程、退出检测、重试与 stale 恢复；
//! - report 负责给 AI 生成 **有界** 上下文包（状态 + 尾部若干行 + 日志指针）；
//! - scheduler 决定「何时该叫 AI」，而不是让模型轮询。
//!
//! 依赖方向：本包不依赖 agent，可被工具层 / Tauri 命令 / 后台线程复用。

pub mod log_index;
pub mod report;
pub mod scheduler;
pub mod store;
pub mod supervisor;

use std::time::{SystemTime, UNIX_EPOCH};

/// 当前 Unix 秒（DB 时间戳统一用 UTC 秒）。
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

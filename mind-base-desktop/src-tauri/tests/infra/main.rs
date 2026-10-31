//! infra 包集成测试：执行日志（摘要/分页/配额）与配置持久化。
//!
//! 通过 testing 包装访问 pub(crate) 实现，不涉及 agent/harness。

#[path = "../common/mod.rs"]
mod common;

mod config;
mod exec_log;
mod usage;

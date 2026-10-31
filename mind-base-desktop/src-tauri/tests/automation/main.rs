//! automation 包集成测试：日志分区 / 进程托管 / 报告节奏。
//!
//! 通过 testing::AutomationTestEnv（内存库 + 临时目录）直接驱动 automation 包，
//! 不初始化 agent/harness。

#[path = "../common/mod.rs"]
mod common;

mod log_index;
mod scheduler;
mod supervisor;

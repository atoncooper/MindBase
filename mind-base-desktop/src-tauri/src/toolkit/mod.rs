//! 通用工具执行层（与 agent 无关）。
//!
//! 这里放「本机命令执行 / git / gh」的**纯实现**：参数构造、子进程执行、输出落文件、
//! 超时杀进程树、审计写入。agent 包里的 `agent::harness::tools::{shell,git,gh}` 只做
//! `LocalTool` 适配（JSON 解析、配置开关、ToolContext 字段提取、结果格式化）。
//!
//! 依赖方向：`agent → toolkit → infra`；`toolkit` 不依赖 agent，因此其测试可以直接
//! 调用本包 API，不需要 `TestHarness`。

pub mod gh;
pub mod git;
pub mod process;
pub mod shell;

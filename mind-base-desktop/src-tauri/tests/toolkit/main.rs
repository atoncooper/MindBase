//! toolkit 包（process / shell / git / gh）集成测试。
//!
//! Cargo 会把 tests/toolkit/main.rs 编译为独立的测试 crate；各子模块是它的 mod。

#[path = "../common/mod.rs"]
mod common;

mod git;
mod gh;
mod process;
mod shell;

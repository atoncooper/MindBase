//! Local infrastructure layer.
//!
//! Nothing here knows about agents, UI domains or HTTP APIs: these are the
//! primitives every other package builds on.
//!
//! - [`db`] — SQLite connection, schema/migrations and the data-directory
//!   relocation protocol.
//! - [`config`] — user-facing settings persisted in SQLite.
//! - [`logging`] — rotating file logger under the data directory.
//! - [`store`] — conversation/turn artifacts on disk (index, spans, errors).
//! - [`python_runtime`] — embedded Python provisioning for local sidecars.
//! - [`updater`] — signed self-update (check, download, install).

pub(crate) mod command_guard;
pub(crate) mod config;
pub(crate) mod db;
pub(crate) mod exec_log;
pub(crate) mod usage;
pub(crate) mod logging;
pub(crate) mod python_runtime;
pub(crate) mod secret;
pub(crate) mod ssh;
pub(crate) mod store;
pub(crate) mod updater;

// SSH 远程执行的 Tauri 命令与载荷（在 app/commands.rs 统一注册）。
#[allow(unused_imports)] // 注册前暂时未被引用（Lead 在 app/commands.rs 统一注册）
pub use ssh::{
    ssh_connect, ssh_disconnect, ssh_host_forget_fingerprint, ssh_host_test,
    ssh_host_trust_fingerprint, ssh_hosts_list, ssh_hosts_save, ssh_resize, ssh_sessions_list,
    ssh_write, SshClosedPayload, SshExecResult, SshHostConfig, SshOutputPayload, SshSessionInfo,
    SshTestReport,
};
// generate_handler! 通过模块路径解析命令宏；随命令一起再导出。
#[allow(unused_imports)]
pub use ssh::{
    __cmd__ssh_connect, __cmd__ssh_disconnect, __cmd__ssh_host_forget_fingerprint,
    __cmd__ssh_host_test, __cmd__ssh_host_trust_fingerprint, __cmd__ssh_hosts_list,
    __cmd__ssh_hosts_save, __cmd__ssh_resize, __cmd__ssh_sessions_list, __cmd__ssh_write,
    __tauri_command_name_ssh_connect, __tauri_command_name_ssh_disconnect,
    __tauri_command_name_ssh_host_forget_fingerprint, __tauri_command_name_ssh_host_test,
    __tauri_command_name_ssh_host_trust_fingerprint, __tauri_command_name_ssh_hosts_list,
    __tauri_command_name_ssh_hosts_save, __tauri_command_name_ssh_resize,
    __tauri_command_name_ssh_sessions_list, __tauri_command_name_ssh_write,
};

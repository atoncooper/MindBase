//! SSH 远程执行（纯 Rust，基于 russh）子包门面。
//!
//! 能力边界（与拆分前一致）：
//! - 认证：密码（authenticate_password）或私钥（decode_secret_key +
//!   authenticate_publickey，支持带口令的私钥与 RSA 的 sha2 协商）。
//! - 执行：打开 session channel -> exec 一条命令 -> 收集 stdout / stderr /
//!   ExitStatus，整段用 tokio::time::timeout 包裹。
//! - 主机指纹：自定义 client::Handler 在 check_server_key 里记录 SHA256 指纹；
//!   交互路径（ssh_host_test / ssh_connect）首次连接 TOFU 信任并写回配置，
//!   之后指纹不一致直接拒绝；Agent 一次性路径要求指纹已固定，未固定不执行。
//! - 凭据：password / passphrase 落盘前写入跨平台系统凭据库（keyring 4：
//!   Windows Credential Manager / macOS Keychain / Linux Secret Service，经
//!   infra::secret），认证时读取；Windows 历史 DPAPI 密文仍可解密并自动迁移。
//!   日志与 UI 均不打印凭据。secret 保持独立 infra 模块（不并入本包），避免
//!   config -> ssh -> config 的循环依赖。
//!
//! 线程模型：工具层是同步的，所以除了 async 的 exec() 还提供
//! exec_blocking()（内部 new_current_thread runtime + block_on）。
//!
//! 模块布局：
//! - types：对外类型与常量；
//! - client：russh 认证与连接；
//! - fingerprint：主机指纹策略（TOFU / 固定后拒绝变化）；
//! - hosts：远程服务器配置命令（凭据加解密、信任/清除指纹）；
//! - exec：一次性远程执行；
//! - test：连通性测试命令；
//! - session：交互式 PTY 会话与事件流；
//! - sftp：SFTP 文件传输（复用会话 Handle 开 sftp subsystem）；
//! - forward：本地端口转发（仅 local forward）；
//! - log：交互会话输出日志（<data_dir>/logs/ssh/<host>-<stamp>.log）。
//!
//! Tauri 命令（在 app/commands.rs 统一注册）：
//! - ssh_hosts_list / ssh_hosts_save：读取（解密）/ 保存（加密）远程服务器；
//! - ssh_host_test：按名称连接并执行 echo ok，返回连通性 + 指纹策略结果；
//! - ssh_host_trust_fingerprint / ssh_host_forget_fingerprint：手动信任 / 清除指纹；
//! - ssh_connect / ssh_write / ssh_resize / ssh_disconnect / ssh_sessions_list：
//!   交互式 PTY 终端会话（事件 ssh-output / ssh-closed；SshSessionInfo.logPath 可回传）；
//! - sftp_list / sftp_download / sftp_upload / sftp_mkdir / sftp_delete：SFTP 文件传输；
//! - ssh_forward_add / ssh_forward_remove / ssh_forward_list：本地端口转发（仅 local）。

mod client;
mod exec;
mod fingerprint;
mod forward;
mod hosts;
mod log;
mod session;
mod sftp;
mod test;
mod types;

// 供 infra 与其他包通过 ssh:: 路径引用同一份主机配置类型。
pub use crate::infra::config::SshHostConfig;

// exec / MIN_TIMEOUT_SECS / MAX_TIMEOUT_SECS 保留旧 ssh:: 路径的公共接口；
// crate 内目前只用到 clamp_timeout / exec_blocking，其余暂无调用方。
#[allow(unused_imports)]
pub use exec::{clamp_timeout, exec, exec_blocking};
pub use hosts::{
    ssh_host_forget_fingerprint, ssh_host_trust_fingerprint, ssh_hosts_list, ssh_hosts_save,
};
pub use session::{ssh_connect, ssh_disconnect, ssh_resize, ssh_sessions_list, ssh_write};
pub use test::ssh_host_test;
// 以下命令由 Lead 在 app/commands.rs 注册；注册前暂无 crate 内调用方。
#[allow(unused_imports)]
pub use forward::{ssh_forward_add, ssh_forward_list, ssh_forward_remove};
#[allow(unused_imports)]
pub use sftp::{sftp_delete, sftp_download, sftp_list, sftp_mkdir, sftp_upload};
#[allow(unused_imports)]
pub use types::{
    SshClosedPayload, SshExecResult, SshOutputPayload, SshSessionInfo, SshTestReport,
    DEFAULT_TIMEOUT_SECS, MAX_TIMEOUT_SECS, MIN_TIMEOUT_SECS,
};

// generate_handler! 通过模块路径解析命令宏；随命令一起再导出（与拆分前一致）。
pub use hosts::{
    __cmd__ssh_host_forget_fingerprint, __cmd__ssh_host_trust_fingerprint,
    __cmd__ssh_hosts_list, __cmd__ssh_hosts_save, __tauri_command_name_ssh_host_forget_fingerprint,
    __tauri_command_name_ssh_host_trust_fingerprint, __tauri_command_name_ssh_hosts_list,
    __tauri_command_name_ssh_hosts_save,
};
pub use session::{
    __cmd__ssh_connect, __cmd__ssh_disconnect, __cmd__ssh_resize, __cmd__ssh_sessions_list,
    __cmd__ssh_write, __tauri_command_name_ssh_connect, __tauri_command_name_ssh_disconnect,
    __tauri_command_name_ssh_resize, __tauri_command_name_ssh_sessions_list,
    __tauri_command_name_ssh_write,
};
pub use test::{__cmd__ssh_host_test, __tauri_command_name_ssh_host_test};
#[allow(unused_imports)]
pub use forward::{
    __cmd__ssh_forward_add, __cmd__ssh_forward_list, __cmd__ssh_forward_remove,
    __tauri_command_name_ssh_forward_add, __tauri_command_name_ssh_forward_list,
    __tauri_command_name_ssh_forward_remove,
};
#[allow(unused_imports)]
pub use sftp::{
    __cmd__sftp_delete, __cmd__sftp_download, __cmd__sftp_list, __cmd__sftp_mkdir,
    __cmd__sftp_upload, __tauri_command_name_sftp_delete, __tauri_command_name_sftp_download,
    __tauri_command_name_sftp_list, __tauri_command_name_sftp_mkdir,
    __tauri_command_name_sftp_upload,
};

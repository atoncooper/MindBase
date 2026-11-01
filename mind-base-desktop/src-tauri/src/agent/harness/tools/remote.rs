//! remote_exec 工具：在用户已配置的 SSH 远程服务器上执行命令。
//!
//! 与 run_command / run_sandboxed 的关系：本机命令走那两个工具；跨机器操作走
//! 这里。连接 / 认证 / 超时全部由 infra::ssh（russh）负责，本文件只做
//! LocalTool 适配：参数解析、主机选择、危险命令黑名单校验、输出截断与审计。
//!
//! 安全：
//! - 只允许操作「已授权 Agent（allowAgent）+ 已固定主机指纹 + 绑定项目匹配」的
//!   服务器；任一条件不满足都在本地拒绝，远端收不到任何命令；
//! - action=hosts 绝不返回密码 / 私钥内容（只返回元数据）；
//! - action=run 在执行前对「最终命令」调用 infra::command_guard::check，
//!   命中即返回中文错误，远端不会收到这条命令；
//! - action=upload 的 local_path 经 workspace::research::files 校验，必须落在
//!   项目目录内；文件 ≤2MB，以 base64 经 SSH 写入远端；
//! - stdout / stderr 各截断 8KB，避免大输出塞爆上下文；
//! - 凭据由「系统设置 → 远程服务器」管理，工具描述明确要求不要向用户索要密码。

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::infra::command_guard;
use crate::infra::config::{self, SshHostConfig};
use crate::infra::ssh;
use crate::toolkit::process;
use crate::workspace::research::{project_root as research_project_root, resolve_path as research_resolve_path};

use super::cli;
use super::common::{now_secs_helper, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

/// stdout / stderr 各自的展示上限。
const MAX_SECTION_BYTES: usize = 8 * 1024;
/// 单条远程命令的字符上限（与本机 run_command 对齐）。
const MAX_COMMAND_BYTES: usize = 16 * 1024;
/// upload 单个文件上限（2 MB：base64 后约 2.7MB，仍是一次 exec 的合理范围）。
const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = ssh::DEFAULT_TIMEOUT_SECS;

pub(crate) struct RemoteExecTool;

static SPEC_REMOTE_EXEC: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "remote_exec",
        "在用户已配置的远程服务器上通过 SSH 执行命令（纯 Rust 客户端，支持密码 / 私钥认证）。\
         安全前提（务必遵守）：远程服务器由用户在「系统设置 → 远程服务器」配置；只有「允许 Agent 使用」\
         且已固定主机指纹的服务器可被 Agent 使用；若服务器绑定了科研项目（绑定项目非空），调用时\
         必须传 project_id=当前项目 id 且与绑定值一致，否则会被拒绝。不要向用户索要密码或私钥内容。\
         先用 action=hosts 查看可用主机（返回名称 / 地址 / 用户名 / 认证方式 / 默认目录 / 绑定项目 /\
         allowAgent / 指纹状态，绝不返回密码）。\
         action=run：host=主机名称（必填）、command=远端命令（必填）、project_id=当前科研项目 id\
         （建议总是传；服务器绑定项目时必须一致）、cwd=可选工作目录、timeout_secs=超时（默认 120，1–600）。\
         action=upload：host、project_id、local_path、remote_path 必填；local_path 是当前项目目录内的\
         相对路径（如 analysis/scripts/run.py，不能越出项目目录），文件 ≤2MB，会以 base64 经 SSH\
         写到远端 remote_path（含文件名，如 /srv/app/run.py）。需要跑项目代码时，先 upload 再 run。\
         命令在执行前会经过危险命令黑名单校验（rm -rf /、mkfs、dd 覆盖磁盘、shutdown / reboot 等会被拒绝），\
         命中时返回中文错误——这是安全策略，不要尝试绕过或拆分命令规避。\
         远端命令为非交互执行，不能读取用户输入；stdout / stderr 各截断 8KB。\
         连接失败、认证失败、超时、指纹不匹配、未授权 / 未绑定项目都会返回中文错误。",
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["hosts", "run", "upload"],
                    "description": "hosts=列出已配置的远程服务器；run=在指定主机执行命令；upload=上传项目内文件到远端"
                },
                "host": {
                    "type": "string",
                    "description": "run/upload：远程服务器名称（action=hosts 返回的 name，不是 IP）"
                },
                "command": {
                    "type": "string",
                    "description": "run：在远端执行的命令（非交互；危险命令会被黑名单拒绝）"
                },
                "project_id": {
                    "type": "string",
                    "description": "run/upload：当前科研项目 id；服务器绑定项目时必须与该绑定一致（upload 必填）"
                },
                "local_path": {
                    "type": "string",
                    "description": "upload：当前项目目录内的相对路径（如 analysis/scripts/run.py；不能越出项目目录）"
                },
                "remote_path": {
                    "type": "string",
                    "description": "upload：远端目标文件路径（含文件名，如 /srv/app/run.py）"
                },
                "cwd": {
                    "type": "string",
                    "description": "run：可选工作目录；省略时使用该主机的默认目录（若设置了的话）"
                },
                "timeout_secs": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 600,
                    "description": "run/upload：执行超时（秒，默认 120）"
                }
            }
        }),
    )
});

/// POSIX shell 单引号转义：用单引号包住，内部单引号写成 单引号+反斜杠+单引号+单引号。
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 需要切换工作目录时把 cd 拼到命令前面。
fn build_command(command: &str, cwd: Option<&str>) -> String {
    match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(dir) => format!("cd {} && {}", shell_quote(dir), command),
        None => command.to_string(),
    }
}

/// 截断一段输出到 8KB（按 UTF-8 字符边界安全截断）。
fn truncate_section(text: &str) -> (String, bool) {
    if text.len() <= MAX_SECTION_BYTES {
        return (text.to_string(), false);
    }
    let mut end = MAX_SECTION_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (
        format!(
            "{}\n…[已截断：原始 {} 字节，仅显示前 8KB]",
            &text[..end],
            text.len()
        ),
        true,
    )
}

/// Agent 使用主机的前置校验：必须已授权 + 已固定指纹 + 绑定项目匹配。
fn check_agent_usage(host: &SshHostConfig, project_id: Option<&str>) -> Result<(), String> {
    if !host.allow_agent {
        return Err(format!(
            "远程服务器 {} 未授权 Agent 使用：请让用户在「系统设置 → 远程服务器」勾选「允许 Agent 使用」后再试",
            host.name
        ));
    }
    if host.fingerprint.trim().is_empty() {
        return Err(format!(
            "远程服务器 {} 尚未固定主机指纹：请先在「系统设置 → 远程服务器」对该主机执行一次「测试连接」以信任指纹",
            host.name
        ));
    }
    if let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) {
        let bound = host.project_id.trim();
        if bound != project_id {
            return Err(format!(
                "远程服务器 {} 未绑定到当前项目（绑定项目：{}）：Agent 只能使用绑定到本项目的服务器",
                host.name,
                if bound.is_empty() { "未绑定" } else { bound }
            ));
        }
    }
    Ok(())
}

/// 按名称找主机（错误提示带上可用主机列表）。
fn find_host(hosts: &[SshHostConfig], host_name: &str) -> Result<SshHostConfig, String> {
    hosts
        .iter()
        .find(|host| host.name == host_name)
        .cloned()
        .ok_or_else(|| {
            let names = hosts
                .iter()
                .map(|host| host.name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            if names.is_empty() {
                "尚未配置远程服务器：请让用户在「系统设置 → 远程服务器」中添加".to_string()
            } else {
                format!("未找到名为 {host_name:?} 的远程服务器；可用主机：{names}")
            }
        })
}

/// 解析 upload 的本地文件：必须位于 <data_dir>/research/<project_id> 内，≤2MB。
fn resolve_upload_source(
    data_dir: &Path,
    project_id: &str,
    local_path: &str,
) -> Result<(PathBuf, u64), String> {
    let root = research_project_root(data_dir, project_id)?;
    let file = research_resolve_path(&root, local_path)?;
    let metadata =
        std::fs::metadata(&file).map_err(|err| format!("读取本地文件失败：{err}"))?;
    if !metadata.is_file() {
        return Err(format!("本地文件不存在或不是普通文件：{local_path}"));
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "文件过大（上限 2 MB，当前 {} KB）：请改用更小的脚本/数据文件",
            (metadata.len() + 1023) / 1024
        ));
    }
    Ok((file, metadata.len()))
}

/// 生成上传命令：mkdir -p 远端目录 + base64 解码写入目标文件。
///
/// base64 解码兼容 GNU（\`base64 -d\`）、BSD/macOS（\`base64 -D\`）与 openssl
/// 三种实现，避免旧命令只能在 GNU 环境使用；路径/数据仍做 POSIX 单引号转义。
fn build_upload_command(remote_path: &str, base64_data: &str) -> Result<String, String> {
    let remote = remote_path.trim();
    if remote.is_empty() {
        return Err("upload 缺少 remote_path：远端目标文件路径不能为空".to_string());
    }
    if remote.ends_with('/') {
        return Err("remote_path 必须包含文件名（不能以 / 结尾）".to_string());
    }
    let dir = match remote.rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() => dir,
        Some(_) => "/",
        None => ".",
    };
    Ok(format!(
        "mkdir -p {} && printf %s {} | (base64 -d 2>/dev/null || base64 -D 2>/dev/null || openssl base64 -d) > {}",
        shell_quote(dir),
        shell_quote(base64_data),
        shell_quote(remote)
    ))
}

/// 只含元数据的主机清单（绝不包含 password / passphrase / keyPath）。
fn format_hosts(hosts: &[SshHostConfig]) -> String {
    if hosts.is_empty() {
        return "尚未配置远程服务器。请让用户在「系统设置 → 远程服务器」中添加主机\
                （名称 / 地址 / 端口 / 用户名 / 认证方式），保存后重新调用本工具（action=hosts）。\
                不要向用户索要密码或私钥内容。"
            .to_string();
    }
    let mut lines = vec![format!(
        "已配置 {} 台远程服务器（仅元数据，凭据由设置页管理）：",
        hosts.len()
    )];
    for (index, host) in hosts.iter().enumerate() {
        let remote_dir = if host.remote_dir.trim().is_empty() {
            "（未设置）".to_string()
        } else {
            host.remote_dir.trim().to_string()
        };
        let binding = if host.project_id.trim().is_empty() {
            "未绑定".to_string()
        } else {
            host.project_id.trim().to_string()
        };
        let agent = if host.allow_agent { "是" } else { "否" };
        let fingerprint = if host.fingerprint.trim().is_empty() {
            "未固定（Agent 不可用，请先「测试连接」信任指纹）"
        } else {
            "已固定"
        };
        lines.push(format!(
            "{}. {} · {}@{}:{} · auth={} · 默认目录={} · 绑定项目={} · allowAgent={} · 指纹={}",
            index + 1,
            host.name,
            host.username,
            host.host,
            host.port,
            host.auth,
            remote_dir,
            binding,
            agent,
            fingerprint
        ));
    }
    lines.push(
        "用法：action=run，host=<上面的名称>，project_id=<当前科研项目 id>，command=<要执行的命令>；\
         需要把项目里的脚本/文件放到远端时用 action=upload（local_path 为项目内相对路径）。"
            .to_string(),
    );
    lines.join("\n")
}

fn load_hosts(ctx: &ToolContext) -> Result<Vec<SshHostConfig>, String> {
    let conn = ctx
        .db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    Ok(config::load(&conn)?.ssh_hosts)
}

impl LocalTool for RemoteExecTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_REMOTE_EXEC
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let data_dir = cli::data_dir(ctx)?;
        let hosts = load_hosts(ctx)?;

        match action.as_str() {
            "hosts" => Ok(ToolOutput::text(format_hosts(&hosts))),
            "run" => {
                let host_name = value
                    .get("host")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                if host_name.is_empty() {
                    return Err("run 缺少 host：请先用 action=hosts 查看可用主机名称".to_string());
                }
                let command = value
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string();
                if command.is_empty() {
                    return Err("run 缺少 command：要执行的远端命令不能为空".to_string());
                }
                if command.len() > MAX_COMMAND_BYTES {
                    return Err(format!(
                        "远程命令过长（{} 字节，上限 {MAX_COMMAND_BYTES}）；请把脚本写到远端文件后再执行",
                        command.len()
                    ));
                }
                let host = find_host(&hosts, host_name)?;
                let project_id = value
                    .get("project_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                // 授权 / 指纹 / 项目绑定三重校验：不满足时远端收不到任何命令。
                check_agent_usage(&host, project_id.as_deref())?;

                let cwd = value
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        let dir = host.remote_dir.trim();
                        if dir.is_empty() {
                            None
                        } else {
                            Some(dir.to_string())
                        }
                    });
                let timeout_secs = value
                    .get("timeout_secs")
                    .and_then(Value::as_u64)
                    .map(ssh::clamp_timeout)
                    .unwrap_or_else(|| ssh::clamp_timeout(DEFAULT_TIMEOUT_SECS));
                let effective_command = build_command(&command, cwd.as_deref());

                // 危险命令黑名单：校验最终命令（含 cd 前缀），命中直接拒绝，远端不会收到。
                command_guard::check(&data_dir, &effective_command)?;

                let result = ssh::exec_blocking(&host, &effective_command, timeout_secs)?;
                process::write_audit(
                    &data_dir,
                    &json!({
                        "ts": now_secs_helper(),
                        "tool": "remote_exec",
                        "agent": ctx.agent.name(),
                        "session_id": ctx.session_id,
                        "host": host.name,
                        "target": format!("{}@{}:{}", host.username, host.host, host.port),
                        "command": effective_command.chars().take(2000).collect::<String>(),
                        "exit_code": result.exit_code,
                        "duration_ms": result.duration_ms,
                        "fingerprint": result.fingerprint,
                        "stdout_bytes": result.stdout.len(),
                        "stderr_bytes": result.stderr.len(),
                    }),
                );

                let (stdout, stdout_truncated) = truncate_section(&result.stdout);
                let (stderr, stderr_truncated) = truncate_section(&result.stderr);
                let exit_text = match result.exit_code {
                    Some(code) => format!("退出码 {code}"),
                    None => "无退出码（可能被信号终止）".to_string(),
                };
                let fingerprint = if result.fingerprint.is_empty() {
                    "未知".to_string()
                } else {
                    result.fingerprint.clone()
                };
                let header = format!(
                    "远程执行完成：host={} · {}@{}:{} · {} · {}ms · 主机指纹={}\n$ {}\n",
                    host.name,
                    host.username,
                    host.host,
                    host.port,
                    exit_text,
                    result.duration_ms,
                    fingerprint,
                    effective_command
                );
                let body = format!(
                    "--- stdout（{} 字节{}）---\n{}\n--- stderr（{} 字节{}）---\n{}",
                    result.stdout.len(),
                    if stdout_truncated { "，已截断" } else { "" },
                    stdout,
                    result.stderr.len(),
                    if stderr_truncated { "，已截断" } else { "" },
                    stderr
                );
                Ok(ToolOutput::text(format!("{header}{body}")))
            }
            "upload" => {
                let host_name = value
                    .get("host")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                if host_name.is_empty() {
                    return Err("upload 缺少 host：请先用 action=hosts 查看可用主机名称".to_string());
                }
                let project_id = value
                    .get("project_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("upload 需要 project_id（当前科研项目 id）")?
                    .to_string();
                let local_path = value
                    .get("local_path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("upload 缺少 local_path（项目内相对路径）")?;
                let remote_path = value
                    .get("remote_path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("upload 缺少 remote_path（远端目标文件路径）")?;
                let host = find_host(&hosts, host_name)?;
                check_agent_usage(&host, Some(&project_id))?;

                let (local_file, size) = resolve_upload_source(&data_dir, &project_id, local_path)?;
                let bytes = std::fs::read(&local_file)
                    .map_err(|err| format!("读取本地文件失败：{err}"))?;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let command = build_upload_command(remote_path, &encoded)?;
                let timeout_secs = value
                    .get("timeout_secs")
                    .and_then(Value::as_u64)
                    .map(ssh::clamp_timeout)
                    .unwrap_or_else(|| ssh::clamp_timeout(DEFAULT_TIMEOUT_SECS));
                let result = ssh::exec_blocking(&host, &command, timeout_secs)?;
                process::write_audit(
                    &data_dir,
                    &json!({
                        "ts": now_secs_helper(),
                        "tool": "remote_exec",
                        "agent": ctx.agent.name(),
                        "session_id": ctx.session_id,
                        "action": "upload",
                        "host": host.name,
                        "target": format!("{}@{}:{}", host.username, host.host, host.port),
                        "project_id": project_id,
                        "local_path": local_path,
                        "remote_path": remote_path,
                        "bytes": size,
                        "exit_code": result.exit_code,
                        "duration_ms": result.duration_ms,
                        "fingerprint": result.fingerprint,
                    }),
                );
                if result.exit_code != Some(0) {
                    return Err(format!(
                        "远程写入失败（exit={:?}）：{}",
                        result.exit_code,
                        truncate_section(&result.stderr).0
                    ));
                }
                Ok(ToolOutput::text(format!(
                    "上传完成：已把项目内 {}（{} 字节）写到远端 {}（host={} · {}@{}:{} · {}ms）",
                    local_path,
                    size,
                    remote_path,
                    host.name,
                    host.username,
                    host.host,
                    host.port,
                    result.duration_ms
                )))
            }
            other => Err(format!(
                "不支持的 action：{other:?}（可选 hosts / run / upload）"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str) -> SshHostConfig {
        SshHostConfig {
            name: name.to_string(),
            host: "10.0.0.8".to_string(),
            port: 2222,
            username: "deploy".to_string(),
            auth: "password".to_string(),
            password: "super-secret".to_string(),
            key_path: String::new(),
            passphrase: String::new(),
            remote_dir: "/srv/app".to_string(),
            fingerprint: String::new(),
            project_id: String::new(),
            allow_agent: false,
            log_session: false,
        }
    }

    fn authorized_host() -> SshHostConfig {
        let mut host = host("prod");
        host.fingerprint = "SHA256:abc".to_string();
        host.project_id = "proj-1".to_string();
        host.allow_agent = true;
        host
    }

    #[test]
    fn hosts_listing_never_leaks_credentials() {
        let mut allowed = authorized_host();
        allowed.password = "super-secret".to_string();
        let text = format_hosts(&[allowed]);
        assert!(text.contains("prod"), "{text}");
        assert!(text.contains("10.0.0.8"), "{text}");
        assert!(!text.contains("super-secret"), "密码泄露：{text}");
        assert!(!text.contains("password="), "不应输出凭据字段：{text}");
        assert!(text.contains("绑定项目=proj-1"), "{text}");
        assert!(text.contains("allowAgent=是"), "{text}");
        assert!(text.contains("指纹=已固定"), "{text}");
        let empty = format_hosts(&[]);
        assert!(empty.contains("尚未配置"), "空列表提示缺失：{empty}");
        assert!(!empty.contains("admin"), "空列表不应带主机：{empty}");
    }

    #[test]
    fn agent_usage_requires_authorization_fingerprint_and_binding() {
        let mut unauthorized = authorized_host();
        unauthorized.allow_agent = false;
        let err = check_agent_usage(&unauthorized, None).expect_err("not authorized");
        assert!(err.contains("未授权"), "{err}");

        let mut untrusted = authorized_host();
        untrusted.fingerprint = String::new();
        let err = check_agent_usage(&untrusted, Some("proj-1")).expect_err("no fingerprint");
        assert!(err.contains("尚未固定主机指纹"), "{err}");

        let err = check_agent_usage(&authorized_host(), Some("proj-2"))
            .expect_err("binding mismatch");
        assert!(err.contains("未绑定到当前项目"), "{err}");

        let mut unbound = authorized_host();
        unbound.project_id = String::new();
        let err = check_agent_usage(&unbound, Some("proj-1")).expect_err("unbound project");
        assert!(err.contains("未绑定到当前项目"), "{err}");

        assert!(check_agent_usage(&authorized_host(), Some("proj-1")).is_ok());
        assert!(check_agent_usage(&authorized_host(), None).is_ok());
        assert!(check_agent_usage(&unbound, None).is_ok());
    }

    #[test]
    fn upload_source_must_stay_inside_project() {
        let data_dir = std::env::temp_dir().join(format!(
            "mindbase-remote-upload-{}",
            crate::infra::db::local_id()
        ));
        let project = data_dir.join("research").join("proj-1");
        std::fs::create_dir_all(project.join("analysis").join("scripts")).expect("dirs");
        std::fs::write(project.join("analysis/scripts/run.py"), b"print(1)").expect("write file");

        let (file, size) = resolve_upload_source(&data_dir, "proj-1", "analysis/scripts/run.py")
            .expect("valid upload source");
        assert_eq!(size, 8);
        assert!(file.ends_with("run.py"), "{}", file.display());

        let err = resolve_upload_source(&data_dir, "proj-1", "../secret.txt")
            .expect_err("traversal must fail");
        assert!(err.contains("项目目录之外"), "{err}");

        let err = resolve_upload_source(&data_dir, "proj-1", "no-such.txt")
            .expect_err("missing file must fail");
        assert!(err.contains("文件不存在"), "{err}");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn upload_command_quotes_paths_and_validates_target() {
        let command = build_upload_command("/srv/app/run.py", "cHJpbnQoMSk=").expect("build");
        assert!(command.contains("mkdir -p '/srv/app'"), "{command}");
        assert!(command.contains("printf %s 'cHJpbnQoMSk='"), "{command}");
        assert!(
            command.contains(
                "| (base64 -d 2>/dev/null || base64 -D 2>/dev/null || openssl base64 -d) > '/srv/app/run.py'"
            ),
            "{command}"
        );

        let relative = build_upload_command("run.py", "eA==").expect("relative target");
        assert!(relative.contains("mkdir -p '.'"), "{relative}");
        assert!(build_upload_command("", "eA==").is_err());
        assert!(build_upload_command("/srv/", "eA==").is_err());

        let quoted = build_upload_command("/srv/it's/run.py", "eA==").expect("quoted path");
        assert!(quoted.contains("'/srv/it'\\''s'"), "{quoted}");
    }

    #[test]
    fn command_prefixes_cd_only_when_needed() {
        assert_eq!(build_command("ls -la", None), "ls -la");
        assert_eq!(build_command("ls -la", Some("   ")), "ls -la");
        assert_eq!(
            build_command("ls -la", Some("/srv/app")),
            "cd '/srv/app' && ls -la"
        );
        // 目录里有单引号时按 POSIX 规则转义。
        assert_eq!(
            build_command("pwd", Some("/srv/it's")),
            "cd '/srv/it'\\''s' && pwd"
        );
    }

    #[test]
    fn sections_are_truncated_on_char_boundaries() {
        let short = "ok";
        assert_eq!(truncate_section(short), ("ok".to_string(), false));
        let long = "汉".repeat(MAX_SECTION_BYTES);
        let (text, truncated) = truncate_section(&long);
        assert!(truncated);
        assert!(text.starts_with('汉'));
        assert!(text.contains("已截断"));
        assert!(std::str::from_utf8(text.as_bytes()).is_ok());
    }
}

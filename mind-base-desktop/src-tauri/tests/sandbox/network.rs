//! sandbox 包的网络策略验证（直接调用包 API，不经过 agent/harness）。
//!
//! - network_off_blocks_outbound_requests：默认断网，CI 默认执行；
//!   断言的是「连接失败」而不是「能连上」，不依赖外网。
//! - network_on_allows_outbound_requests：忽略用例（需要真实外网 + 直连出口，
//!   AppContainer 不允许 loopback，不能用本机代理）。
//!
//! 手动跑联网用例：
//! cargo test --test e2e_sandbox_network -- --ignored
#![cfg(windows)]

use std::path::PathBuf;
use std::time::Duration;

use mind_base_desktop_lib::sandbox::{self, SandboxNetwork, SandboxShell};

const TIMEOUT: Duration = Duration::from_secs(120);

/// 沙箱内直连探针：成功输出 NET_OK，异常输出 NET_BLOCKED。
/// 用 .NET WebClient（不走代理）而不是 curl：AppContainer 里 curl 依赖 schannel
/// 证书存储，会被文件/注册表隔离挡住。
const PROBE_COMMAND: &str = concat!(
    "try { ",
    "$wc = New-Object System.Net.WebClient; ",
    "$wc.Proxy = $null; ",
    "$wc.DownloadString('https://example.com') | Out-Null; ",
    "'NET_OK' ",
    "} catch { 'NET_BLOCKED' }"
);

struct SandboxEnv {
    root: PathBuf,
    work_dir: PathBuf,
    log_dir: PathBuf,
}

impl SandboxEnv {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("mb-sandbox-net-{tag}-{}", std::process::id()));
        let work_dir = root.join("work");
        let log_dir = root.join("logs");
        std::fs::create_dir_all(&work_dir).expect("create work dir");
        std::fs::create_dir_all(&log_dir).expect("create log dir");
        Self { root, work_dir, log_dir }
    }

    fn probe(&self, network: SandboxNetwork) -> String {
        let output = sandbox::run(
            PROBE_COMMAND,
            SandboxShell::Pwsh,
            &self.work_dir,
            TIMEOUT,
            network,
            &self.log_dir,
        )
        .expect("probe should run");
        std::fs::read_to_string(&output.stdout_path).unwrap_or_default()
    }
}

impl Drop for SandboxEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn network_off_blocks_outbound_requests() {
    let env = SandboxEnv::new("off");
    let stdout = env.probe(SandboxNetwork::Off);
    assert!(stdout.contains("NET_BLOCKED"), "network=off 未阻断出站请求：{stdout}");
    assert!(!stdout.contains("NET_OK"), "network=off 下请求竟然成功：{stdout}");
}

#[test]
#[ignore = "需要真实外网：手动验证 AppContainer 的 internetClient 能力（network=on，直连）"]
fn network_on_allows_outbound_requests() {
    let env = SandboxEnv::new("on");
    let stdout = env.probe(SandboxNetwork::On);
    assert!(stdout.contains("NET_OK"), "network=on 未能联网（检查直连出口）：{stdout}");
}

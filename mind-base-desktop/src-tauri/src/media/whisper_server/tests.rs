//! Unit tests for the local whisper sidecar package.

use std::path::Path;
use std::time::Duration;

use crate::infra::config::LocalAsrConfig;

use super::models::{
    model_dir, model_status_list, resolve_model_path, start_model_download, DEFAULT_PORT,
};
use super::process::{effective_port, probe_port, server_command, PortState};

fn test_cfg(port: u16, model: &str) -> LocalAsrConfig {
    LocalAsrConfig {
        enabled: true,
        command: String::new(),
        port,
        model: model.to_string(),
        extra_args: String::new(),
        ready_timeout_secs: 5,
    }
}

#[test]
fn dead_port_is_not_serving() {
    // Port 1 is never bound by our server in test environments.
    assert_eq!(probe_port(1), PortState::NotServing);
}

#[test]
fn zero_port_falls_back_to_packaged_default() {
    assert_eq!(effective_port(&test_cfg(0, "small")), DEFAULT_PORT);
    assert_eq!(effective_port(&test_cfg(8799, "small")), 8799);
}

#[test]
fn server_command_carries_script_port_model_and_hf_home() {
    let exe = Path::new("C:/embedded/python.exe");
    let cfg = test_cfg(8765, "small");
    let dir = Path::new("D:/appdata");
    let cmd = server_command(&exe, &cfg, dir);
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    // The script path is the first argument.
    assert!(args[0].ends_with("whisper_server.py"));
    let joined = args.join(" ");
    assert!(joined.contains("--host 127.0.0.1"));
    assert!(joined.contains("--port 8765"));
    assert!(joined.contains("--model small"));
    assert!(joined.contains("--hf-home"));
    assert!(joined.contains("whisper-models"));
}

#[test]
fn extra_args_are_split_into_tokens() {
    let cfg = LocalAsrConfig {
        extra_args: "--device cuda --beam-size 5".to_string(),
        ..test_cfg(8765, "small")
    };
    let cmd = server_command(Path::new("python"), &cfg, Path::new("D:/d"));
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    assert!(args
        .windows(2)
        .any(|w| w[0] == "--device" && w[1] == "cuda"));
    assert!(args
        .windows(2)
        .any(|w| w[0] == "--beam-size" && w[1] == "5"));
}

#[test]
fn model_layout_detection() {
    let dir = std::env::temp_dir().join(format!("mb-model-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // Plain layout: model.bin + config.json present.
    let plain = model_dir(&dir, "small");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(resolve_model_path(&dir, "small").is_none()); // empty dir
    std::fs::write(plain.join("model.bin"), b"x").unwrap();
    std::fs::write(plain.join("config.json"), b"{}").unwrap();
    assert_eq!(
        resolve_model_path(&dir, "small"),
        Some(plain.clone()),
        "plain layout resolves once model.bin + config.json exist"
    );
    // A `.part` left over must not break resolution.
    std::fs::write(plain.join("model.bin.part"), b"y").unwrap();
    assert!(resolve_model_path(&dir, "small").is_some());
    // Legacy HF-hub layout resolves via refs/main -> snapshots/<sha>.
    let repo = dir
        .join("whisper-models")
        .join("hub")
        .join("models--Systran--faster-whisper-tiny");
    let snap = repo.join("snapshots").join("abc123");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::create_dir_all(repo.join("refs")).unwrap();
    std::fs::write(repo.join("refs").join("main"), b"abc123\n").unwrap();
    std::fs::write(snap.join("model.bin"), b"x").unwrap();
    assert_eq!(
        resolve_model_path(&dir, "tiny"),
        Some(snap),
        "legacy HF snapshot resolves"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Real network download of the smallest model, exercising the resumable
/// downloader + progress registry + resolution end-to-end. Deliberately
/// keeps its temp dir between runs so a re-run resumes an interrupted
/// `.part` (proving resume). Explicitly opt-in:
/// `cargo test --lib whisper_server -- --ignored` (~80MB).
#[test]
#[ignore]
fn downloads_tiny_model_end_to_end() {
    // Fixed dir name so a re-run resumes the previous run's `.part`
    // (each cargo test process has a different pid, and the download
    // thread dies with it).
    let dir = std::env::temp_dir().join("mindbase-model-dl-test");
    std::fs::create_dir_all(&dir).unwrap();
    start_model_download(dir.clone(), "tiny".to_string()).unwrap();
    for _ in 0..1800 {
        if resolve_model_path(&dir, "tiny").is_some() {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let path = resolve_model_path(&dir, "tiny").expect("tiny model should download");
    let size = std::fs::metadata(path.join("model.bin")).unwrap().len();
    assert!(
        size > 60_000_000,
        "tiny model.bin implausibly small: {size}"
    );
    let status = model_status_list(&dir);
    let tiny = status.iter().find(|s| s.model == "tiny").unwrap();
    assert!(tiny.downloaded && !tiny.downloading && tiny.error.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

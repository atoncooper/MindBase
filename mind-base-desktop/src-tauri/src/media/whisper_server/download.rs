//! Resumable model downloader (direct/proxied alternating, `.part` resume).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::infra::logging;

use super::models::{downloads_slot, model_dir, MODEL_AUX_FILES};

/// Direct (no-proxy) and optional proxied agents for model downloads. The
/// hf-mirror + HF CDN hosts answer fine directly on mainland networks while
/// an overseas-exit proxy stalls the big files, so direct is preferred; the
/// proxy is the fallback for networks that need it. Also reused by the
/// local-OCR model downloader (`ocr_server`).
pub(crate) struct DownloadAgents {
    pub(crate) direct: ureq::Agent,
    pub(crate) via_proxy: Option<ureq::Agent>,
}

pub(crate) fn download_agents() -> Result<DownloadAgents, String> {
    // Read timeouts must be per-read (streaming a multi-GB body), not overall.
    let builder = || {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
    };
    let direct = builder().build();
    // Proxy source is the user's egress setting — never the environment, and
    // deliberately NOT `proxy_for_url`: the model hosts sit on the
    // direct-connect bypass list (an overseas proxy stalls the big files),
    // and this downloader manages its own direct/proxy alternation instead
    // of proxy-first. Model URLs are https, so the https address applies,
    // falling back to the http address when only that one is filled.
    let setting = crate::llm::api_keys::proxy_setting();
    let via_proxy = match setting.https.or(setting.http) {
        Some(url) => {
            let proxy =
                ureq::Proxy::new(&url).map_err(|err| format!("invalid proxy url {url}: {err}"))?;
            Some(builder().proxy(proxy).build())
        }
        None => None,
    };
    Ok(DownloadAgents { direct, via_proxy })
}

/// Download one repo file into `dest` with resume support (`.part` suffix).
/// `on_progress` receives (downloaded, total) for the whole file. Shared
/// with the local-OCR model downloader.
pub(crate) fn download_file(
    agents: &DownloadAgents,
    url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    // Appended (not replacing) so `model.bin` resumes as `model.bin.part` —
    // `with_extension` would collide files sharing a stem (vocabulary.txt vs
    // a hypothetical vocabulary.json).
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    // Alternate direct / proxied attempts so a network that only works one
    // way still converges.
    let max_attempts = 8usize;
    let mut last_err = String::new();
    for attempt in 0..max_attempts {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2 * attempt as u64));
        }
        let use_proxy = attempt % 2 == 1 && agents.via_proxy.is_some();
        let agent = match (use_proxy, &agents.via_proxy) {
            (true, Some(p)) => p,
            _ => &agents.direct,
        };
        let mut request = agent.get(url);
        if have > 0 {
            request = request.set("Range", &format!("bytes={have}-"));
        }
        let response = match request.call() {
            Ok(resp) => resp,
            Err(ureq::Error::Status(416, _)) => {
                // Range not satisfiable = the .part already holds everything.
                std::fs::rename(&part, dest).map_err(|err| format!("完成文件重命名失败：{err}"))?;
                return Ok(());
            }
            Err(ureq::Error::Status(code, resp)) => {
                last_err = format!("HTTP {code}: {}", {
                    let body = resp.into_string().unwrap_or_default();
                    body.chars().take(200).collect::<String>()
                });
                // 4xx (except 429 rate-limiting) is permanent for this file —
                // retrying a missing repo file only burns ~1 minute of sleeps.
                if (400..500).contains(&code) && code != 429 {
                    return Err(last_err);
                }
                continue;
            }
            Err(err) => {
                last_err = err.to_string();
                continue;
            }
        };
        // A 200 (not 206) means the server ignored the Range: restart.
        if response.status() == 200 && have > 0 {
            have = 0;
            let _ = std::fs::remove_file(&part);
        }
        let total = response
            .header("Content-Length")
            .and_then(|len| len.parse::<u64>().ok())
            .map(|len| len + have);
        let mut reader = response.into_reader();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part)
            .map_err(|err| format!("无法写入下载文件 {}：{err}", part.display()))?;
        let mut buf = [0u8; 64 * 1024];
        let mut io_err: Option<std::io::Error> = None;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(err) = file.write_all(&buf[..n]) {
                        io_err = Some(err);
                        break;
                    }
                    have += n as u64;
                    on_progress(have, total.unwrap_or(0));
                }
                Err(err) => {
                    io_err = Some(err);
                    break;
                }
            }
        }
        drop(file);
        if io_err.is_none() {
            // Stream ended; complete when the total is satisfied (or unknown).
            match total {
                Some(t) if have < t => {
                    last_err = format!("连接中断（{have}/{t} 字节），将断点续传");
                    continue;
                }
                _ => {
                    std::fs::rename(&part, dest)
                        .map_err(|err| format!("完成文件重命名失败：{err}"))?;
                    return Ok(());
                }
            }
        }
        last_err = format!(
            "下载中断：{}",
            io_err.map(|e| e.to_string()).unwrap_or_default()
        );
    }
    Err(format!("下载失败（{max_attempts} 次尝试后）：{last_err}"))
}

/// Download one model into the plain layout (`whisper-models/<model>/`),
/// tracking progress in the global registry. Runs on a worker thread.
pub(super) fn download_model(data_dir: &Path, model: &str) -> Result<(), String> {
    let dir = model_dir(data_dir, model);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("无法创建模型目录 {}：{err}", dir.display()))?;
    let agents = download_agents()?;
    let base = format!("https://hf-mirror.com/Systran/faster-whisper-{model}/resolve/main");

    let update = |file_downloaded: u64, file_total: u64, aux_done: bool| {
        let mut downloads = downloads_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(state) = downloads.get_mut(model) {
            // Progress accounting centers on model.bin; aux files (~2MB)
            // collapse into a constant head start so the bar starts near 0.
            state.downloaded_bytes = file_downloaded;
            state.total_bytes = if file_total > 0 { file_total } else { 0 };
            let _ = aux_done;
        }
    };

    // Aux files first (small, fast) so a failed weight download still leaves
    // a resumable state rather than a half-configured dir.
    for name in MODEL_AUX_FILES {
        let dest = dir.join(name);
        if dest.is_file() {
            continue;
        }
        let url = format!("{base}/{name}");
        let mut local = 0u64;
        let result = download_file(&agents, &url, &dest, &mut |have, _total| {
            local = have;
        });
        match result {
            Ok(()) => logging::info(
                "whisper",
                &format!("模型文件完成：{model}/{name}（{local} 字节）"),
            ),
            Err(err) => {
                // Optional file (404-style failures after retries): skip it.
                logging::warn("whisper", &format!("模型文件跳过：{model}/{name}（{err}）"));
                let _ = std::fs::remove_file(PathBuf::from(format!("{}.part", dest.display())));
            }
        }
    }

    let weights = dir.join("model.bin");
    if !weights.is_file() {
        let url = format!("{base}/model.bin");
        download_file(&agents, &url, &weights, &mut |have, total| {
            update(have, total, true);
        })?;
    }
    // Sanity: the dir must now be usable by faster-whisper.
    if !weights.is_file() || !dir.join("config.json").is_file() {
        return Err("下载完成但模型目录不完整（缺 model.bin 或 config.json）".to_string());
    }
    Ok(())
}

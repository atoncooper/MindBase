//! End-to-end ASR / embedding verification behind the provider connectivity test.

use std::path::{Path, PathBuf};
use std::time::Instant;

use tauri::{AppHandle, State};

use crate::infra::db::Db;

use super::catalog::{build_models_url, default_endpoint};
use super::probe::{run_probe, ProviderTestResult, PROBE_TIMEOUT};
use super::proxy::egress_agents;
use super::status::{read_model, read_raw_config};
use super::validation::validate_provider;

/// Probe one provider's stored configuration and report whether it works.
///
/// Uses `GET <endpoint>/models` — authenticates the key and validates the
/// Base URL without consuming any tokens. Blocking IO stays on a worker
/// thread; only owned data crosses the boundary.
///
/// For the `asr` provider the check goes one step further to satisfy "key +
/// endpoint + model all work": after the model-list probe it verifies the
/// configured ASR model appears in the advertised list, then makes one real
/// transcription call with a tiny generated WAV (this consumes ASR quota).
#[tauri::command]
pub async fn test_provider_config(
    provider: String,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<ProviderTestResult, String> {
    let provider = validate_provider(&provider)?;

    // The `asr` slot doubles as the local-whisper switch: when local ASR is
    // enabled the "测试连接" button must exercise the local server instead of
    // the (possibly unconfigured) cloud credential. The stored local config +
    // data dir are read before the worker; the actual server start (which can
    // provision pip deps + download the model on first use) runs in it.
    let local_asr_test: Option<(crate::infra::config::LocalAsrConfig, PathBuf)> = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let cfg = crate::infra::config::load(&conn)?;
        if provider == "asr" && cfg.local_asr.enabled {
            let data_dir = db
                .data_dir
                .lock()
                .map(|dir| dir.clone())
                .map_err(|_| "failed to read data dir".to_string())?;
            Some((cfg.local_asr, data_dir))
        } else {
            None
        }
    };

    // Read the stored credential before entering the worker thread. The
    // `embedding` slot falls back to DashScope when left empty (mirroring the
    // ingest client), so "测试连接" reflects what ingestion actually uses.
    let (key, base_url, model, ffmpeg_path) = if local_asr_test.is_some() {
        (String::new(), String::new(), String::new(), None)
    } else {
        read_provider_credential(&provider, &db, &app)?
    };

    let models_url = build_models_url(&base_url, &provider);
    let protocol = crate::llm::ai_providers::protocol_of(&provider);
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some((cfg, data_dir)) = local_asr_test {
            return run_local_asr_test(&cfg, &data_dir);
        }
        // WebSocket ASR has no HTTP `/models` route — skip the generic probe
        // and start neutral; the real-time transcription probe is the verdict.
        let mut outcome = match &models_url {
            Some(url) => run_probe(provider.clone(), url.clone(), key.clone(), protocol)?,
            None => ProviderTestResult {
                provider: provider.clone(),
                ok: false,
                latency_ms: 0,
                endpoint: base_url.clone(),
                http_status: None,
                model_count: None,
                detail: if provider == "asr" {
                    "WebSocket 端点：以实时转写探测为准".to_string()
                } else {
                    "尚未配置 Base URL，无法探测".to_string()
                },
                asr_model_ok: None,
                asr_note: None,
                embedding_note: None,
            },
        };
        if provider == "asr" {
            outcome = run_asr_e2e(outcome, key, base_url, model, ffmpeg_path)?;
        } else if provider == "embedding" {
            outcome = run_embedding_e2e(outcome, key, base_url, model)?;
        }
        Ok::<_, String>(outcome)
    })
    .await
    .map_err(|err| format!("probe task failed: {err}"))??;

    Ok(result)
}

/// Read one provider's stored credential + config for the connectivity probe.
fn read_provider_credential(
    provider: &str,
    db: &State<'_, Db>,
    app: &AppHandle,
) -> Result<(String, String, String, Option<PathBuf>), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let (key, base_url) = if provider == "embedding" {
        read_raw_config(&conn, "embedding")?
            .or(read_raw_config(&conn, "dashscope")?)
            .ok_or_else(|| {
                "未配置向量化（Embedding）密钥：请在向量化卡片填写，或先配置 DashScope 密钥"
                    .to_string()
            })?
    } else {
        read_raw_config(&conn, provider)?
            .ok_or_else(|| format!("尚未保存 {provider} 的 API Key，请先保存再测试"))?
    };
    let model = read_model(&conn, provider)?;
    // Only the real-time WebSocket ASR path uses ffmpeg (audio→PCM). A
    // missing binary is non-fatal here: the tiny probe WAV needs no ffmpeg.
    let cfg = crate::infra::config::load(&conn)?;
    let ffmpeg_path =
        crate::media::ffmpeg::resolve_ffmpeg_path(app, cfg.ffmpeg_path_override.as_deref()).ok();
    Ok((key, base_url, model, ffmpeg_path))
}

/// Test the local whisper server: start it when needed (the first run
/// provisions the embedded-Python deps and downloads the model), report
/// `/health`, and — once the model is ready — run one real tiny transcription
/// through the live endpoint. Blocking; runs inside the probe worker.
fn run_local_asr_test(
    cfg: &crate::infra::config::LocalAsrConfig,
    data_dir: &Path,
) -> Result<ProviderTestResult, String> {
    let started = Instant::now();
    let base = crate::media::whisper_server::ensure_running(cfg, data_dir)?;
    let health = crate::media::whisper_server::health_snapshot(cfg.port)?;
    let model = health
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or(&cfg.model)
        .to_string();
    let model_ready = health
        .get("modelReady")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let load_error = health
        .get("error")
        .and_then(|v| v.as_str())
        .filter(|e| !e.trim().is_empty())
        .map(str::to_string);

    let mut result = ProviderTestResult {
        provider: "asr".to_string(),
        ok: false,
        latency_ms: started.elapsed().as_millis() as u64,
        endpoint: base.clone(),
        http_status: Some(200),
        model_count: None,
        detail: String::new(),
        asr_model_ok: None,
        asr_note: None,
        embedding_note: None,
    };

    if let Some(err) = load_error {
        result.detail = format!("本地 ASR 服务已启动，但模型加载失败：{err}");
        return Ok(result);
    }
    if !model_ready {
        result.ok = true;
        result.detail = format!(
            "本地 ASR 服务已启动（模型 {model} 仍在后台下载/加载，首次需数分钟；完成后即可入库）"
        );
        return Ok(result);
    }
    // Model ready → one real tiny transcription through the live endpoint.
    let client = crate::media::asr::AsrClient::with_base_and_ffmpeg(
        "local-whisper".to_string(),
        model.clone(),
        Some(base),
        None,
        None,
    )?;
    match client.probe_transcribe() {
        Ok(note) => {
            result.ok = true;
            result.asr_note = Some(note.clone());
            result.detail = format!("本地 Whisper 运行正常 · 模型 {model} · 真实转写：{note}");
        }
        Err(err) => {
            result.detail = format!("本地 ASR 服务运行中，但转写调用失败：{err}");
        }
    }
    Ok(result)
}

/// Extend the generic models-list probe into a full ASR check: verify the
/// key + endpoint, then make one **real** transcription call with a tiny
/// generated WAV through the configured endpoint + model. Runs inside the
/// worker thread.
fn run_asr_e2e(
    base: ProviderTestResult,
    key: String,
    base_url: String,
    model: String,
    ffmpeg_path: Option<PathBuf>,
) -> Result<ProviderTestResult, String> {
    use crate::media::asr::{detect_mode, AsrClient, AsrMode};
    let mut result = base;

    let mode = detect_mode(&if base_url.trim().is_empty() {
        crate::media::asr::resolve_default_base()
    } else {
        base_url.clone()
    });

    // Model-existence check against the advertised `/models` list. This is
    // only meaningful for OpenAI-compatible endpoints: DashScope ASR models
    // (paraformer-*) are served by the audio API and are NOT advertised by
    // the compatible-mode `/models` list, so checking there would yield a
    // misleading false "not found". WebSocket endpoints have no HTTP model
    // list at all. For both we skip the check (asr_model_ok = None).
    let model_ok = if mode == AsrMode::OpenAICompatible {
        match fetch_model_ids(&result.endpoint, &key) {
            Ok(ids) => {
                let exists = model.trim().is_empty() || ids.iter().any(|id| id == &model);
                result.asr_model_ok = Some(exists);
                exists
            }
            Err(_) => {
                // Endpoint may not expose a list; fall through to the live call.
                result.asr_model_ok = None;
                true
            }
        }
    } else {
        result.asr_model_ok = None;
        true
    };

    // Real transcription for every mode: OpenAI-compatible posts a tiny WAV,
    // DashScope routes the tiny WAV through the live real-time Recognition
    // call, and a WebSocket endpoint streams it. A pure tone yields no speech,
    // so "success" means the endpoint accepted a genuine call — not that it
    // recognized words. This consumes ASR quota/billing.
    match AsrClient::with_base_and_ffmpeg(key, model.clone(), Some(base_url), ffmpeg_path, None) {
        Ok(client) => match client.probe_transcribe() {
            Ok(note) => {
                let model_list_part = match mode {
                    AsrMode::DashScope => "DashScope 实时识别 · ".to_string(),
                    AsrMode::WebSocket => "WebSocket 端点（无 HTTP 模型列表）· ".to_string(),
                    AsrMode::OpenAICompatible => match result.model_count {
                        Some(n) => format!("端点返回 {n} 个模型 · "),
                        None => String::new(),
                    },
                };
                // Only OpenAI-compatible reports the model-list check;
                // DashScope/WebSocket have no relevant list to verify against.
                let model_check = if mode == AsrMode::OpenAICompatible {
                    format!(
                        "模型 {} 校验{} · ",
                        if model.trim().is_empty() {
                            "(默认)"
                        } else {
                            &model
                        },
                        if model_ok {
                            "通过"
                        } else {
                            "未找到（仍尝试）"
                        },
                    )
                } else {
                    String::new()
                };
                result.detail =
                    format!("连接成功 · {model_list_part}{model_check}真实转写：{note}");
                result.asr_note = Some(note);
                // A successful real transcription probe confirms the endpoint
                // + key + model all work end-to-end.
                result.ok = true;
            }
            Err(err) => {
                result.ok = false;
                result.asr_note = Some(err.clone());
                result.detail = format!(
                    "端点和密钥可达，但真实转写失败：{err}（模型 {} 可能不可用或不支持音频转写）",
                    model
                );
            }
        },
        Err(err) => {
            result.ok = false;
            result.asr_note = Some(err.clone());
            result.detail = format!("ASR 客户端初始化失败：{err}");
        }
    }

    Ok(result)
}

/// Fetch the raw model id list from an OpenAI-compatible `/models` endpoint.
fn fetch_model_ids(models_url: &str, key: &str) -> Result<Vec<String>, String> {
    let (primary, fallback) = egress_agents(PROBE_TIMEOUT, models_url)?;
    let fetch = |agent: &ureq::Agent| -> Result<Vec<String>, String> {
        let response = agent
            .get(models_url)
            .set("Authorization", &format!("Bearer {key}"))
            .set("Accept", "application/json")
            .call()
            .map_err(|err| format!("查询模型列表失败：{err}"))?;
        let body = response
            .into_string()
            .map_err(|err| format!("读取模型列表失败：{err}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|err| format!("解析模型列表失败：{err}"))?;
        let ids = value
            .get("data")
            .and_then(|d| d.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();
        Ok(ids)
    };
    fetch(&primary).or_else(|first_err| {
        let fallback = fallback.ok_or_else(|| first_err.clone())?;
        fetch(&fallback).map_err(|retry_err| format!("{first_err}; fallback: {retry_err}"))
    })
}

/// Extend the generic models-list probe into a full embedding check: make
/// one real embedding call with a tiny text through the configured endpoint
/// + model. This catches the "test passed but ingest 404" case — endpoints
/// where `GET /models` works but `POST {base}/embeddings` is missing or the
/// configured model is not usable for embedding. Consumes a trivial amount
/// of embedding quota (one short string).
fn run_embedding_e2e(
    base: ProviderTestResult,
    key: String,
    base_url: String,
    model: String,
) -> Result<ProviderTestResult, String> {
    let mut result = base;
    let effective_base = if base_url.trim().is_empty() {
        default_endpoint("embedding").to_string()
    } else {
        base_url.clone()
    };
    match crate::llm::embeddings::probe_embedding(&effective_base, &key, &model) {
        Ok(note) => {
            result.ok = true;
            result.embedding_note = Some(note.clone());
            result.detail = format!("连接成功 · 端点可达 · {note}");
        }
        Err(err) => {
            result.ok = false;
            result.embedding_note = Some(err.clone());
            result.detail = format!(
                "端点和密钥可达（/models 正常），但真实向量化调用失败：{err}。请检查向量化 Base URL 是否指向 OpenAI 兼容的 Embedding 端点、模型是否为该端点支持的 Embedding 模型"
            );
        }
    }
    Ok(result)
}

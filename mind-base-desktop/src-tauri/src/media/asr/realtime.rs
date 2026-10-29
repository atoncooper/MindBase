//! DashScope real-time WebSocket recognition: protocol variants and chunked streaming.

use std::time::Duration;

use super::client::{AsrClient, UPLOAD_TIMEOUT};
use super::config::TRANSCRIPTION_MODEL;
use super::parse::collect_transcript;
use super::types::StageLog;

/// Real-time streaming model used by the WebSocket (`api-ws`) endpoint when
/// the user has left the async batch default in place.
const REALTIME_MODEL: &str = "paraformer-realtime-v2";

/// DashScope real-time WebSocket base path (relative to the ws host).
const REALTIME_WS_PATH: &str = "/api-ws/v1/inference/";

/// Real-time WebSocket session length cap (seconds). Async Transcription is
/// the primary DashScope path for every duration; the real-time Recognition
/// WebSocket (used only as a fallback) splits longer audio into timed PCM
/// chunks so no single session exceeds this (mirrors backend
/// `asr.realtime_max_seconds`).
const REALTIME_MAX_SECONDS: f64 = 60.0;

/// Maximum seconds of audio per real-time WebSocket session. The real-time
/// API's duplex stream stalls on multi-minute files, so longer audio is
/// split into timed PCM chunks and recognized over one fresh session per
/// chunk (mirrors the backend's `_transcribe_local_chunked`).
const REALTIME_CHUNK_SECONDS: usize = REALTIME_MAX_SECONDS as usize;
/// PCM bytes per chunk = 60s × 16 kHz × 2 bytes.
const REALTIME_CHUNK_BYTES: usize = REALTIME_CHUNK_SECONDS * 16_000 * 2;

impl AsrClient {
    /// Stream audio through a WebSocket ASR endpoint (DashScope `api-ws`
    /// real-time recognition). `bytes` is the whole local audio (WAV/PCM at
    /// the configured sample rate). Because ingestion runs on a blocking
    /// thread, this spins up a short-lived tokio runtime internally.
    ///
    /// The real-time API hangs on multi-minute audio, so — mirroring the
    /// backend's `_transcribe_local_chunked` — audio longer than
    /// [`REALTIME_CHUNK_SECONDS`] is split into timed PCM chunks and each
    /// chunk is recognized over its own session, concatenating the results.
    pub(super) fn transcribe_websocket(
        &self,
        bytes: &[u8],
        content_type: &str,
        on_stage: &StageLog,
    ) -> Result<String, String> {
        // Real-time ASR only accepts raw PCM, so normalize whatever the caller
        // handed us (WAV/AAC/MP4) to 16k mono PCM before streaming.
        on_stage("转码音频 → 16k PCM");
        let pcm = self.to_pcm_bytes(bytes, content_type, on_stage)?;
        let model = self.realtime_model();
        // Pick the run-task frame shape this endpoint accepts via a cheap
        // handshake probe (tiny PCM) before transcribing real audio.
        on_stage("连接实时端点并探测协议");
        let variant = self.ws_select_variant(&model, on_stage)?;

        let mut transcripts: Vec<String> = Vec::new();
        if pcm.len() <= REALTIME_CHUNK_BYTES {
            on_stage("分块转写中");
            if let Ok(text) = self.transcribe_websocket_chunk(&pcm, &model, &variant, on_stage) {
                if !text.trim().is_empty() {
                    transcripts.push(text);
                }
            }
        } else {
            // Long audio: one fresh session per timed PCM chunk.
            for (idx, chunk) in pcm.chunks(REALTIME_CHUNK_BYTES).enumerate() {
                match self.transcribe_websocket_chunk(chunk, &model, &variant, on_stage) {
                    Ok(text) if !text.trim().is_empty() => transcripts.push(text),
                    Ok(_) => on_stage(&format!("分块{} 转写为空", idx + 1)),
                    Err(err) => on_stage(&format!("分块{} 失败：{err}", idx + 1)),
                }
            }
        }

        let joined = transcripts.join("\n");
        // Empty is a legitimate outcome (silence / no speech); callers decide
        // whether to fall back (ingest) or report "accepted" (probe).
        Ok(joined.trim().to_string())
    }

    /// Run one real-time WebSocket session for a single PCM chunk (≤
    /// [`REALTIME_CHUNK_SECONDS`] of audio).
    ///
    /// Protocol (DashScope real-time streaming ASR):
    /// 1. Connect with `Authorization: Bearer <key>` header.
    /// 2. Send a JSON `run-task` header frame carrying model + audio format.
    /// 3. Send the audio as raw 16k mono PCM binary frames.
    /// 4. Collect sentence `text` from JSON result frames.
    /// 5. Send a JSON `finish-task` frame, then close.
    fn transcribe_websocket_chunk(
        &self,
        pcm: &[u8],
        _model: &str,
        variant: &WsVariant,
        on_stage: &StageLog,
    ) -> Result<String, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;
        use tokio_tungstenite::tungstenite::Message;

        let task_id = format!(
            "mb-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| format!("创建 WebSocket 运行时失败：{err}"))?;

        let url = self.websocket_endpoint();
        let api_key = self.api_key.clone();
        let deadline = UPLOAD_TIMEOUT;
        let on_stage = on_stage.clone();

        rt.block_on(async move {
            // 1. Connect with the DashScope real-time auth header.
            on_stage("连接实时 ASR 端点");
            let request = http::Request::builder()
                .uri(&url)
                .header("Authorization", &format!("Bearer {api_key}"))
                .header("User-Agent", "mind-base-desktop/0.1")
                .body(())
                .map_err(|err| format!("构造 WebSocket 请求失败：{err}"))?;
            let (ws, _) = connect_async(request)
                .await
                .map_err(|err| format!("WebSocket 连接失败：{err}"))?;
            on_stage("已连接，发送启动帧");
            let (mut sink, mut stream) = ws.split();

            // 2. run-task frame — shape chosen by the handshake probe.
            let header = variant.frame(&task_id);
            sink.send(Message::Text(header.to_string()))
                .await
                .map_err(|err| format!("发送 ASR 启动帧失败：{err}"))?;

            // 3. Stream the PCM audio as binary frames (chunked).
            const CHUNK: usize = 16 * 1024;
            for chunk in pcm.chunks(CHUNK) {
                tokio::time::timeout(deadline, sink.send(Message::Binary(chunk.to_vec())))
                    .await
                    .map_err(|_| "发送音频超时".to_string())?
                    .map_err(|err| format!("发送音频帧失败：{err}"))?;
            }

            // 5. finish-task frame.
            let finish = serde_json::json!({
                "header": { "action": "finish-task", "task_id": task_id }
            });
            sink.send(Message::Text(finish.to_string()))
                .await
                .map_err(|err| format!("发送结束帧失败：{err}"))?;

            // 4. Collect transcript text until the server reports
            //    `task-finished` (or closes / we time out). The frame's own
            //    payload is parsed *before* breaking on `task-finished`, so a
            //    final result bundled into that frame is not lost.
            let mut texts: Vec<String> = Vec::new();
            loop {
                let msg = tokio::time::timeout(deadline, stream.next())
                    .await
                    .map_err(|_| "等待转写结果超时".to_string())?;
                match msg {
                    None => break,
                    Some(Err(err)) => return Err(format!("WebSocket 接收失败：{err}")),
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            collect_transcript(&value, &mut texts);
                            // Run completed — stop waiting for further frames.
                            if value.pointer("/header/action").and_then(|a| a.as_str())
                                == Some("task-finished")
                            {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(_)) => {}
                }
            }

            // A well-formed session may legitimately carry no speech (silence,
            // a probe tone). Return Ok(empty) and let the caller decide —
            // the probe reports "accepted", ingest falls back to basic info.
            Ok(texts.join("").trim().to_string())
        })
    }

    /// Probe whether one run-task frame shape is accepted by the endpoint,
    /// using a tiny tone frame (no real transcription). Returns `Ok(true)`
    /// when the server starts the task and does not reject it with a
    /// protocol error; `Ok(false)` when the variant is rejected.
    fn ws_probe_variant(
        &self,
        variant: &WsVariant,
        _model: &str,
        _on_stage: &StageLog,
    ) -> Result<bool, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;
        use tokio_tungstenite::tungstenite::Message;

        let task_id = format!(
            "mbp-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| format!("创建 WebSocket 运行时失败：{err}"))?;
        let url = self.websocket_endpoint();
        let api_key = self.api_key.clone();
        let deadline = Duration::from_secs(6);

        rt.block_on(async move {
            let request = http::Request::builder()
                .uri(&url)
                .header("Authorization", &format!("Bearer {api_key}"))
                .header("User-Agent", "mind-base-desktop/0.1")
                .body(())
                .map_err(|err| format!("构造 WebSocket 请求失败：{err}"))?;
            let (ws, _) = connect_async(request)
                .await
                .map_err(|err| format!("WebSocket 连接失败：{err}"))?;
            let (mut sink, mut stream) = ws.split();

            // Send the candidate run-task frame, then a tiny tone, then finish.
            let header = variant.frame(&task_id);
            sink.send(Message::Text(header.to_string()))
                .await
                .map_err(|err| format!("发送 ASR 启动帧失败：{err}"))?;
            for chunk in ws_tiny_pcm().chunks(4096) {
                sink.send(Message::Binary(chunk.to_vec()))
                    .await
                    .map_err(|err| format!("发送探测音频失败：{err}"))?;
            }
            let finish = serde_json::json!({
                "header": { "action": "finish-task", "task_id": task_id }
            });
            sink.send(Message::Text(finish.to_string()))
                .await
                .map_err(|err| format!("发送结束帧失败：{err}"))?;

            let mut started = false;
            let mut failed = false;
            loop {
                let msg = tokio::time::timeout(deadline, stream.next())
                    .await
                    .map_err(|_| "探测等待超时".to_string())?;
                match msg {
                    None => break,
                    Some(Err(err)) => return Err(format!("WebSocket 探测接收失败：{err}")),
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            let event = value.pointer("/header/event").and_then(|e| e.as_str());
                            if event == Some("task-started") {
                                started = true;
                            }
                            if event == Some("task-failed") {
                                failed = true;
                                break;
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                }
            }
            Ok(started && !failed)
        })
    }

    /// Choose the first run-task frame shape the endpoint accepts, by probing
    /// each candidate with a tiny tone. If every probe is inconclusive, fall
    /// back to the first variant so the real call still runs and surfaces its
    /// own (more informative) error to the caller.
    fn ws_select_variant(&self, model: &str, on_stage: &StageLog) -> Result<WsVariant, String> {
        let variants = ws_variants(model);
        for (i, variant) in variants.iter().enumerate() {
            match self.ws_probe_variant(variant, model, on_stage) {
                Ok(true) => {
                    on_stage(&format!("协议变体 V{} 被接受", i + 1));
                    return Ok(variant.clone());
                }
                Ok(false) => on_stage(&format!("协议变体 V{} 被拒绝", i + 1)),
                Err(err) => on_stage(&format!("协议变体 V{} 探测失败：{err}", i + 1)),
            }
        }
        on_stage("无可用协议变体，尝试默认变体");
        Ok(variants.into_iter().next().expect("variants non-empty"))
    }

    /// The WebSocket URL to dial, normalized from the configured base.
    ///
    /// A full `wss://…/api-ws/v1/inference/` URL is used as-is; a bare
    /// DashScope host (or an `https://` DashScope base) is rewritten to the
    /// real-time endpoint; any other host is kept verbatim.
    fn websocket_endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if base.contains("/api-ws/v1/inference") {
            return self.base_url.clone();
        }
        if base.contains("dashscope.aliyuncs.com") {
            let host = if base.starts_with("ws://") || base.starts_with("wss://") {
                base.rsplit_once("//").map(|(_, host)| host).unwrap_or(base)
            } else if let Some(rest) = base.split_once("dashscope.aliyuncs.com") {
                // Keep only the host part (strip any https:// path).
                let _ = rest;
                "dashscope.aliyuncs.com"
            } else {
                base
            };
            return format!("wss://{host}{REALTIME_WS_PATH}");
        }
        base.to_string()
    }

    /// The model name to use on the real-time endpoint. When the user has not
    /// chosen a streaming model (empty or the async batch default), fall back
    /// to [`REALTIME_MODEL`]; otherwise respect their explicit choice.
    fn realtime_model(&self) -> String {
        let model = self.model.trim();
        // An empty model, the async batch default (TRANSCRIPTION_MODEL), or an
        // old realtime alias all mean "no explicit streaming choice" → use the
        // real-time Recognition model. A user-set streaming model is respected.
        if model.is_empty() || model == TRANSCRIPTION_MODEL || model == "paraformer-v1" {
            REALTIME_MODEL.to_string()
        } else {
            model.to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// Real-time WebSocket protocol variants
// ---------------------------------------------------------------------------

/// A run-task frame shape candidate for the real-time WebSocket endpoint.
///
/// The qwen-audio MaaS endpoint's exact schema is not published in the SDK.
/// Live probing shows `model` must live in `payload` (not `parameter`) and a
/// `payload.input` is required, while the concrete `parameter` shape varies.
/// We probe a small candidate set and use the first the server accepts.
#[derive(Clone)]
struct WsVariant {
    parameter: Option<serde_json::Value>,
    payload: serde_json::Value,
}

impl WsVariant {
    fn frame(&self, task_id: &str) -> serde_json::Value {
        let mut f = serde_json::json!({
            "header": { "action": "run-task", "task_id": task_id, "streaming": "duplex" }
        });
        if let Some(parameter) = &self.parameter {
            f["parameter"] = parameter.clone();
        }
        f["payload"] = self.payload.clone();
        f
    }
}

fn ws_variants(model: &str) -> Vec<WsVariant> {
    let base_payload = |input: serde_json::Value| {
        serde_json::json!({
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": model,
            "input": input
        })
    };
    vec![
        WsVariant {
            parameter: Some(serde_json::json!({
                "model": model, "format": "pcm", "sample_rate": 16000,
                "language_hints": ["zh", "en"]
            })),
            payload: base_payload(serde_json::json!({})),
        },
        WsVariant {
            parameter: Some(serde_json::json!({ "format": "pcm", "sample_rate": 16000 })),
            payload: base_payload(serde_json::json!({})),
        },
        WsVariant {
            parameter: Some(serde_json::json!({ "model": model })),
            payload: base_payload(serde_json::json!({})),
        },
        WsVariant {
            parameter: Some(
                serde_json::json!({ "input": { "format": "pcm", "sample_rate": 16000 } }),
            ),
            payload: base_payload(serde_json::json!({})),
        },
        WsVariant {
            parameter: None,
            payload: base_payload(serde_json::json!({})),
        },
    ]
}

fn ws_tiny_pcm() -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16_000;
    let seconds = 0.1f32;
    let samples = (SAMPLE_RATE as f32 * seconds) as usize;
    let mut pcm = Vec::with_capacity(samples * 2);
    for i in 0..samples {
        let t = i as f32 / SAMPLE_RATE as f32;
        let sample = (0.3 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 32767.0) as i16;
        pcm.extend_from_slice(&sample.to_le_bytes());
    }
    pcm
}

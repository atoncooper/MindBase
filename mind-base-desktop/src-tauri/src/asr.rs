//! ASR transcription — provider-agnostic, configurable via the "asr" slot's
//! Base URL / model in API settings.
//!
//! Three protocol families are supported, auto-detected from the Base URL:
//!
//! 1. **DashScope** (`host` contains `dashscope.aliyuncs.com`) — async
//!    **Transcription** (`paraformer-v2`) is the primary path for every
//!    duration (reliable, no ffmpeg needed): upload the real audio to the
//!    provider's temp OSS, submit a task, poll every 1.5s until
//!    SUCCEEDED/FAILED, then download the result JSON and join
//!    `transcripts[].text`. Only if that fails do we fall back to the
//!    real-time **Recognition** WebSocket (`paraformer-realtime-v2`, timed
//!    PCM chunks) — the backend's `_transcribe_local_via_transcription`
//!    primary with `_transcribe_local_chunked` as backup.
//! 2. **WebSocket** (`ws://` / `wss://`) — real-time streaming recognition
//!    (DashScope `api-ws`), including the same timed PCM chunking for long audio.
//! 3. **OpenAI-compatible** (anything else, e.g. OpenRouter
//!    `…/v1/audio/transcriptions`) — a single synchronous multipart
//!    `POST` carrying the audio bytes + `model`, returning `{"text": …}`.
//!
//! In DashScope mode `transcribe_url` lets the provider fetch a reachable
//! `https://` (CDN) or `oss://` link itself (async Transcription). In
//! OpenAI-compatible / WebSocket mode the client downloads the bytes and posts
//! or streams them (local files are read directly).
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::api_keys;

/// Default DashScope async ASR endpoint (mirrors backend `ASR_BASE`).
pub(crate) const DEFAULT_ASR_BASE: &str = "https://dashscope.aliyuncs.com/api/v1";

/// The default ASR base URL (used when the user leaves the field blank).
pub(crate) fn resolve_default_base() -> String {
    DEFAULT_ASR_BASE.to_string()
}
/// Default model when the user leaves the `asr` slot's model blank. Mirrors
/// the backend's `asr.model` (`paraformer-realtime-v2`, the real-time
/// Recognition model). Also the value `realtime_model()` falls back to when a
/// user has set the async batch default instead of a streaming model.
pub(crate) const ASR_MODEL: &str = "paraformer-realtime-v2";

/// Async Transcription model for long audio. Mirrors the backend's
/// `asr.transcription_model` (`paraformer-v2`): the real-time Recognition
/// model (`paraformer-realtime-v2`) does NOT support async batch
/// Transcription, so async tasks must always use this dedicated batch model —
/// never the user's configured real-time model.
pub(crate) const TRANSCRIPTION_MODEL: &str = "paraformer-v2";

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

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// Stage-log callback that reports granular ASR progress (ffmpeg transcode,
/// WebSocket connect, protocol probe, per-chunk, per-chunk errors) so the
/// ingest UI can render a detailed process. Thread-safe + cloneable so it can
/// move into the WebSocket runtime.
pub(crate) type StageLog = Arc<dyn Fn(&str) + Send + Sync + 'static>;

/// A no-op stage log for callers that don't surface ASR progress.
pub(crate) fn noop_stage() -> StageLog {
    Arc::new(|_| {})
}

/// Which transcription protocol to speak, derived from the Base URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AsrMode {
    DashScope,
    OpenAICompatible,
    /// A `ws://` / `wss://` streaming endpoint (e.g. DashScope `api-ws`).
    WebSocket,
}

/// ASR key from local settings; ingest fails fast without one. The dedicated
/// `asr` slot wins when set; otherwise fall back to the shared DashScope
/// credential.
pub(crate) fn resolve_api_key(conn: &Connection) -> Result<String, String> {
    if let Some((key, _)) = api_keys::read_raw_config(conn, "asr")? {
        return Ok(key);
    }
    match api_keys::read_raw_config(conn, "dashscope")? {
        Some((key, _)) => Ok(key),
        None => Err(
            "未配置 ASR/DashScope API Key：请在「API 设置」中填写密钥，或切换到「本地部署」用本地模型转写"
                .to_string(),
        ),
    }
}

/// ASR model: the dedicated `asr` slot's model when set, else the default.
pub(crate) fn resolve_model(conn: &Connection) -> Result<String, String> {
    let stored = api_keys::read_model(conn, "asr")?;
    Ok(if stored.trim().is_empty() {
        ASR_MODEL.to_string()
    } else {
        stored
    })
}

/// ASR Base URL: the dedicated `asr` slot's value when set, else the default
/// DashScope endpoint. `None` when nothing is stored.
pub(crate) fn resolve_base_url(conn: &Connection) -> Result<Option<String>, String> {
    match api_keys::read_raw_config(conn, "asr")? {
        Some((_, base_url)) if !base_url.trim().is_empty() => Ok(Some(base_url.trim().to_string())),
        _ => Ok(None),
    }
}

/// Detect the protocol family from a Base URL.
///
/// Any host containing `dashscope.aliyuncs.com` uses the async DashScope
/// protocol; every other host (OpenRouter, a local server, …) is treated as
/// OpenAI-compatible `POST /audio/transcriptions`.
pub(crate) fn detect_mode(base_url: &str) -> AsrMode {
    if base_url.starts_with("ws://") || base_url.starts_with("wss://") {
        AsrMode::WebSocket
    } else if base_url.contains("dashscope.aliyuncs.com") {
        AsrMode::DashScope
    } else {
        AsrMode::OpenAICompatible
    }
}

/// Outcome of one task-status poll.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TaskState {
    Pending,
    Running,
    Succeeded,
    Failed(String),
}

impl TaskState {
    fn from_status(status: &str, error_message: Option<String>) -> TaskState {
        match status {
            "SUCCEEDED" => TaskState::Succeeded,
            "FAILED" => TaskState::Failed(
                error_message.unwrap_or_else(|| "未知错误".to_string()),
            ),
            "RUNNING" => TaskState::Running,
            // PENDING / unknown → keep waiting.
            _ => TaskState::Pending,
        }
    }
}

/// Extract `task_id` from a submission response (top-level or under output).
fn parse_submit_task_id(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析 ASR 提交响应失败：{err}"))?;
    let task_id = value
        .get("task_id")
        .and_then(|v| v.as_str())
        .or_else(|| value.pointer("/output/task_id").and_then(|v| v.as_str()))
        .unwrap_or_default();
    if task_id.is_empty() {
        return Err(format!("ASR 提交失败：未返回 task_id（{body}）"));
    }
    Ok(task_id.to_string())
}

/// Parse one poll response into a [`TaskState`].
fn parse_task_state(body: &str) -> Result<TaskState, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析 ASR 状态响应失败：{err}"))?;
    let output = value.get("output").unwrap_or(&value);
    let status = output
        .get("task_status")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let error_message = output
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            // Per-file error inside results[0] when the task itself finished.
            output
                .pointer("/results/0/error_message")
                .and_then(|v| v.as_str())
                .or_else(|| output.pointer("/results/0/message").and_then(|v| v.as_str()))
                .map(str::to_string)
        });
    Ok(TaskState::from_status(status, error_message))
}

/// Pull the SUCCEEDED result URL out of a poll response body.
fn parse_transcription_url(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析 ASR 状态响应失败：{err}"))?;
    value
        .pointer("/output/results/0/transcription_url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "ASR 结果缺少 transcription_url".to_string())
}

/// Join a transcription result JSON into plain text.
///
/// Priority mirrors asr.py: `transcripts[].text`, falling back to per-sentence
/// text, falling back to a top-level `text`. Then — because DashScope
/// sometimes wraps the transcript under an `output` / `output.results[0]`
/// envelope (the same nesting the code already reads for `transcription_url`)
/// — the extraction is re-run on that inner object before giving up, so real
/// recognized text is never lost to a strict top-level scan.
fn parse_transcription_text(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析转写结果失败：{err}"))?;

    let joined = extract_transcript_text(&value);
    if joined.is_empty() {
        return Err("转写结果为空".to_string());
    }
    Ok(joined)
}

/// Priority-based transcript extraction from one JSON node, with an envelope
/// fallback for wrapped DashScope responses.
fn extract_transcript_text(value: &serde_json::Value) -> String {
    let mut texts: Vec<String> = Vec::new();

    let transcripts = value
        .get("transcripts")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    if !transcripts.is_empty() {
        for item in &transcripts {
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                texts.push(text);
                continue;
            }
            if let Some(sentences) = item.get("sentences").and_then(|s| s.as_array()) {
                for sentence in sentences {
                    let sentence_text = sentence
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    if !sentence_text.is_empty() {
                        texts.push(sentence_text);
                    }
                }
            }
        }
    }
    if texts.is_empty() {
        if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                texts.push(text.to_string());
            }
        }
    }

    // Envelope fallback: some DashScope responses nest the transcript under
    // `output` or `output.results[0]`. Re-run the same priority extraction on
    // the inner object rather than declaring the result empty.
    if texts.is_empty() {
        if let Some(output) = value.get("output") {
            let nested = extract_transcript_text(output);
            if !nested.is_empty() {
                return nested;
            }
        }
        if let Some(result) = value
            .pointer("/output/results/0")
            .or_else(|| value.get("results"))
        {
            let nested = extract_transcript_text(result);
            if !nested.is_empty() {
                return nested;
            }
        }
    }

    texts.join("\n")
}

/// One upload-certificate payload (fields of DashScope's getPolicy response).
///
/// The official `OssUtils.upload` SDK builds the PostObject from **whatever
/// getPolicy returns** (accessid/host/dir plus callback/ACL/…). We mirror that
/// by keeping the policy fields plus any extra fields verbatim, so a missing
/// `callback` (the classic silent 403) can never happen.
#[allow(dead_code)]
struct UploadCertificate {
    access_key_id: String,
    signature: String,
    policy: String,
    upload_dir: String,
    upload_host: String,
    /// Any additional policy fields (callback, acl, forbid-overwrite, …),
    /// sent through verbatim as OSS PostObject form fields.
    extra: Vec<(String, String)>,
}

impl UploadCertificate {
    /// Parse from a getPolicy response body (`output` envelope, `data` fallback).
    ///
    /// DashScope's getPolicy returns `accessid`/`host`/`dir` (the naming the
    /// official SDK uses); some deployments alias them as
    /// `oss_access_key_id`/`upload_host`/`upload_dir`. Both are accepted.
    fn parse(body: &str) -> Result<Self, String> {
        let value: serde_json::Value =
            serde_json::from_str(body).map_err(|err| format!("解析上传凭证失败：{err}"))?;
        let info = value
            .get("output")
            .or_else(|| value.get("data"))
            .ok_or("上传凭证响应缺少数据")?;
        let obj = info
            .as_object()
            .ok_or("上传凭证响应不是对象")?;

        let str_field = |names: &[&str]| -> Result<String, String> {
            for name in names {
                if let Some(v) = obj.get(*name).and_then(|v| v.as_str()) {
                    let s = v.trim().to_string();
                    if !s.is_empty() {
                        return Ok(s);
                    }
                }
            }
            Err(format!("上传凭证缺少 {:?}", names))
        };

        // Fields consumed structurally (not POSTed verbatim as form data).
        const CONSUMED: &[&str] = &[
            "dir", "upload_dir", "host", "upload_host", "expire", "request_id",
            "accessid", "oss_access_key_id", "access_id", "OSSAccessKeyId",
            "signature", "policy",
        ];
        let mut extra: Vec<(String, String)> = Vec::new();
        for (k, v) in obj {
            if CONSUMED.contains(&k.as_str()) {
                continue;
            }
            if let Some(s) = v.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    // OSS PostObject form-field names use hyphens
                    // (x-oss-object-acl), not underscores. Normalize in case
                    // getPolicy returns snake_case — a mismatched field name is
                    // the classic silent 403.
                    let name = k.replace('_', "-");
                    extra.push((name, s.to_string()));
                }
            }
        }

        Ok(Self {
            access_key_id: str_field(&["accessid", "oss_access_key_id", "access_id", "OSSAccessKeyId"])?,
            signature: str_field(&["signature"])?,
            policy: str_field(&["policy"])?,
            upload_dir: str_field(&["dir", "upload_dir"])?,
            upload_host: str_field(&["host", "upload_host"])?,
            extra,
        })
    }

    /// OSS object key for one file: `{upload_dir}/{basename}` (SDK rule).
    fn object_key(&self, file_name: &str) -> String {
        format!("{}/{}", self.upload_dir.trim_end_matches('/'), file_name)
    }

    /// PostObject form fields. `key` is first, then the signed fields, then
    /// every extra policy field (callback/ACL/…) verbatim, then the OSS
    /// success/content-type hints. The file part is appended by the caller.
    fn form_fields(&self, key: &str, content_type: &str) -> Vec<(String, String)> {
        let mut fields = vec![
            ("key".to_string(), key.to_string()),
            ("OSSAccessKeyId".to_string(), self.access_key_id.clone()),
            ("signature".to_string(), self.signature.clone()),
            ("policy".to_string(), self.policy.clone()),
        ];
        for (k, v) in &self.extra {
            fields.push((k.clone(), v.clone()));
        }
        fields.push(("success_action_status".to_string(), "200".to_string()));
        fields.push(("x-oss-content-type".to_string(), content_type.to_string()));
        fields
    }
}

/// Serialize multipart/form-data with trailing file part (hand-rolled: the
/// only crate-free way to satisfy Aliyun OSS PostObject).
#[allow(dead_code)]
fn multipart_body(
    fields: &[(String, String)],
    boundary: &str,
    file_field: &str,
    file_name: &str,
    content_type: &str,
    file_bytes: &[u8],
) -> Vec<u8> {
    let mut body: Vec<u8> = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{file_field}\"; filename=\"{file_name}\"\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(file_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}


/// Blocking DashScope client shared by every call of one ingestion run.
///
/// Transport follows the api_keys probe convention: direct attempt first,
/// one retry through the env proxy when present.
pub(crate) struct AsrClient {
    direct: ureq::Agent,
    via_proxy: Option<ureq::Agent>,
    api_key: String,
    /// Resolved at construction: the dedicated `asr` slot's model or the
    /// real-time Recognition default (`paraformer-realtime-v2`). Drives the
    /// real-time WebSocket path; async Transcription always uses
    /// `TRANSCRIPTION_MODEL` instead.
    model: String,
    /// Active protocol family.
    mode: AsrMode,
    /// Resolved Base URL (DashScope async endpoint, or the OpenAI-compatible
    /// `…/audio/transcriptions`).
    base_url: String,
    /// Optional ffmpeg binary path, used by the WebSocket (real-time) path to
    /// transcode arbitrary audio (AAC/MP4) into raw 16k mono PCM before
    /// streaming. `None` → fall back to `ffmpeg` on PATH / pure-Rust WAV parse.
    ffmpeg_path: Option<PathBuf>,
    /// Active data dir, used to provision / reuse a self-contained embedded
    /// Python runtime for the ASR worker. `None` → use system `python`/`py`.
    data_dir: Option<PathBuf>,
}

impl AsrClient {
    /// Construct a client for one ingestion run. The optional `ffmpeg_path`
    /// is used by the WebSocket real-time path to transcode audio to raw PCM.
    pub(crate) fn with_base_and_ffmpeg(
        api_key: String,
        model: String,
        base_url: Option<String>,
        ffmpeg_path: Option<PathBuf>,
        data_dir: Option<PathBuf>,
    ) -> Result<Self, String> {
        let base_url = base_url
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ASR_BASE.to_string());
        let mode = detect_mode(&base_url);
        Ok(Self {
            direct: api_keys::direct_agent(HTTP_TIMEOUT)?,
            via_proxy: api_keys::proxied_agent(HTTP_TIMEOUT)?,
            api_key,
            model,
            mode,
            base_url,
            ffmpeg_path,
            data_dir,
        })
    }

    /// Run `request` against the direct agent, retrying once via proxy on any
    /// transport-level failure.
    fn with_retry<T>(
        &self,
        request: impl Fn(&ureq::Agent) -> Result<T, String>,
    ) -> Result<T, String> {
        match request(&self.direct) {
            Ok(value) => Ok(value),
            Err(direct_err) => match &self.via_proxy {
                Some(proxy_agent) => request(proxy_agent).map_err(|proxy_err| {
                    format!("{direct_err}；经代理重试仍失败：{proxy_err}")
                }),
                None => Err(direct_err),
            },
        }
    }

    /// GET a body as UTF-8 text with Bearer auth.
    fn get_text(&self, url: &str) -> Result<String, String> {
        self.with_retry(|agent| {
            agent
                .get(url)
                .set("Authorization", &format!("Bearer {}", self.api_key))
                .set("Accept", "application/json; charset=utf-8")
                .call()
                .map_err(|err| format!("请求失败：{err}"))?
                .into_string()
                .map_err(|err| format!("读取响应失败：{err}"))
        })
    }

    /// Submit one transcription task; resolves to its task id.
    fn submit_task(&self, file_url: &str) -> Result<String, String> {
        let url = format!("{}/services/audio/asr/transcription", self.base_url);
        let body = self.with_retry(|agent| {
            // Built per attempt: `send_json` consumes the value and the
            // closure may run twice (direct + proxy retry).
            // Async Transcription must use the dedicated batch model
            // (TRANSCRIPTION_MODEL), never the user's real-time model — the
            // real-time model rejects async batch tasks (mirrors backend
            // asr.transcription_model).
            let payload = serde_json::json!({
                "model": TRANSCRIPTION_MODEL,
                "input": { "file_urls": [file_url] },
                "parameters": { "language_hints": ["zh", "en"] }
            });
            agent
                .post(&url)
                .timeout(UPLOAD_TIMEOUT)
                .set("Authorization", &format!("Bearer {}", self.api_key))
                .set("Accept", "application/json; charset=utf-8")
                .set("Content-Type", "application/json")
                .set("X-DashScope-Async", "enable")
                .send_json(payload)
                .map_err(|err| format!("提交转写任务失败：{err}"))?
                .into_string()
                .map_err(|err| format!("读取提交响应失败：{err}"))
        })?;
        parse_submit_task_id(&body)
    }

    /// Poll one task once.
    fn poll_once(&self, task_id: &str) -> Result<TaskState, String> {
        let url = format!("{}/tasks/{task_id}", self.base_url);
        let body = self.get_text(&url)?;
        parse_task_state(&body)
    }

    /// Fetch + join the transcription JSON behind a SUCCEEDED task.
    fn fetch_result(&self, transcription_url: &str) -> Result<String, String> {
        let body = self.get_text(transcription_url)?;
        parse_transcription_text(&body)
    }

    /// Transcribe a source that is either a reachable remote URL or an
    /// `oss://` link. DashScope mode hands the URL to the provider; in
    /// OpenAI-compatible mode the bytes are downloaded here and posted.
    pub(crate) fn transcribe_url(
        &self,
        file_url: &str,
        deadline: Duration,
        on_wait: &mut dyn FnMut(u64),
        on_stage: &StageLog,
    ) -> Result<String, String> {
        if self.mode == AsrMode::DashScope {
            return self.transcribe_dashscope_url(file_url, deadline, on_wait, on_stage);
        }
        // OpenAI-compatible / WebSocket: fetch the remote bytes first, then
        // POST (REST) or stream (WS).
        on_wait(0);
        let bytes = self.download_bytes(file_url)?;
        let file_name = file_url
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("audio.m4a")
            .to_string();
        let content_type = guess_audio_mime(&file_name);
        if self.mode == AsrMode::WebSocket {
            return self.transcribe_websocket(&bytes, content_type, on_stage);
        }
        self.transcribe_bytes(&bytes, &file_name, content_type)
    }

    /// DashScope async path for a remote/oss URL.
    fn transcribe_dashscope_url(
        &self,
        file_url: &str,
        deadline: Duration,
        on_wait: &mut dyn FnMut(u64),
        on_stage: &StageLog,
    ) -> Result<String, String> {
        let task_id = self.submit_task(file_url)?;
        on_stage(&format!("异步转写任务已提交：{task_id}"));
        let started = Instant::now();
        loop {
            let elapsed = started.elapsed().as_secs();
            on_wait(elapsed);
            if started.elapsed() > deadline {
                on_stage("异步转写任务超时");
                return Err("转写任务超时".to_string());
            }
            std::thread::sleep(POLL_INTERVAL);
            match self.poll_once(&task_id)? {
                TaskState::Pending | TaskState::Running => continue,
                TaskState::Succeeded => {
                    on_stage("异步转写任务成功，获取结果");
                    let body = self.get_text(&format!("{}/tasks/{task_id}", self.base_url))?;
                    if let Ok(text) = parse_transcription_text(&body) {
                        return Ok(text);
                    }
                    match parse_transcription_url(&body) {
                        Ok(result_url) => match self.fetch_result(&result_url) {
                            Ok(text) => return Ok(text),
                            Err(err) => {
                                on_stage(&format!("结果文件解析失败：{err}"));
                                return Err(err);
                            }
                        },
                        Err(url_err) => {
                            let snippet: String = body.chars().take(300).collect();
                            on_stage(&format!(
                                "任务成功但无内联文本、也无 transcription_url（{url_err}）响应={snippet}"
                            ));
                            return Err("转写结果为空".to_string());
                        }
                    }
                }
                TaskState::Failed(message) => {
                    on_stage(&format!("异步转写任务失败：{message}"));
                    return Err(format!("转写失败：{message}"));
                }
            }
        }
    }

    /// Download a remote file into memory (OpenAI-compatible path).
    fn download_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        use std::io::Read;
        self.with_retry(|agent| {
            let mut bytes: Vec<u8> = Vec::new();
            agent
                .get(url)
                .timeout(UPLOAD_TIMEOUT)
                .call()
                .map_err(|err| format!("下载音频失败：{err}"))?
                .into_reader()
                .take(256 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|err| format!("读取音频字节失败：{err}"))?;
            Ok(bytes)
        })
    }

    /// POST audio bytes to an OpenAI-compatible `{base}/audio/transcriptions`
    /// endpoint and return the joined transcript text.
    fn transcribe_bytes(
        &self,
        bytes: &[u8],
        file_name: &str,
        content_type: &str,
    ) -> Result<String, String> {
        let endpoint = openai_transcribe_endpoint(&self.base_url);
        const BOUNDARY: &str = "----MindBaseAudioBoundary4f2a8c9d";
        let mut body: Vec<u8> = Vec::new();

        // model field (plain form field before the file part).
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
        body.extend_from_slice(self.model.as_bytes());
        body.extend_from_slice(b"\r\n");

        // response_format hint.
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"response_format\"\r\n\r\n");
        body.extend_from_slice(b"json");
        body.extend_from_slice(b"\r\n");

        // file part, last.
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

        let value = self.post_audio(&body, &endpoint, &BOUNDARY)?;

        // OpenAI-compatible returns {"text": "…"} on success.
        let text = value
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if text.is_empty() {
            let hint = value.get("error").map(|e| e.to_string()).unwrap_or_default();
            return Err(format!("转写结果为空（{hint}）"));
        }
        Ok(text)
    }

    /// POST a fully-serialized multipart body to an endpoint and parse the
    /// JSON response. Any transport/HTTP failure or provider `error` object
    /// surfaces as `Err`; a well-formed JSON response is returned as `Ok`
    /// even when the transcript is empty (silence/tone).
    fn post_audio(
        &self,
        body: &[u8],
        endpoint: &str,
        boundary: &str,
    ) -> Result<serde_json::Value, String> {
        let response_text = self.with_retry(|agent| {
            agent
                .post(endpoint)
                .timeout(UPLOAD_TIMEOUT)
                .set("Authorization", &format!("Bearer {}", self.api_key))
                .set("Accept", "application/json")
                .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
                .send_bytes(body)
                .map_err(|err| format!("转写请求失败：{err}"))?
                .into_string()
                .map_err(|err| format!("读取转写响应失败：{err}"))
        })?;

        let value: serde_json::Value = serde_json::from_str(&response_text)
            .map_err(|err| format!("解析转写响应失败：{err}（{response_text}）"))?;
        if let Some(err) = value.get("error") {
            return Err(format!("提供方返回错误：{err}"));
        }
        Ok(value)
    }

    /// End-to-end transcription probe: POST a tiny generated WAV through the
    /// configured endpoint + model and report whether the provider accepted
    /// it. A valid 2xx/JSON response counts as success even when the test
    /// audio yields no speech; any provider error is reported. **This makes
    /// one real ASR call and may consume quota/billing.**
    pub(crate) fn probe_transcribe(&self) -> Result<String, String> {
        if self.mode == AsrMode::DashScope {
            // Real end-to-end probe: write a tiny generated WAV to a temp file
            // and route it through `transcribe_local_file`. The 0.5s audio is
            // below the real-time threshold, so it goes through the live
            // DashScope real-time Recognition call — a genuine, billing-
            // consuming ASR probe (mirrors the OpenAI/WebSocket branches).
            let dir = std::env::temp_dir().join("mindbase-desktop");
            std::fs::create_dir_all(&dir)
                .map_err(|err| format!("无法创建临时目录：{err}"))?;
            let path = dir.join(format!("mb-asr-probe-{}.wav", std::process::id()));
            std::fs::write(&path, tiny_wav())
                .map_err(|err| format!("写入测试音频失败：{err}"))?;
            let outcome = self.transcribe_local_file(
                &path,
                Duration::from_secs(90),
                &mut |_| {},
                &noop_stage(),
            );
            let _ = std::fs::remove_file(&path);
            return match outcome {
                Ok(text) if !text.trim().is_empty() => {
                    Ok(format!("转写成功，识别到：{text}"))
                }
                Ok(_) => Ok("转写请求已被接受（测试音频无语音内容）".to_string()),
                Err(err) => Err(err),
            };
        }
        if self.mode == AsrMode::WebSocket {
            let wav = tiny_wav();
            return match self.transcribe_websocket(&wav, "audio/wav", &noop_stage()) {
                Ok(text) if !text.trim().is_empty() => Ok(format!("转写成功，识别到：{text}")),
                Ok(_) => Ok("转写请求已被接受（测试音频无语音内容）".to_string()),
                Err(err) => Err(err),
            };
        }
        let wav = tiny_wav();
        let endpoint = openai_transcribe_endpoint(&self.base_url);
        const BOUNDARY: &str = "----MindBaseProbeBoundary7d1e9a2c";
        let mut body: Vec<u8> = Vec::new();
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
        body.extend_from_slice(self.model.as_bytes());
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"file\"; filename=\"probe.wav\"\r\n");
        body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
        body.extend_from_slice(&wav);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

        let value = self.post_audio(&body, &endpoint, &BOUNDARY)?;
        let text = value
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        Ok(if text.is_empty() {
            "转写请求已被接受（测试音频无语音内容）".to_string()
        } else {
            format!("转写成功，识别到：{text}")
        })
    }

    /// Stream audio through a WebSocket ASR endpoint (DashScope `api-ws`
    /// real-time recognition). `bytes` is the whole local audio (WAV/PCM at
    /// the configured sample rate). Because ingestion runs on a blocking
    /// thread, this spins up a short-lived tokio runtime internally.
    ///
    /// The real-time API hangs on multi-minute audio, so — mirroring the
    /// backend's `_transcribe_local_chunked` — audio longer than
    /// [`REALTIME_CHUNK_SECONDS`] is split into timed PCM chunks and each
    /// chunk is recognized over its own session, concatenating the results.
    fn transcribe_websocket(
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
                            if value
                                .pointer("/header/action")
                                .and_then(|a| a.as_str())
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

    /// Normalize arbitrary input audio into raw 16-bit mono 16 kHz PCM, the
    /// only format the DashScope real-time ASR endpoint accepts.
    ///
    /// A WAV that is already 16k mono 16-bit is decoded in-process (no ffmpeg
    /// needed); anything else is transcoded with ffmpeg (configured path, else
    /// `ffmpeg` on PATH). Without ffmpeg and with a non-conforming container a
    /// clear, actionable error is returned.
    fn to_pcm_bytes(
        &self,
        bytes: &[u8],
        content_type: &str,
        on_stage: &StageLog,
    ) -> Result<Vec<u8>, String> {
        if let Some(pcm) = extract_wav_pcm(bytes) {
            return Ok(pcm);
        }
        let ext = match content_type {
            "audio/wav" => "wav",
            "audio/mpeg" => "mp3",
            "audio/mp4" => "m4a",
            _ => "bin",
        };
        on_stage(&format!("ffmpeg 转码 {ext} → 16k PCM"));
        self.transcode_with_ffmpeg(bytes, ext)
    }

    /// Run ffmpeg to decode `bytes` into raw 16k mono 16-bit PCM.
    fn transcode_with_ffmpeg(&self, bytes: &[u8], ext: &str) -> Result<Vec<u8>, String> {
        let program = match &self.ffmpeg_path {
            Some(path) => path.as_os_str().to_owned(),
            None => std::ffi::OsString::from("ffmpeg"),
        };

        let tag = format!(
            "mb-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let dir = std::env::temp_dir().join("mindbase-desktop");
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("无法创建临时目录 {}：{err}", dir.display()))?;
        let input = dir.join(format!("{tag}.{ext}"));
        let output = dir.join(format!("{tag}.pcm"));

        let mut file = std::fs::File::create(&input)
            .map_err(|err| format!("创建临时音频失败：{err}"))?;
        file.write_all(bytes)
            .map_err(|err| format!("写入临时音频失败：{err}"))?;
        drop(file);

        let result = (|| -> Result<(), String> {
            #[cfg(windows)]
            let mut cmd = {
                use std::os::windows::process::CommandExt;
                let mut c = StdCommand::new(&program);
                c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                c
            };
            #[cfg(not(windows))]
            let mut cmd = StdCommand::new(&program);

            let status = cmd
                .arg("-y")
                .arg("-i")
                .arg(&input)
                .arg("-f")
                .arg("s16le")
                .arg("-ar")
                .arg("16000")
                .arg("-ac")
                .arg("1")
                .arg("-vn")
                .arg(&output)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .status()
                .map_err(|err| {
                    format!(
                        "无法运行 ffmpeg（{}，{err}）；请安装 ffmpeg 并在「API 设置」或系统 PATH 中提供，以将音频转为实时 ASR 所需的 PCM",
                        program.to_string_lossy()
                    )
                })?;
            if !status.success() {
                return Err("ffmpeg 转换失败（音频无法解码为 PCM）".to_string());
            }
            Ok(())
        })();

        // Always clean up the intermediate input file.
        let _ = std::fs::remove_file(&input);
        match result {
            Ok(()) => match std::fs::read(&output) {
                Ok(pcm) => {
                    let _ = std::fs::remove_file(&output);
                    if pcm.is_empty() {
                        Err("ffmpeg 转换结果为空".to_string())
                    } else {
                        Ok(pcm)
                    }
                }
                Err(err) => {
                    let _ = std::fs::remove_file(&output);
                    Err(format!("读取转换结果失败：{err}"))
                }
            },
            Err(err) => {
                let _ = std::fs::remove_file(&output);
                Err(err)
            }
        }
    }

    /// Upload a local file to DashScope's temporary OSS; returns `oss://` URI.
    #[allow(dead_code)]
    pub(crate) fn upload_to_temp_oss(&self, path: &Path) -> Result<String, String> {
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or("临时音频路径无效")?;
        let file_bytes = std::fs::read(path).map_err(|err| format!("读取临时音频失败：{err}"))?;

        // 1. Fetch an upload certificate scoped to the async transcription
        //    model (the upload feeds the async task, not real-time recognition).
        let cert_url = format!(
            "{}/uploads?action=getPolicy&model={}",
            self.base_url, TRANSCRIPTION_MODEL
        );
        let cert_body = self.get_text(&cert_url)?;
        let cert = UploadCertificate::parse(&cert_body)?;

        // 2. Multipart POST; OSS answers 200 (per success_action_status).
        let key = cert.object_key(&file_name);
        let content_type = guess_audio_mime(&file_name);
        let fields = cert.form_fields(&key, content_type);
        const BOUNDARY: &str = "----MindBaseFormBoundary9c1b71e6a2";
        let body = multipart_body(
            &fields,
            BOUNDARY,
            "file",
            &file_name,
            content_type,
            &file_bytes,
        );

        self.with_retry(|agent| {
            let response = agent
                .post(&cert.upload_host)
                .timeout(UPLOAD_TIMEOUT)
                .set("Accept", "application/json")
                .set(
                    "Content-Type",
                    &format!("multipart/form-data; boundary={BOUNDARY}"),
                )
                .send_bytes(&body)
                .map_err(|err| match err {
                    // OSS returns a 4xx with an XML body naming the real
                    // cause (AccessDenied / CallbackFailed / …). Surface it so
                    // the exact failure is visible instead of a bare "403".
                    ureq::Error::Status(code, resp) => {
                        let resp_body = resp.into_string().unwrap_or_default();
                        let snippet: String = resp_body.chars().take(300).collect();
                        format!("上传音频到临时存储失败：HTTP {code}：{snippet}")
                    }
                    other => format!("上传音频到临时存储失败：{other}"),
                })?;
            let resp_body = response.into_string().unwrap_or_default();
            // OSS may answer 200 but still carry an XML <Error> (e.g. a
            // missing/invalid callback). Fail loudly instead of treating the
            // upload as successful and later reporting "转写结果为空".
            if resp_body.contains("<Error") {
                let snippet: String = resp_body.chars().take(200).collect();
                return Err(format!("OSS 上传返回错误：{snippet}"));
            }
            Ok(())
        })?;

        Ok(format!("oss://{key}"))
    }

    /// Read a local audio file into memory along with its content type.
    fn read_local_audio(&self, path: &Path) -> Result<(Vec<u8>, &'static str), String> {
        let bytes = std::fs::read(path).map_err(|err| format!("读取临时音频失败：{err}"))?;
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "audio.m4a".to_string());
        Ok((bytes, guess_audio_mime(&file_name)))
    }

    /// The configured ffmpeg binary path (for extracting audio from a video
    /// when the separate DASH audio stream can't be downloaded). `None` when
    /// no binary was resolved — callers fall back to `ffmpeg` on PATH.
    pub(crate) fn ffmpeg_bin(&self) -> Option<&Path> {
        self.ffmpeg_path.as_deref()
    }

    /// DashScope local-file path. The audio is transcoded to a 16k mono WAV
    /// (B站 serves `.m4s`, which DashScope's `paraformer-v2` often can't
    /// decode directly), then transcribed by scheduling the Python ASR worker
    /// (`scripts/asr_dashscope.py`). The Python worker mirrors the verified
    /// backend logic and uses the official dashscope SDK to upload — which the
    /// hand-rolled Rust OSS upload kept failing with 403. The real-time
    /// WebSocket Recognition path is used only as a last-resort fallback.
    fn transcribe_dashscope_local(
        &self,
        path: &Path,
        deadline: Duration,
        _on_wait: &mut dyn FnMut(u64),
        on_stage: &StageLog,
    ) -> Result<String, String> {
        // 1. Transcode to a 16k mono WAV (reliable for DashScope), then let
        //    the Python worker upload via the official SDK and transcribe.
        let wav_path = self.transcode_to_wav_file(path, on_stage)?;
        let result = self.transcribe_via_python(&wav_path, deadline, on_stage);
        let _ = std::fs::remove_file(&wav_path);
        match result {
            Ok(text) if !text.trim().is_empty() => return Ok(text),
            Ok(_) => on_stage("Python ASR 转写结果为空"),
            Err(err) => on_stage(&format!("Python ASR 失败：{err}")),
        }

        // 2. Fallback: real-time Recognition over the WebSocket (timed PCM
        //    chunks). Long-form B站 audio rarely succeeds here, but it is a
        //    last resort rather than a primary path.
        on_stage("回退到实时 Recognition");
        let (bytes, content_type) = self.read_local_audio(path)?;
        self.transcribe_websocket(&bytes, content_type, on_stage)
    }

    /// Transcribe a local audio file by scheduling the Python ASR worker
    /// (`scripts/asr_dashscope.py`), which mirrors the verified backend logic
    /// and uses the official dashscope SDK to upload (fixes the hand-rolled
    /// Rust OSS 403). Returns the transcript text.
    fn transcribe_via_python(
        &self,
        file_path: &Path,
        deadline: Duration,
        on_stage: &StageLog,
    ) -> Result<String, String> {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("scripts")
            .join("asr_dashscope.py");
        if !script.exists() {
            return Err(format!("找不到 ASR 脚本：{}", script.display()));
        }
        on_stage("调用 Python ASR 脚本（官方 SDK 上传 + 异步转写）");
        let timeout_secs = deadline.as_secs();
        crate::logging::info(
            "asr",
            &format!(
                "calling python ASR worker script={} file={} bytes={} model={}",
                script.display(),
                file_path.display(),
                std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0),
                TRANSCRIPTION_MODEL
            ),
        );

        // Prefer the self-contained embedded Python (provisioned under the
        // data dir on first use), falling back to system `python`/`py`.
        let mut commands: Vec<std::ffi::OsString> = Vec::new();
        if let Some(dir) = &self.data_dir {
            match crate::python_runtime::ensure_python(dir, on_stage) {
                Ok(exe) => commands.push(exe.into_os_string()),
                Err(err) => {
                    crate::logging::warn(
                        "asr",
                        &format!("embedded python unavailable, using system python: {err}"),
                    );
                    commands.push(std::ffi::OsString::from("python"));
                    commands.push(std::ffi::OsString::from("py"));
                }
            }
        } else {
            commands.push(std::ffi::OsString::from("python"));
            commands.push(std::ffi::OsString::from("py"));
        }
        let mut last_err: Option<String> = None;
        for interpreter in commands.drain(..) {
            crate::logging::info(
                "asr",
                &format!("运行 Python ASR worker：{}", interpreter.to_string_lossy()),
            );
            let mut child = match StdCommand::new(&interpreter)
                // Force UTF-8 on Python's stdout/stderr so non-ASCII (Chinese)
                // output is read cleanly instead of as mojibake.
                .env("PYTHONIOENCODING", "utf-8")
                .arg(&script)
                .arg("--file")
                .arg(file_path)
                .arg("--api-key")
                .arg(&self.api_key)
                .arg("--base-url")
                .arg(&self.base_url)
                .arg("--model")
                .arg(TRANSCRIPTION_MODEL)
                .arg("--timeout")
                .arg(timeout_secs.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(err) => {
                    last_err = Some(format!(
                        "无法运行 {}（{err}），请确认已安装 Python 和 dashscope 包",
                        interpreter.to_string_lossy()
                    ));
                    continue;
                }
            };

            // Stream the worker's stderr (progress lines) into the log in real
            // time so a long transcription is visibly progressing.
            {
                use std::io::BufRead;
                if let Some(stderr) = child.stderr.take() {
                    let reader = std::io::BufReader::new(stderr);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            let line = line.trim().to_string();
                            if !line.is_empty() {
                                crate::logging::info("asr-python", &line);
                            }
                        }
                    }
                }
            }

            let mut stdout_text = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                use std::io::Read;
                let _ = stdout.read_to_string(&mut stdout_text);
            }
            let status = child
                .wait()
                .map_err(|err| format!("等待 Python ASR 脚本结束失败：{err}"))?;
            if status.success() {
                let text = stdout_text.trim().to_string();
                if text.is_empty() {
                    crate::logging::error("asr", "python ASR returned empty transcript");
                    return Err("转写结果为空".to_string());
                }
                crate::logging::info(
                    "asr",
                    &format!("python ASR ok text_len={}", text.chars().count()),
                );
                return Ok(text);
            }
            crate::logging::error(
                "asr",
                &format!(
                    "python ASR failed interpreter={} status={}",
                    interpreter.to_string_lossy(),
                    status
                ),
            );
            last_err = Some(format!(
                "Python ASR 脚本失败（退出码 {status}），详见上方 asr-python 日志"
            ));
        }
        Err(last_err.unwrap_or_else(|| "Python ASR 脚本执行失败".to_string()))
    }

    /// Transcode an arbitrary audio file to a 16k mono WAV, which DashScope's
    /// async Transcription reliably decodes (mirrors the backend's
    /// `_transcode_audio_to_wav`). Returns the output WAV path.
    fn transcode_to_wav_file(&self, input: &Path, on_stage: &StageLog) -> Result<PathBuf, String> {
        let program = match &self.ffmpeg_path {
            Some(path) => path.as_os_str().to_owned(),
            None => std::ffi::OsString::from("ffmpeg"),
        };
        on_stage("ffmpeg 转码音频 → 16k 单声道 WAV");
        let dir = std::env::temp_dir().join("mindbase-desktop");
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("无法创建临时目录 {}：{err}", dir.display()))?;
        let tag = format!(
            "mb-wav-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let out = dir.join(format!("{tag}.wav"));

        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = StdCommand::new(&program);
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            c
        };
        #[cfg(not(windows))]
        let mut cmd = StdCommand::new(&program);

        let status = cmd
            .arg("-y")
            .arg("-i")
            .arg(input)
            .arg("-vn")
            .arg("-ac")
            .arg("1")
            .arg("-ar")
            .arg("16000")
            .arg(&out)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|err| {
                format!(
                    "无法运行 ffmpeg（{}，{err}）以转码音频；请安装 ffmpeg 并在「API 设置」或系统 PATH 中提供",
                    program.to_string_lossy()
                )
            })?;
        if !status.success() {
            return Err("ffmpeg 转码音频失败（无法解码为 16k WAV）".to_string());
        }
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or_default();
        if size < 1024 {
            let _ = std::fs::remove_file(&out);
            return Err("ffmpeg 转码输出无效（过小）".to_string());
        }
        Ok(out)
    }

    /// Transcribe a local audio file, routing by mode:
    ///
    /// * **DashScope** — duration-routed via [`Self::transcribe_dashscope_local`]
    ///   (short → sync Recognition, long → async Transcription with a PCM
    ///   chunk fallback), mirroring the backend `transcribe_local_file`.
    /// * **WebSocket** — stream the raw bytes through the real-time endpoint.
    /// * **OpenAI-compatible** — read the bytes and POST them directly.
    pub(crate) fn transcribe_local_file(
        &self,
        path: &Path,
        deadline: Duration,
        on_wait: &mut dyn FnMut(u64),
        on_stage: &StageLog,
    ) -> Result<String, String> {
        if self.mode == AsrMode::DashScope {
            return self.transcribe_dashscope_local(path, deadline, on_wait, on_stage);
        }
        on_wait(0);
        let (bytes, content_type) = self.read_local_audio(path)?;
        if self.mode == AsrMode::WebSocket {
            return self.transcribe_websocket(&bytes, content_type, on_stage);
        }
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "audio.m4a".to_string());
        self.transcribe_bytes(&bytes, &file_name, content_type)
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
            parameter: Some(serde_json::json!({ "input": { "format": "pcm", "sample_rate": 16000 } })),
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

/// Minimal mime guess for the audio containers B站 serves (.m4s/.m4a/mp4…).
fn guess_audio_mime(file_name: &str) -> &'static str {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".m4s") || lower.ends_with(".m4a") || lower.ends_with(".mp4") {
        "audio/mp4"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else {
        "application/octet-stream"
    }
}

/// Append the OpenAI-compatible transcription resource to a Base URL without
/// doubling it — a Base URL may already end in `/audio/transcriptions` (e.g.
/// a user pastes the full endpoint), or be a bare `…/v1` root.
fn openai_transcribe_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/audio/transcriptions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/audio/transcriptions")
    }
}

/// Extract raw PCM from a WAV container when it is already 16-bit, mono,
/// 16 kHz — the shape the real-time ASR endpoint expects — so no ffmpeg call
/// is needed for the common probe / hand-prepared case. Returns `None` when
/// the buffer is not a WAV, or when it needs resampling (→ ffmpeg).
fn extract_wav_pcm(bytes: &[u8]) -> Option<Vec<u8>> {
    // Minimal RIFF/WAVE validation.
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (audio_format, channels, rate, bits)
    let mut data: Option<&[u8]> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let body = offset + 8;
        match id {
            b"fmt " => {
                if body + 16 <= bytes.len() {
                    let audio_format = u16::from_le_bytes(bytes[body..body + 2].try_into().ok()?);
                    let channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().ok()?);
                    let rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().ok()?);
                    let bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().ok()?);
                    fmt = Some((audio_format, channels, rate, bits));
                }
            }
            b"data" => {
                let end = body + size;
                if end <= bytes.len() {
                    data = Some(&bytes[body..end]);
                }
            }
            _ => {}
        }
        // Chunks are 2-byte aligned.
        offset = body + size + (size & 1);
    }
    let (audio_format, channels, rate, bits) = fmt?;
    if audio_format != 1 || channels != 1 || rate != 16_000 || bits != 16 {
        return None;
    }
    data.map(|d| d.to_vec())
}

/// Best-effort extraction of transcript text from a result frame, tolerant of
/// the many field shapes different real-time ASR models use. It walks the
/// frame and collects non-empty strings found under transcript-like keys
/// (`text`, `transcript`, `sentence`, …) and under structural containers
/// (`payload`, `result`, `sentence`, `transcripts`, `output`).
fn collect_transcript(value: &serde_json::Value, texts: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => {
            let s = s.trim();
            if !s.is_empty() {
                texts.push(s.to_string());
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if is_transcript_key(k) || is_transcript_container(k) {
                    collect_transcript(v, texts);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_transcript(item, texts);
            }
        }
        _ => {}
    }
}

/// Keys whose string value is directly the recognized text.
fn is_transcript_key(k: &str) -> bool {
    matches!(
        k,
        "text" | "transcript" | "sentence" | "content" | "asr_output" | "recognition_result"
    )
}

/// Structural keys to descend into (they may hold `text` deeper down).
fn is_transcript_container(k: &str) -> bool {
    matches!(
        k,
        "payload" | "result" | "results" | "sentence" | "sentences" | "transcripts" | "output"
    )
}

/// Build a short mono 16-bit PCM WAV (a soft 440Hz tone) used as a cheap
/// provider-acceptable payload for the end-to-end ASR probe. A tone is used
/// instead of pure silence so some ASR models don't reject it outright.
fn tiny_wav() -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16_000;
    const DURATION_SECS: f32 = 0.5;
    const FREQ: f32 = 440.0;
    let sample_count = (SAMPLE_RATE as f32 * DURATION_SECS) as usize;
    let data_len = sample_count * 2;

    let mut wav = Vec::with_capacity(44 + data_len);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    for i in 0..sample_count {
        let t = i as f32 / SAMPLE_RATE as f32;
        let sample = (0.3 * (2.0 * std::f32::consts::PI * FREQ * t).sin() * 32767.0) as i16;
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_detection_split_by_host() {
        assert_eq!(
            detect_mode("https://dashscope.aliyuncs.com/api/v1"),
            AsrMode::DashScope
        );
        assert_eq!(
            detect_mode("https://openrouter.ai/api/v1/audio/transcriptions"),
            AsrMode::OpenAICompatible
        );
        assert_eq!(detect_mode("http://127.0.0.1:8000/v1"), AsrMode::OpenAICompatible);
    }

    #[test]
    fn tiny_wav_is_a_valid_pcm_header_with_payload() {
        let wav = tiny_wav();
        assert!(wav.len() > 44);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        // Mono 16-bit 16kHz: byte rate 32000, block align 2, bits 16.
        assert_eq!(&wav[24..28], &16_000u32.to_le_bytes());
        assert_eq!(&wav[28..32], &32_000u32.to_le_bytes());
        assert_eq!(&wav[32..34], &2u16.to_le_bytes());
        assert_eq!(&wav[34..36], &16u16.to_le_bytes());
        assert_eq!(&wav[36..40], b"data");
    }

    #[test]
    fn submit_task_id_found_in_both_shapes() {
        assert_eq!(
            parse_submit_task_id(r#"{"task_id": "abc-123"}"#).unwrap(),
            "abc-123"
        );
        assert_eq!(
            parse_submit_task_id(r#"{"output": {"task_id": "xyz"}}"#).unwrap(),
            "xyz"
        );
        assert!(parse_submit_task_id(r#"{"code": "InvalidApiKey"}"#).is_err());
    }

    #[test]
    fn task_state_mapping_covers_statuses() {
        let running = parse_task_state(r#"{"output": {"task_status": "RUNNING"}}"#).unwrap();
        assert_eq!(running, TaskState::Running);
        let pending = parse_task_state(r#"{"output": {"task_status": "PENDING"}}"#).unwrap();
        assert_eq!(pending, TaskState::Pending);
        let failed = parse_task_state(
            r#"{"output": {"task_status": "FAILED", "message": "bad audio"}}"#,
        )
        .unwrap();
        assert_eq!(failed, TaskState::Failed("bad audio".into()));
        // Unknown status keeps waiting rather than aborting.
        let weird = parse_task_state(r#"{"output": {"task_status": "???"}}"#).unwrap();
        assert_eq!(weird, TaskState::Pending);
    }

    #[test]
    fn transcription_url_extracted_from_results() {
        let body = r#"{
            "output": { "task_status": "SUCCEEDED",
                        "results": [ { "subtask_status": "SUCCEEDED",
                                       "transcription_url": "https://result/1.json" } ] }
        }"#;
        assert_eq!(
            parse_transcription_url(body).unwrap(),
            "https://result/1.json"
        );
        assert!(parse_transcription_url(r#"{"output": {"task_status": "SUCCEEDED"}}"#).is_err());
    }

    #[test]
    fn transcription_text_prefers_transcripts_then_sentences_then_top_level() {
        let transcripts = r#"{
            "transcripts": [
                { "text": "第一段", "sentences": [ {"text": "不应出现"} ] },
                { "text": "", "sentences": [ {"text": "句子一"}, {"text": "句子二"} ] }
            ]
        }"#;
        assert_eq!(
            parse_transcription_text(transcripts).unwrap(),
            "第一段\n句子一\n句子二"
        );
        let top_level = r#"{"text": "整体文本"}"#;
        assert_eq!(parse_transcription_text(top_level).unwrap(), "整体文本");
        assert!(parse_transcription_text(r#"{"transcripts": []}"#).is_err());
    }

    #[test]
    fn transcription_text_handles_wrapped_output_envelope() {
        // DashScope sometimes wraps the transcript under `output.results[]` —
        // a strict top-level `transcripts` scan would miss this and report
        // "转写结果为空" even though audio was recognized.
        let wrapped = r#"{
            "request_id": "req",
            "output": {
                "task_status": "SUCCEEDED",
                "results": [
                    {
                        "subtask_status": "SUCCEEDED",
                        "transcripts": [ { "text": "嵌套输出里的识别文本" } ]
                    }
                ]
            }
        }"#;
        assert_eq!(
            parse_transcription_text(wrapped).unwrap(),
            "嵌套输出里的识别文本"
        );

        // Plain `output.transcripts` (no results array) is handled too.
        let output_transcripts = r#"{
            "output": { "transcripts": [ { "text": "直接输出包裹" } ] }
        }"#;
        assert_eq!(
            parse_transcription_text(output_transcripts).unwrap(),
            "直接输出包裹"
        );
    }

    #[test]
    fn certificate_parse_and_form_fields_match_sdk_order() {
        let body = r#"{
            "request_id": "req",
            "output": {
                "oss_access_key_id": "AKID",
                "signature": "sig==",
                "policy": "pol",
                "upload_dir": "dashscope-instant/paraformer/uid",
                "upload_host": "https://bucket.oss.aliyuncs.com",
                "x-oss-object-acl": "private",
                "x-oss-forbid-overwrite": "true"
            }
        }"#;
        let cert = UploadCertificate::parse(body).expect("parse");
        assert_eq!(cert.object_key("a.m4s"), "dashscope-instant/paraformer/uid/a.m4s");

        let key = cert.object_key("a.m4s");
        let fields = cert.form_fields(&key, "audio/mp4");
        let names: Vec<&str> = fields.iter().map(|(name, _)| name.as_str()).collect();
        // `key` is always the first form field (SDK order).
        assert_eq!(names[0], "key");
        for required in [
            "OSSAccessKeyId",
            "signature",
            "policy",
            "success_action_status",
            "x-oss-content-type",
            "x-oss-object-acl",
            "x-oss-forbid-overwrite",
        ] {
            assert!(names.contains(&required), "missing field {required}: {names:?}");
        }
    }

    #[test]
    fn multipart_body_layout_has_file_last() {
        let fields = vec![("policy".to_string(), "pol".to_string()), ("key".to_string(), "k".to_string())];
        let body = multipart_body(&fields, "BND", "file", "a.m4s", "audio/mp4", b"\x00\x01");

        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--BND\r\n"));
        assert!(text.contains("name=\"policy\"\r\n\r\npol\r\n"));
        assert!(text.contains("filename=\"a.m4s\""));
        assert!(text.contains("Content-Type: audio/mp4"));
        assert!(text.ends_with("\r\n--BND--\r\n"));
        // The binary payload sits between headers and the closing delimiter…
        let tail = b"\x00\x01\r\n--BND--\r\n";
        assert!(body.ends_with(tail));
        // …and the file part comes after every plain field.
        let file_pos = text.find("filename=").unwrap();
        let key_pos = text.find("name=\"key\"").unwrap();
        assert!(key_pos < file_pos);
    }

    #[test]
    fn mime_guess_covers_bilibili_containers() {
        assert_eq!(guess_audio_mime("x.m4s"), "audio/mp4");
        assert_eq!(guess_audio_mime("X.M4A"), "audio/mp4");
        assert_eq!(guess_audio_mime("x.mp3"), "audio/mpeg");
        assert_eq!(guess_audio_mime("x.bin"), "application/octet-stream");
    }

    #[test]
    fn wav_pcm_extraction_accepts_16k_mono_and_rejects_others() {
        // tiny_wav() is 16k mono 16-bit → should be extracted without ffmpeg.
        let wav = tiny_wav();
        let pcm = extract_wav_pcm(&wav).expect("16k mono wav extracts");
        // data chunk = samples * 2 bytes; 0.5s @ 16k = 8000 samples.
        assert_eq!(pcm.len(), 8000 * 2);

        // A WAV at a different sample rate needs resampling → None.
        let mut other = wav.clone();
        other[24..28].copy_from_slice(&44_100u32.to_le_bytes());
        assert!(extract_wav_pcm(&other).is_none());

        // Stereo (channels=2) → None (needs downmix).
        let mut stereo = wav.clone();
        stereo[22..24].copy_from_slice(&2u16.to_le_bytes());
        assert!(extract_wav_pcm(&stereo).is_none());

        // Not a WAV at all → None.
        assert!(extract_wav_pcm(b"not a wav").is_none());
    }

    #[test]
    fn transcript_collector_handles_multiple_result_shapes() {
        // Classic sentence path.
        let sentence = serde_json::json!({
            "header": { "action": "run-task" },
            "payload": { "sentence": { "text": "第一句" } }
        });
        let mut texts = Vec::new();
        collect_transcript(&sentence, &mut texts);
        assert_eq!(texts, vec!["第一句"]);

        // Newer result/transcripts path (qwen-audio style).
        let result = serde_json::json!({
            "header": { "action": "run-task" },
            "payload": { "result": { "transcripts": [ { "text": "第一段" }, { "text": "第二段" } ] } }
        });
        texts.clear();
        collect_transcript(&result, &mut texts);
        assert_eq!(texts, vec!["第一段", "第二段"]);

        // A final frame that bundles task-finished with its own text — the
        // frame must be parsed before the break.
        let finished = serde_json::json!({
            "header": { "action": "task-finished", "task_id": "t1" },
            "payload": { "result": { "transcripts": [ { "text": "结尾" } ] } }
        });
        texts.clear();
        collect_transcript(&finished, &mut texts);
        assert_eq!(texts, vec!["结尾"]);

        // Control frames (no transcript text) must not add noise.
        let control = serde_json::json!({
            "header": { "action": "task-finished", "task_id": "t1" }
        });
        texts.clear();
        collect_transcript(&control, &mut texts);
        assert!(texts.is_empty());
    }
}

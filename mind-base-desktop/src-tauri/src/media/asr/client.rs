//! Blocking ASR client: transport, async-task submission/polling and OpenAI-compatible POST.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::llm::api_keys;

use super::config::{detect_mode, DEFAULT_ASR_BASE, TRANSCRIPTION_MODEL};
use super::parse::{
    parse_submit_task_id, parse_task_state, parse_transcription_text, parse_transcription_url,
};
use super::types::{noop_stage, AsrMode, StageLog, TaskState};
use super::wav::{guess_audio_mime, openai_transcribe_endpoint, tiny_wav};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// Blocking DashScope client shared by every call of one ingestion run.
///
/// Transport follows the egress-proxy convention: through the user's proxy
/// when one is configured for the endpoint scheme, one direct fallback retry
/// on transport failures; direct-only when no proxy is configured.
pub(crate) struct AsrClient {
    pub(super) primary: ureq::Agent,
    pub(super) fallback: Option<ureq::Agent>,
    pub(super) api_key: String,
    /// Resolved at construction: the dedicated `asr` slot's model or the
    /// real-time Recognition default (`paraformer-realtime-v2`). Drives the
    /// real-time WebSocket path; async Transcription always uses
    /// `TRANSCRIPTION_MODEL` instead.
    pub(super) model: String,
    /// Active protocol family.
    pub(super) mode: AsrMode,
    /// Resolved Base URL (DashScope async endpoint, or the OpenAI-compatible
    /// `…/audio/transcriptions`).
    pub(super) base_url: String,
    /// Optional ffmpeg binary path, used by the WebSocket (real-time) path to
    /// transcode arbitrary audio (AAC/MP4) into raw 16k mono PCM before
    /// streaming. `None` → fall back to `ffmpeg` on PATH / pure-Rust WAV parse.
    pub(super) ffmpeg_path: Option<PathBuf>,
    /// Active data dir, used to provision / reuse a self-contained embedded
    /// Python runtime for the ASR worker. `None` → use system `python`/`py`.
    pub(super) data_dir: Option<PathBuf>,
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
        let (primary, fallback) = api_keys::egress_agents(HTTP_TIMEOUT, &base_url)?;
        Ok(Self {
            primary,
            fallback,
            api_key,
            model,
            mode,
            base_url,
            ffmpeg_path,
            data_dir,
        })
    }

    /// Run `request` against the primary agent (proxy when configured),
    /// retrying once via the direct fallback on any transport-level failure.
    pub(super) fn with_retry<T>(
        &self,
        request: impl Fn(&ureq::Agent) -> Result<T, String>,
    ) -> Result<T, String> {
        match request(&self.primary) {
            Ok(value) => Ok(value),
            Err(first_err) => match &self.fallback {
                Some(agent) => request(agent)
                    .map_err(|retry_err| format!("{first_err}；回退重试仍失败：{retry_err}")),
                None => Err(first_err),
            },
        }
    }

    /// GET a body as UTF-8 text with Bearer auth.
    pub(super) fn get_text(&self, url: &str) -> Result<String, String> {
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
            format!("Content-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n")
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
            let hint = value
                .get("error")
                .map(|e| e.to_string())
                .unwrap_or_default();
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
                .set(
                    "Content-Type",
                    &format!("multipart/form-data; boundary={boundary}"),
                )
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
            std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建临时目录：{err}"))?;
            let path = dir.join(format!("mb-asr-probe-{}.wav", std::process::id()));
            std::fs::write(&path, tiny_wav()).map_err(|err| format!("写入测试音频失败：{err}"))?;
            let outcome = self.transcribe_local_file(
                &path,
                Duration::from_secs(90),
                &mut |_| {},
                &noop_stage(),
            );
            let _ = std::fs::remove_file(&path);
            return match outcome {
                Ok(text) if !text.trim().is_empty() => Ok(format!("转写成功，识别到：{text}")),
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
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"probe.wav\"\r\n",
        );
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

    /// Read a local audio file into memory along with its content type.
    pub(super) fn read_local_audio(&self, path: &Path) -> Result<(Vec<u8>, &'static str), String> {
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

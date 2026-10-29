//! Local-file DashScope pipeline: Python SDK worker first, real-time WebSocket fallback.

use std::path::Path;
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;

use super::client::AsrClient;
use super::config::TRANSCRIPTION_MODEL;
use super::types::StageLog;

impl AsrClient {
    /// DashScope local-file path. The audio is transcoded to a 16k mono WAV
    /// (B站 serves `.m4s`, which DashScope's `paraformer-v2` often can't
    /// decode directly), then transcribed by scheduling the Python ASR worker
    /// (`scripts/asr_dashscope.py`). The Python worker mirrors the verified
    /// backend logic and uses the official dashscope SDK to upload — which the
    /// hand-rolled Rust OSS upload kept failing with 403. The real-time
    /// WebSocket Recognition path is used only as a last-resort fallback.
    pub(super) fn transcribe_dashscope_local(
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
        crate::infra::logging::info(
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
            match crate::infra::python_runtime::ensure_python(dir, on_stage) {
                Ok(exe) => commands.push(exe.into_os_string()),
                Err(err) => {
                    crate::infra::logging::warn(
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
            crate::infra::logging::info(
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
                                crate::infra::logging::info("asr-python", &line);
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
                    crate::infra::logging::error("asr", "python ASR returned empty transcript");
                    return Err("转写结果为空".to_string());
                }
                crate::infra::logging::info(
                    "asr",
                    &format!("python ASR ok text_len={}", text.chars().count()),
                );
                return Ok(text);
            }
            crate::infra::logging::error(
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
}

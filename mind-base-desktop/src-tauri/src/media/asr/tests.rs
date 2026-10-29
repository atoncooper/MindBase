//! Unit tests for the ASR package (parsers, upload form, WAV helpers, WS frames).

use super::config::detect_mode;
use super::parse::{
    collect_transcript, parse_submit_task_id, parse_task_state, parse_transcription_text,
    parse_transcription_url,
};
use super::types::{AsrMode, TaskState};
use super::upload::{multipart_body, UploadCertificate};
use super::wav::{extract_wav_pcm, guess_audio_mime, tiny_wav};

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
    assert_eq!(
        detect_mode("http://127.0.0.1:8000/v1"),
        AsrMode::OpenAICompatible
    );
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
    let failed =
        parse_task_state(r#"{"output": {"task_status": "FAILED", "message": "bad audio"}}"#)
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
    assert_eq!(
        cert.object_key("a.m4s"),
        "dashscope-instant/paraformer/uid/a.m4s"
    );

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
        assert!(
            names.contains(&required),
            "missing field {required}: {names:?}"
        );
    }
}

#[test]
fn multipart_body_layout_has_file_last() {
    let fields = vec![
        ("policy".to_string(), "pol".to_string()),
        ("key".to_string(), "k".to_string()),
    ];
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

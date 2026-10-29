//! DashScope temp-OSS upload: certificate parsing, PostObject form and the upload call.

use std::path::Path;

use super::client::{AsrClient, UPLOAD_TIMEOUT};
use super::config::TRANSCRIPTION_MODEL;
use super::wav::guess_audio_mime;

/// One upload-certificate payload (fields of DashScope's getPolicy response).
///
/// The official `OssUtils.upload` SDK builds the PostObject from **whatever
/// getPolicy returns** (accessid/host/dir plus callback/ACL/…). We mirror that
/// by keeping the policy fields plus any extra fields verbatim, so a missing
/// `callback` (the classic silent 403) can never happen.
#[allow(dead_code)]
pub(super) struct UploadCertificate {
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
    pub(super) fn parse(body: &str) -> Result<Self, String> {
        let value: serde_json::Value =
            serde_json::from_str(body).map_err(|err| format!("解析上传凭证失败：{err}"))?;
        let info = value
            .get("output")
            .or_else(|| value.get("data"))
            .ok_or("上传凭证响应缺少数据")?;
        let obj = info.as_object().ok_or("上传凭证响应不是对象")?;

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
            "dir",
            "upload_dir",
            "host",
            "upload_host",
            "expire",
            "request_id",
            "accessid",
            "oss_access_key_id",
            "access_id",
            "OSSAccessKeyId",
            "signature",
            "policy",
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
            access_key_id: str_field(&[
                "accessid",
                "oss_access_key_id",
                "access_id",
                "OSSAccessKeyId",
            ])?,
            signature: str_field(&["signature"])?,
            policy: str_field(&["policy"])?,
            upload_dir: str_field(&["dir", "upload_dir"])?,
            upload_host: str_field(&["host", "upload_host"])?,
            extra,
        })
    }

    /// OSS object key for one file: `{upload_dir}/{basename}` (SDK rule).
    pub(super) fn object_key(&self, file_name: &str) -> String {
        format!("{}/{}", self.upload_dir.trim_end_matches('/'), file_name)
    }

    /// PostObject form fields. `key` is first, then the signed fields, then
    /// every extra policy field (callback/ACL/…) verbatim, then the OSS
    /// success/content-type hints. The file part is appended by the caller.
    pub(super) fn form_fields(&self, key: &str, content_type: &str) -> Vec<(String, String)> {
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
pub(super) fn multipart_body(
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

impl AsrClient {
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
}

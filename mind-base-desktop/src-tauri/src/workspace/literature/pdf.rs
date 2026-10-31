//! 文献 PDF 下载：把开放获取 / 直达 PDF 存到项目目录，供本地预览或系统打开。
//!
//! 不绕过付费墙：拿到的不是 PDF（登录页 / 机构订阅页）就返回在线地址，让用户
//! 在浏览器里打开；成功时才落盘到 research/<project>/literature/pdfs/。

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;

use super::store::{get_ref_conn, project_exists, record_event_conn};

const PDF_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PDF_BYTES: usize = 80 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteraturePdf {
    /// 已下载到本地的路径；None = 只能在线预览。
    pub path: Option<String>,
    /// DOI / 出版社 / PDF 的在线地址。
    pub url: String,
    pub message: String,
}

/// 下载一条文献的 PDF（阻塞；调用方负责放到工作线程）。
pub(crate) fn download_conn(
    conn: &Connection,
    data_dir: &Path,
    project_id: &str,
    ref_id: &str,
) -> Result<LiteraturePdf, String> {
    if !project_exists(conn, project_id)? {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    let reference = get_ref_conn(conn, project_id, ref_id)?
        .ok_or_else(|| format!("文献不存在：{ref_id}"))?;
    let url = if reference.url.trim().starts_with("http") {
        reference.url.trim().to_string()
    } else if !reference.doi.trim().is_empty() {
        format!("https://doi.org/{}", reference.doi.trim())
    } else {
        return Err("该文献没有 URL / DOI，无法下载或在线预览".to_string());
    };

    let dir = data_dir
        .join("research")
        .join(project_id)
        .join("literature")
        .join("pdfs");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("创建文献目录失败（{}）：{err}", dir.display()))?;
    let path = dir.join(format!("{ref_id}.pdf"));
    if path.is_file() {
        return Ok(LiteraturePdf {
            path: Some(path.to_string_lossy().to_string()),
            url,
            message: "已下载过，直接打开本地 PDF".to_string(),
        });
    }

    let (primary, fallback) = crate::llm::api_keys::egress_agents(PDF_TIMEOUT, &url)?;
    let attempt = |agent: &ureq::Agent| -> Result<Vec<u8>, String> {
        let response = agent
            .get(&url)
            .set("Accept", "application/pdf,application/octet-stream,*/*")
            .set(
                "User-Agent",
                concat!(
                    "MindBase-Desktop/",
                    env!("CARGO_PKG_VERSION"),
                    " (+https://github.com/atoncooper/MindBase)"
                ),
            )
            .call()
            .map_err(|err| match err {
                ureq::Error::Status(code, _) => format!("HTTP {code}"),
                ureq::Error::Transport(err) => format!("网络错误：{err}"),
            })?;
        let content_type = response
            .header("content-type")
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take((MAX_PDF_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("读取响应失败：{err}"))?;
        if bytes.len() > MAX_PDF_BYTES {
            return Err("PDF 超过 80MB，已放弃下载".to_string());
        }
        let looks_pdf = content_type.contains("pdf") || bytes.starts_with(b"%PDF");
        if !looks_pdf {
            return Err(format!(
                "该链接返回的不是 PDF（{}），可能需要机构订阅或登录",
                if content_type.is_empty() {
                    "未知类型"
                } else {
                    content_type.as_str()
                }
            ));
        }
        Ok(bytes)
    };

    let bytes = match attempt(&primary) {
        Ok(bytes) => bytes,
        Err(first_err) => match &fallback {
            Some(agent) => attempt(agent)
                .map_err(|retry_err| format!("{first_err}；回退重试仍失败：{retry_err}"))?,
            None => return Err(first_err),
        },
    };
    std::fs::write(&path, &bytes)
        .map_err(|err| format!("写入 PDF 失败（{}）：{err}", path.display()))?;
    record_event_conn(
        conn,
        project_id,
        "literature.downloaded",
        &serde_json::json!({"refId": ref_id, "url": url, "bytes": bytes.len()}).to_string(),
    );
    Ok(LiteraturePdf {
        path: Some(path.to_string_lossy().to_string()),
        url,
        message: format!("PDF 已下载（{} KB）", bytes.len() / 1024),
    })
}

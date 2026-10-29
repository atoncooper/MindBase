//! Crossref 联网核验：有 DOI 走精确查询，无 DOI 按标题检索（阻塞 HTTP）。

use std::time::Duration;

use serde_json::Value;

use super::csl::{csl_year, first_string};
use super::types::{CrossrefMeta, VerifyOutcome};
use super::util::{collapse_whitespace, normalize_doi, url_encode};

/// Crossref 请求上限：网络卡住时不能把「核验」按钮一起卡死。
const CROSSREF_TIMEOUT: Duration = Duration::from_secs(15);
const CROSSREF_WORKS: &str = "https://api.crossref.org/works";

// ---------------------------------------------------------------------------
// Crossref 核验
// ---------------------------------------------------------------------------

/// Crossref 要求可识别的 UA（polite pool），否则高峰期容易被限流。
fn build_crossref_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(CROSSREF_TIMEOUT)
        .user_agent("mind-base-desktop/0.1 (+https://github.com/atoncooper/MindBase)")
        .build()
}

/// 阻塞式核验（调用方负责 spawn_blocking）。
///
/// 有 DOI 走 /works/{doi}：200 且标题相似 → 命中；404 → 未找到（missing）；
/// 其它 HTTP 错误或网络错误 → Err（前端提示可重试）。
/// 无 DOI 走 /works?query.title=：在前 5 条里找标题相似的第一条，找不到 → missing。
pub(super) fn verify_blocking(doi: &str, local_title: &str) -> Result<VerifyOutcome, String> {
    let agent = build_crossref_agent();
    let doi = doi.trim();
    let local_title = local_title.trim();

    if !doi.is_empty() {
        let url = format!("{CROSSREF_WORKS}/{}", url_encode(doi, true));
        match agent.get(&url).call() {
            Ok(response) => {
                let payload: Value = response
                    .into_json()
                    .map_err(|err| format!("Crossref 响应解析失败：{err}"))?;
                let item = payload.get("message").cloned().unwrap_or(payload);
                let meta = crossref_meta(&item);
                // 本地标题为空时无法比对，按命中处理（至少能补全元数据）。
                if local_title.is_empty() || titles_match(local_title, &meta.title) {
                    Ok(VerifyOutcome::Verified(meta))
                } else {
                    Ok(VerifyOutcome::Missing)
                }
            }
            Err(ureq::Error::Status(404, _)) => Ok(VerifyOutcome::Missing),
            Err(ureq::Error::Status(code, _)) => {
                Err(format!("Crossref 返回 HTTP {code}，请稍后重试"))
            }
            Err(ureq::Error::Transport(err)) => {
                Err(format!("访问 Crossref 失败：{err}（请检查网络或代理设置）"))
            }
        }
    } else {
        let url = format!(
            "{CROSSREF_WORKS}?query.title={}&rows=5",
            url_encode(local_title, false)
        );
        match agent.get(&url).call() {
            Ok(response) => {
                let payload: Value = response
                    .into_json()
                    .map_err(|err| format!("Crossref 响应解析失败：{err}"))?;
                let items = payload
                    .get("message")
                    .and_then(|message| message.get("items"))
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                for item in items {
                    let meta = crossref_meta(&item);
                    if !meta.title.is_empty() && titles_match(local_title, &meta.title) {
                        return Ok(VerifyOutcome::Verified(meta));
                    }
                }
                Ok(VerifyOutcome::Missing)
            }
            Err(ureq::Error::Status(code, _)) => {
                Err(format!("Crossref 返回 HTTP {code}，请稍后重试"))
            }
            Err(ureq::Error::Transport(err)) => {
                Err(format!("访问 Crossref 失败：{err}（请检查网络或代理设置）"))
            }
        }
    }
}

fn crossref_meta(item: &Value) -> CrossrefMeta {
    CrossrefMeta {
        doi: item
            .get("DOI")
            .and_then(first_string)
            .map(|value| normalize_doi(&value))
            .unwrap_or_default(),
        title: item
            .get("title")
            .and_then(first_string)
            .map(|value| clean_crossref_text(&value))
            .unwrap_or_default(),
        year: csl_year(item),
        venue: item
            .get("container-title")
            .and_then(first_string)
            .map(|value| clean_crossref_text(&value))
            .unwrap_or_default(),
        url: item.get("URL").and_then(first_string).unwrap_or_default(),
    }
}

/// Crossref 标题里可能夹带 JATS/HTML 标签（i/sub 等），导出前剥掉。
fn clean_crossref_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    collapse_whitespace(&out)
}

fn normalize_title(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

/// 标题相似判定：忽略大小写/标点后「相等或包含」（容许副标题、翻译差异）。
/// 过短的标题（少于 8 字符）不参与包含判定，避免 AI 之类的词误命中。
fn titles_match(left: &str, right: &str) -> bool {
    let a = normalize_title(left);
    let b = normalize_title(right);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (shorter, longer) = if a.chars().count() <= b.chars().count() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    shorter.chars().count() >= 8 && longer.contains(shorter.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossref_titles_match_ignoring_case_and_punctuation() {
        assert!(titles_match(
            "A Study of Things: An Introduction",
            "A Study of Things: An Introduction."
        ));
        assert!(titles_match(
            "Attention Is All You Need",
            "attention is all you need"
        ));
        assert!(!titles_match(
            "A Study of Things",
            "Completely Different Paper"
        ));
        assert!(!titles_match("", "Anything"));
    }
}

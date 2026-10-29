//! DTOs shared with the frontend plus parser intermediates (`ParsedRef`, `CrossrefMeta`).

use serde::Serialize;
use serde_json::Value;

pub(super) const STATUS_UNVERIFIED: &str = "unverified";
pub(super) const STATUS_VERIFIED: &str = "verified";
pub(super) const STATUS_MISSING: &str = "missing";

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 一条文献引用（前端表格行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureRef {
    pub id: String,
    pub cite_key: String,
    pub doi: String,
    pub title: String,
    /// JSON 数组文本，例如 ["张三","Li Si"]。
    pub authors_json: String,
    pub year: Option<i64>,
    pub venue: String,
    /// CSL 条目类型（Rust 侧字段名避开关键字 type）。
    #[serde(rename = "type")]
    pub entry_type: String,
    pub url: String,
    /// unverified / verified / missing。
    pub status: String,
    pub note: String,
}

/// 导入结果：imported + skipped + failed = 解析出的条目数（failed 为解析失败条目）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    /// 本次真正写入的行（不含被跳过的重复项）。
    pub refs: Vec<LiteratureRef>,
    /// 逐条失败原因（中文），无失败时为空数组。
    pub errors: Vec<String>,
}

/// 解析器的中间产物：尚未落库的一条引用。
#[derive(Debug, Default, Clone)]
pub(super) struct ParsedRef {
    pub(super) cite_key: String,
    pub(super) doi: String,
    pub(super) title: String,
    pub(super) authors: Vec<String>,
    pub(super) year: Option<i64>,
    pub(super) venue: String,
    pub(super) entry_type: String,
    pub(super) url: String,
    pub(super) csl: Value,
}

/// Crossref 返回的、用于补全本地记录的子集。
#[derive(Debug, Default, Clone)]
pub(super) struct CrossrefMeta {
    pub(super) doi: String,
    pub(super) title: String,
    pub(super) year: Option<i64>,
    pub(super) venue: String,
    pub(super) url: String,
}

/// 核验结果：命中（带回补全字段）/ 未找到（DOI 404 或标题检索无相似命中）。
pub(super) enum VerifyOutcome {
    Verified(CrossrefMeta),
    Missing,
}

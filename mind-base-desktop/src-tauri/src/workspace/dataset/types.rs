//! Webview DTOs for research datasets and analysis runs.

use serde::Serialize;

/// 一行 `datasets` 记录（前端「数据」Tab 的数据集卡片）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetRow {
    pub id: String,
    pub name: String,
    pub path: String,
    /// MD5 摘要（沿用既有列名 sha256，避免改表）。
    pub sha256: String,
    pub rows: Option<i64>,
    pub cols: Option<i64>,
    pub privacy: String,
    /// 列画像 JSON 数组字符串（前端 JSON.parse 后渲染表头）。
    pub schema_json: String,
    /// `dataset_profile.py` 输出的完整 JSON 字符串。
    pub profile_json: String,
    pub created_at: i64,
}

/// `analysis_run` 的执行结果（脚本非 0 退出也算正常返回）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub script_path: String,
}

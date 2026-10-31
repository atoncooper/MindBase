//! 文献证据层（Phase 1）。
//!
//! 负责期刊投稿线的文献条目：BibTeX / CSL-JSON 导入（解析器全部手写，不新增
//! 引用解析类 crate）、Crossref 联网核验、BibTeX 文本导出。数据落在 phase 0 已有
//! 的 `literature_refs` 表上（见 `db.rs` 的 SCHEMA_SQL）。
//!
//! 设计约定：
//! - `type` 列统一存 CSL 条目类型（article-journal / paper-conference / book /
//!   thesis / document 等）：BibTeX 条目类型在导入时映射成 CSL，导出时再映射回去。
//! - `authors_json` 存「显示名」JSON 数组（"Given Family"）；BibTeX 的
//!   "Family, Given" 写法在导入时归一化为 "Given Family"。
//! - `csl_json` 保留原始记录：CSL 导入存用户粘贴的对象；BibTeX 导入存按同样
//!   字段拼出的等效 CSL 对象，保证两种来源下游一致。
//! - Crossref 是阻塞 HTTP（ureq），必须放在 spawn_blocking 里，超时 15s。
//!
//! Module layout:
//! - [`types`] — DTOs (`LiteratureRef`, import result) + parser intermediates.
//! - [`store`] — `literature_refs` / `citations` / `project_events` SQL access.
//! - [`bibtex`] — hand-written BibTeX parser and BibTeX document export.
//! - [`csl`] — CSL-JSON parser and BibTeX→CSL record conversion.
//! - [`crossref`] — blocking Crossref verification (DOI lookup / title search).
//! - [`util`] — text/year/DOI normalization and cite-key generation.
//! - [`commands`] — `#[tauri::command]` wrappers registered in `app/commands.rs`.

mod bibtex;
mod commands;
mod csl;
mod crossref;
mod pdf;
mod store;
mod types;
mod util;

// Kept at this path for existing/future call sites (`crate::workspace::literature::LiteratureRef`);
// nothing outside the package reads it yet, so the re-export would otherwise warn as unused.
#[allow(unused_imports)]
pub use types::{LiteratureImportResult, LiteratureRef};

pub(crate) use commands::{
    literature_delete, literature_download_pdf, literature_export_bibtex, literature_import,
    literature_list, literature_verify,
};

// `#[tauri::command]` emits hidden `__cmd__*` / `__tauri_command_name_*` macros next to each
// command. `app/commands.rs` registers the commands through this module path, so both macros
// have to be re-exported alongside the functions they belong to.
#[doc(hidden)]
pub(crate) use commands::{
    __cmd__literature_delete, __cmd__literature_download_pdf, __cmd__literature_export_bibtex,
    __cmd__literature_import, __cmd__literature_list, __cmd__literature_verify, __tauri_command_name_literature_delete,
    __tauri_command_name_literature_export_bibtex, __tauri_command_name_literature_import,
    __tauri_command_name_literature_download_pdf, __tauri_command_name_literature_list,
    __tauri_command_name_literature_verify,
};

// ---------------------------------------------------------------------------
// Agent / 工具层可用的包内封装（不经过 Tauri State）
// ---------------------------------------------------------------------------

pub(crate) use crossref::SearchHit;
pub(crate) use pdf::LiteraturePdf;
pub(crate) use pdf::download_conn as download_pdf_conn;

pub(crate) fn list_refs(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<Vec<LiteratureRef>, String> {
    if !store::project_exists(conn, project_id)? {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    store::list_refs_conn(conn, project_id)
}

pub(crate) fn import_text(
    conn: &mut rusqlite::Connection,
    project_id: &str,
    format: &str,
    content: &str,
) -> Result<LiteratureImportResult, String> {
    commands::import_text_conn(conn, project_id, format, content)
}

pub(crate) fn export_bibtex(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<String, String> {
    if !store::project_exists(conn, project_id)? {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    bibtex::export_bibtex_conn(conn, project_id)
}

pub(crate) fn search(query: &str, rows: usize) -> Result<Vec<SearchHit>, String> {
    crossref::search_blocking(query, rows)
}

pub(crate) fn verify_ref(
    conn: &rusqlite::Connection,
    project_id: &str,
    ref_id: &str,
) -> Result<LiteratureRef, String> {
    commands::verify_ref_conn(conn, project_id, ref_id)
}

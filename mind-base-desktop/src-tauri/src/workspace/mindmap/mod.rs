//! 知识导图（mind maps）— 手绘思维导图的本地持久层。
//!
//! 每张导图是一行 SQLite：标题 + 整棵树的 JSON 文档（simple-mind-map
//! `getData(true)` 的输出：root / layout / theme / view）。桌面单用户，
//! 保存一律整卡覆盖，不做修订历史。导出的 PNG / SVG / MD 落到共享的
//! `exports/` 目录，自动进入现有生成记录（exports_list）展示与打开。
//!
//! Module layout:
//! - [`types`] — webview DTOs.
//! - [`crud`] — create/list/get/save/rename/delete/export.
//! - [`snapshots`] — version history.
//! - [`templates`] — user templates.
//! - [`icons`] — user icon packs.

mod crud;
mod icons;
mod snapshots;
mod templates;
mod types;

pub(crate) use crud::*;
pub(crate) use icons::*;
pub(crate) use snapshots::*;
pub(crate) use templates::*;
pub(crate) use types::*;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Normalize a user-supplied title: trim, fall back to a default, cap length.
fn normalize_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return "未命名导图".to_string();
    }
    trimmed.chars().take(60).collect()
}

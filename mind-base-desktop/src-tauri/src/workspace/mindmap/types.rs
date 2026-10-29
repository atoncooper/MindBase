//! Webview DTOs for mind maps, snapshots, templates and icon packs.

use serde::{Deserialize, Serialize};

/// One mind map as listed in the library view.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapMeta {
    pub id: String,
    pub title: String,
    /// Object kind: `mindmap`（simple-mind-map 树）或 `whiteboard`（Excalidraw 场景）。
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One mind map in full (editor load).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapDetail {
    pub id: String,
    pub title: String,
    /// Object kind: `mindmap` 或 `whiteboard`（编辑器据此分发渲染）。
    pub kind: String,
    /// Document JSON: 导图树（`{root, layout, theme, view}`）或白板场景
    /// （`{type: "excalidraw", version, elements, appState}`）；空串 = 尚未首次保存。
    pub data: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One snapshot as listed in the history panel (data body excluded).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapSnapshotMeta {
    pub id: String,
    pub map_id: String,
    pub title: String,
    pub data_len: usize,
    pub created_at: i64,
}

/// 一个用户模板（data 为整卡导图 JSON）。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapTemplate {
    pub key: String,
    pub name: String,
    pub data: String,
}

/// One graphic inside a user icon pack (icon = svg 文本或 dataURL/URL)。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapIconPackItem {
    pub name: String,
    pub icon: String,
}

/// A persisted user icon pack.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapIconPack {
    pub key: String,
    pub name: String,
    pub items: Vec<MindMapIconPackItem>,
}

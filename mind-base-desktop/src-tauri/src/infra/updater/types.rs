//! Payload types exchanged between the updater and the webview.

use serde::{Deserialize, Serialize};

/// Update information surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version of the running app, e.g. `"0.1.0"`.
    pub current_version: String,
    /// Latest release version with tag prefixes stripped, e.g. `"0.2.0"`.
    pub latest_version: String,
    /// Whether the latest release is newer than the running app.
    pub has_update: bool,
    /// HTML page of the latest release on GitHub; empty when the API returned
    /// a URL outside `https://github.com/` (the frontend then hides the
    /// download action).
    pub release_url: String,
    /// Release notes body; `None` when the release has none.
    pub release_notes: Option<String>,
    /// ISO 8601 publish timestamp; `None` when the API omits it.
    pub published_at: Option<String>,
}

/// One downloadable file attached to a release.
#[derive(Debug, Clone, Deserialize)]
pub struct GithubAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

/// Subset of the GitHub `/releases/latest` payload we consume.
#[derive(Debug, Deserialize)]
pub(super) struct GithubRelease {
    pub(super) tag_name: String,
    pub(super) html_url: String,
    pub(super) body: Option<String>,
    pub(super) published_at: Option<String>,
    #[serde(default)]
    pub(super) assets: Vec<GithubAsset>,
}

/// Progress pushed to the frontend while an installer downloads.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateDownloadEvent {
    Start {
        total_bytes: u64,
    },
    /// Heartbeat with running totals (throttled to ~4 per second).
    Progress {
        received: u64,
        total_bytes: u64,
    },
    Done {
        path: String,
        bytes: u64,
    },
}

/// Outcome of one installer download.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadSummary {
    pub path: String,
    pub bytes: u64,
}

/// Metadata surfaced to the frontend by the signed-update check.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterMeta {
    pub current_version: String,
    /// False when latest.json says the running version is already current.
    pub available: bool,
    pub version: Option<String>,
    /// Notes from latest.json; the dialog keeps showing the release body
    /// fetched by `check_update`, so this is informational only.
    pub notes: Option<String>,
}

/// Progress pushed to the frontend while the signed update payload downloads.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdaterInstallEvent {
    Progress {
        received: u64,
        total_bytes: Option<u64>,
    },
    /// Payload downloaded and signature verified; the installer launches next
    /// and (on Windows) this app exits itself.
    Downloaded,
}

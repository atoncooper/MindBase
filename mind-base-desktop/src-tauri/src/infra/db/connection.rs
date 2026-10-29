//! Managed SQLite handle: id generation, connection opening and startup init.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::AppHandle;

use super::data_dir::{default_data_dir, read_custom_dir};
use super::schema::ensure_schema;

/// Database file stored under the active data directory.
pub(crate) const DB_FILE_NAME: &str = "mindbase-desktop.sqlite3";

/// Process-wide counter mixed into [`local_id`] so ids created within the
/// same nanosecond timestamp stay unique.
static LOCAL_ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Generate a 32-hex local identifier (stand-in for UUID4 without a new
/// dependency): MD5 over wall-clock nanos + pid + an atomic counter. Collision
/// odds are irrelevant for a single-user local app.
pub(crate) fn local_id() -> String {
    use md5::{Digest, Md5};
    use std::sync::atomic::Ordering;

    let counter = LOCAL_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_nanos())
        .unwrap_or_default();
    let mut hasher = Md5::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(counter.to_le_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Managed SQLite handle shared across Tauri commands.
///
/// Lock order (to stay deadlock-free): `conn` first, then `data_dir`. No
/// code path acquires them in reverse order or nests other locks in between.
#[derive(Clone)]
pub struct Db {
    pub conn: Arc<Mutex<Connection>>,
    /// Active data directory (host of the db file); updated on relocation.
    pub data_dir: Arc<Mutex<PathBuf>>,
    /// OS default app-data dir; pointer-file anchor and reset target.
    pub default_dir: PathBuf,
}

/// Open (or create) the database under `dir` and prepare it for use.
pub(super) fn open_conn(dir: &Path) -> Result<Connection, String> {
    let path = dir.join(DB_FILE_NAME);
    let conn = Connection::open(&path)
        .map_err(|err| format!("failed to open sqlite db at {}: {err}", path.display()))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// Open the database at the resolved location and share it as managed state.
///
/// The active directory is the pointer target when valid, else the default;
/// a custom location that cannot be opened falls back to the default one so
/// startup never breaks because of relocation state.
pub fn init(app: &AppHandle) -> Result<Db, String> {
    let default_dir = default_data_dir(app)?;
    let preferred = read_custom_dir(&default_dir).unwrap_or_else(|| default_dir.clone());

    let (conn, used_dir) = match open_conn(&preferred) {
        Ok(conn) => (conn, preferred),
        Err(err) if preferred != default_dir => {
            eprintln!("[db] custom data dir unusable ({err}); falling back to default");
            open_conn(&default_dir).map(|conn| (conn, default_dir.clone()))?
        }
        Err(err) => return Err(err),
    };

    Ok(Db {
        conn: Arc::new(Mutex::new(conn)),
        data_dir: Arc::new(Mutex::new(used_dir)),
        default_dir,
    })
}

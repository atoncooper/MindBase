//! Location of the embedded Python inside the data directory.

use std::path::{Path, PathBuf};

/// Directory that hosts the embedded runtime.
pub(crate) fn python_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("python")
}

/// Path to the embedded interpreter.
pub(crate) fn python_exe(data_dir: &Path) -> PathBuf {
    python_dir(data_dir).join("python.exe")
}

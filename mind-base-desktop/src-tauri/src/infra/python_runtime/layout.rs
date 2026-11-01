//! Location of the Python runtime inside the data directory.
//!
//! - Windows：官方 embeddable 发行版解压到 <data_dir>/python（python.exe）；
//! - macOS / Linux：用系统 python3 创建 venv 到 <data_dir>/python-venv
//!   （解释器 venv/bin/python3），依赖 pip 安装在该 venv 内。

use std::path::{Path, PathBuf};

/// venv 目录（macOS / Linux 使用；Windows 不用）。
pub(crate) fn venv_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("python-venv")
}

/// 运行时根目录：Windows = data/python；macOS/Linux = data/python-venv。
pub(crate) fn python_dir(data_dir: &Path) -> PathBuf {
    python_dir_for(data_dir, cfg!(windows))
}

fn python_dir_for(data_dir: &Path, windows: bool) -> PathBuf {
    if windows {
        data_dir.join("python")
    } else {
        venv_dir(data_dir)
    }
}

/// 解释器路径：Windows = runtime/python.exe；macOS/Linux = venv/bin/python3。
///
/// 路径可能尚不存在（由 provision 负责创建）；调用方先 is_file() 再决定是否需要 provision。
pub(crate) fn python_exe(data_dir: &Path) -> PathBuf {
    python_exe_for(data_dir, cfg!(windows))
}

fn python_exe_for(data_dir: &Path, windows: bool) -> PathBuf {
    if windows {
        python_dir_for(data_dir, true).join("python.exe")
    } else {
        venv_dir(data_dir).join("bin").join("python3")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_runtime_paths_are_unchanged() {
        let data = Path::new("/data/mindbase");
        assert_eq!(python_dir_for(data, true), data.join("python"));
        assert_eq!(
            python_exe_for(data, true),
            data.join("python").join("python.exe")
        );
    }

    #[test]
    fn unix_runtime_uses_venv_layout() {
        let data = Path::new("/data/mindbase");
        assert_eq!(venv_dir(data), data.join("python-venv"));
        assert_eq!(python_dir_for(data, false), data.join("python-venv"));
        assert_eq!(
            python_exe_for(data, false),
            data.join("python-venv").join("bin").join("python3")
        );
    }
}

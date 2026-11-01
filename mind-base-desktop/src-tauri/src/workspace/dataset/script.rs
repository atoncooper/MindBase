//! 分析脚本导入 / 项目脚本列表（纯文件访问，不含 SQL）。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::infra::db::Db;

/// 单个脚本上限（512 KB）：分析脚本是文本，过大通常说明选错文件。
const MAX_SCRIPT_BYTES: u64 = 512 * 1024;

const ALLOWED_SCRIPT_EXT: [&str; 3] = ["py", "pyw", "txt"];

/// 从本地导入的脚本（前端填进编辑器用）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedScript {
    pub name: String,
    pub content: String,
    pub path: String,
}

/// 项目 analysis/scripts 下的脚本条目。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedScript {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: i64,
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default()
}

fn script_name(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().trim().to_string())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "分析脚本".to_string())
}

/// 读取本地 .py/.pyw/.txt 脚本（UTF-8，≤512 KB）。
pub(crate) fn import_script(path: &str) -> Result<ImportedScript, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("脚本路径不能为空".to_string());
    }
    let source = PathBuf::from(trimmed);
    if !source.is_file() {
        return Err(format!("脚本文件不存在：{}", source.display()));
    }
    let ext = extension_of(&source);
    if !ALLOWED_SCRIPT_EXT.contains(&ext.as_str()) {
        return Err(format!(
            "只支持导入 .py / .pyw / .txt 脚本（当前：{}）",
            if ext.is_empty() {
                "无扩展名"
            } else {
                ext.as_str()
            }
        ));
    }
    let size = std::fs::metadata(&source)
        .map_err(|err| format!("无法读取脚本信息：{err}"))?
        .len();
    if size > MAX_SCRIPT_BYTES {
        return Err(format!(
            "脚本过大（上限 512 KB，当前 {} KB）",
            (size + 1023) / 1024
        ));
    }
    let bytes = std::fs::read(&source).map_err(|err| format!("读取脚本失败：{err}"))?;
    let content = String::from_utf8(bytes).map_err(|_| "脚本必须是 UTF-8 文本".to_string())?;
    Ok(ImportedScript {
        name: script_name(&source),
        content,
        path: path.to_string(),
    })
}

/// 列出项目 analysis/scripts 下的 .py/.pyw（按修改时间倒序；目录不存在返回空）。
pub(crate) fn list_scripts(project_root: &Path) -> Result<Vec<SavedScript>, String> {
    let scripts_dir = project_root.join("analysis").join("scripts");
    if !scripts_dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries =
        std::fs::read_dir(&scripts_dir).map_err(|err| format!("读取脚本目录失败：{err}"))?;
    let mut scripts: Vec<SavedScript> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("读取脚本目录失败：{err}"))?;
        let path = entry.path();
        if !path.is_file() || !matches!(extension_of(&path).as_str(), "py" | "pyw") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| format!("无法读取脚本信息：{err}"))?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|delta| delta.as_secs() as i64)
            .unwrap_or_default();
        scripts.push(SavedScript {
            name: script_name(&path),
            path: path.to_string_lossy().to_string(),
            size: metadata.len(),
            modified_at,
        });
    }
    scripts.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| right.path.cmp(&left.path))
    });
    Ok(scripts)
}

/// 导入本地分析脚本：返回文件名（去扩展名）、全文、原路径。
#[tauri::command]
pub fn analysis_script_import(path: String) -> Result<ImportedScript, String> {
    import_script(&path)
}

/// 列出项目 analysis/scripts 下的脚本（按修改时间倒序）。
#[tauri::command]
pub fn analysis_scripts_list(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<SavedScript>, String> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }
    // 锁顺序沿用项目约定：先 conn 后 data_dir，且两把锁都尽快释放。
    let data_dir = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("无法获取数据库锁：{err}"))?;
        super::ensure_project(&conn, &project_id)?;
        db.data_dir
            .lock()
            .map_err(|err| format!("无法获取数据目录锁：{err}"))?
            .clone()
    };
    list_scripts(&data_dir.join("research").join(&project_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mindbase-script-{tag}-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_script(path: &Path, content: &str) {
        std::fs::write(path, content).expect("write script file");
    }

    #[test]
    fn import_reads_python_script_and_reports_name() {
        let dir = temp_root("import");
        let path = dir.join("分析.py");
        write_script(&path, "print('hello')\n");
        let imported = import_script(&path.to_string_lossy()).expect("import script");
        assert_eq!(imported.name, "分析");
        assert_eq!(imported.content, "print('hello')\n");
        assert_eq!(imported.path, path.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_rejects_extension_size_and_non_utf8() {
        let dir = temp_root("reject");
        let csv = dir.join("data.csv");
        write_script(&csv, "a,b\n");
        let err = import_script(&csv.to_string_lossy()).expect_err("reject csv");
        assert!(err.contains("只支持导入"), "unexpected: {err}");

        let huge = dir.join("huge.py");
        std::fs::write(&huge, vec![b'a'; (MAX_SCRIPT_BYTES + 1) as usize]).expect("write huge");
        let err = import_script(&huge.to_string_lossy()).expect_err("reject oversize");
        assert!(err.contains("脚本过大"), "unexpected: {err}");

        let binary = dir.join("binary.py");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).expect("write binary");
        let err = import_script(&binary.to_string_lossy()).expect_err("reject non-utf8");
        assert!(err.contains("UTF-8"), "unexpected: {err}");

        let err = import_script("   ").expect_err("reject empty path");
        assert!(err.contains("脚本路径不能为空"), "unexpected: {err}");

        let missing = dir.join("missing.py");
        let err = import_script(&missing.to_string_lossy()).expect_err("reject missing file");
        assert!(err.contains("脚本文件不存在"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_scripts_sorts_by_modified_time_and_ignores_other_files() {
        let root = temp_root("list");
        // 目录不存在 → 空数组。
        assert!(
            list_scripts(&root).expect("empty list").is_empty(),
            "missing scripts dir must list nothing"
        );

        let scripts_dir = root.join("analysis").join("scripts");
        std::fs::create_dir_all(&scripts_dir).expect("create scripts dir");
        let first = scripts_dir.join("a.py");
        let second = scripts_dir.join("b.pyw");
        write_script(&first, "print(1)\n");
        write_script(&second, "print(2)\n");
        write_script(&scripts_dir.join("notes.txt"), "ignored");
        std::fs::create_dir_all(scripts_dir.join("nested.py")).expect("create nested dir");

        // 显式设置修改时间，保证排序断言与文件系统时间精度无关。
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        set_modified(&first, base + Duration::from_secs(60));
        set_modified(&second, base + Duration::from_secs(120));

        let listed = list_scripts(&root).expect("list scripts");
        assert_eq!(listed.len(), 2, "only .py/.pyw files: {:?}", listed);
        assert_eq!(listed[0].name, "b", "newest first");
        assert_eq!(listed[1].name, "a");
        assert_eq!(listed[0].size, "print(2)\n".len() as u64);
        assert_eq!(listed[0].modified_at, 1_700_000_120);
        assert!(Path::new(&listed[0].path).is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn set_modified(path: &Path, stamp: SystemTime) {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open for mtime");
        file.set_modified(stamp).expect("set modified time");
    }
}

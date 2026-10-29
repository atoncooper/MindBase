//! Local-folder and zip skill installation (zip-slip / size guarded).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::parse_skill;
use super::paths::{skills_dir, SKILL_FILE};
use super::SkillMeta;
use crate::infra::db::Db;

/// Install a skill from a local folder (picked via the native dialog):
/// validate `<source>/SKILL.md` parses, then deep-copy the folder into
/// `<data_dir>/skills/<folder>/`. Refuses to silently overwrite an existing
/// skill with the same folder name.
#[tauri::command]
pub fn skills_install_from_path(app: AppHandle, source: String) -> Result<SkillMeta, String> {
    let source_path = PathBuf::from(source.trim());
    if !source_path.is_dir() {
        return Err("所选路径不是文件夹".to_string());
    }
    let raw = std::fs::read_to_string(source_path.join(SKILL_FILE))
        .map_err(|_| format!("所选文件夹缺少 {SKILL_FILE}，无法作为技能安装"))?;
    let Some(parsed) = parse_skill(&raw, "") else {
        return Err(
            "SKILL.md 解析失败：需要 frontmatter（name / description）与指令正文".to_string(),
        );
    };
    let Some(folder) = source_path.file_name().and_then(|n| n.to_str()) else {
        return Err("无法读取文件夹名称".to_string());
    };
    if !folder
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || folder.starts_with('.')
    {
        return Err(format!(
            "文件夹名 `{folder}` 含不支持字符（仅允许字母 / 数字 / - _ .）"
        ));
    }

    let db = app.state::<Db>();
    let target_root = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        skills_dir(&dir)
    };
    let target = target_root.join(folder);
    if target.exists() {
        return Err(format!(
            "技能 `{folder}` 已存在；请先在技能文件夹中删除或重命名后再安装"
        ));
    }
    copy_dir_recursive(&source_path, &target).map_err(|err| format!("安装失败：{err}"))?;
    Ok(SkillMeta {
        name: if parsed.name.is_empty() {
            folder.to_string()
        } else {
            parsed.name
        },
        description: parsed.description,
        enabled: true,
        folder: folder.to_string(),
    })
}

/// Deep-copy a directory tree (files + nested dirs).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let entry_dst = dst.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &entry_dst)?;
        } else {
            std::fs::copy(&entry_path, &entry_dst)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Zip install — same archive format as the app/ skill store
// (SKILL.md + optional manifest.json; GitHub-zipball top-level prefix ok).
// ---------------------------------------------------------------------------

/// Per-file and total decompression caps — skill packs are small text
/// bundles; anything larger is hostile or corrupt.
const ZIP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

/// Find the archive entry closest to the root matching `target` (root
/// preferred over GitHub-zipball's `owner-repo-sha/` prefix), mirroring
/// app/skills/zip_parser._find_entry.
fn find_entry<'a>(names: &[&'a str], target: &str) -> Option<&'a str> {
    names
        .iter()
        .filter(|n| **n == target || n.ends_with(&format!("/{target}")))
        .min_by_key(|n| n.len())
        .copied()
}

/// ASCII-safe folder name from a zip filename (extension stripped).
fn folder_from_zip_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = safe.trim_matches('-');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Install a skill pack from a `.zip` file on disk. Thin shell over
/// [`install_zip_bytes`] — all logic lives there for testability.
#[tauri::command]
pub fn skills_install_zip(app: AppHandle, path: String) -> Result<SkillMeta, String> {
    let bytes = std::fs::read(&path).map_err(|err| format!("无法读取 zip 文件：{err}"))?;
    let zip_path = PathBuf::from(&path);
    let db = app.state::<Db>();
    let target_root = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        skills_dir(&dir)
    };
    install_zip_bytes(&target_root, &zip_path, &bytes)
}

/// Core zip install: metadata priority mirrors the backend (manifest.json >
/// SKILL.md frontmatter > zip filename); rejects an existing target folder
/// (no silent overwrite) and enforces zip-slip + size caps.
pub(super) fn install_zip_bytes(
    target_root: &Path,
    zip_display_path: &Path,
    bytes: &[u8],
) -> Result<SkillMeta, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|err| format!("zip 解析失败：{err}"))?;

    let names_owned: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let names: Vec<&str> = names_owned.iter().map(String::as_str).collect();

    // Metadata resolution.
    let mut manifest_name = String::new();
    let mut manifest_description = String::new();
    if let Some(entry) = find_entry(&names, "manifest.json") {
        if let Ok(mut file) = archive.by_name(entry) {
            let mut text = String::new();
            use std::io::Read;
            if file.read_to_string(&mut text).is_ok() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    manifest_name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    manifest_description = value
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                }
            }
        }
    }

    let skill_entry = find_entry(&names, SKILL_FILE)
        .ok_or_else(|| format!("zip 中缺少 {SKILL_FILE}，无法作为技能安装"))?;
    let (front_name, front_description, body_nonempty) = {
        let mut file = archive
            .by_name(skill_entry)
            .map_err(|err| format!("读取 {SKILL_FILE} 失败：{err}"))?;
        let mut text = String::new();
        use std::io::Read;
        file.read_to_string(&mut text)
            .map_err(|err| format!("{SKILL_FILE} 不是有效的 UTF-8 文本：{err}"))?;
        match parse_skill(&text, "") {
            Some(parsed) => (parsed.name, parsed.description, !parsed.body.is_empty()),
            None => (String::new(), String::new(), false),
        }
    };
    if !body_nonempty && manifest_description.is_empty() {
        return Err(format!("{SKILL_FILE} 为空或无法解析，无法作为技能安装"));
    }

    // Folder name: manifest name → frontmatter name → zip filename, made
    // ASCII-safe either way.
    let raw_folder = if !manifest_name.is_empty() {
        manifest_name.clone()
    } else if !front_name.is_empty() {
        front_name.clone()
    } else {
        folder_from_zip_name(zip_display_path).ok_or("无法确定技能目录名（zip 文件名不合法）")?
    };
    let folder: String = raw_folder
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let folder = folder.trim_matches('-').to_string();
    if folder.is_empty() {
        return Err("无法确定技能目录名（名称不含可用字符）".to_string());
    }

    let target = target_root.join(&folder);
    if target.exists() {
        return Err(format!(
            "技能 `{folder}` 已存在；请先在技能文件夹中删除或重命名后再安装"
        ));
    }

    // Extract everything except directory entries; zip-slip guard: every
    // resolved path must stay under the target dir. GitHub zipballs put all
    // entries under one `owner-repo-sha/` prefix dir — strip it so the
    // on-disk layout is `skills/<folder>/SKILL.md` (what the scanner expects).
    let top_prefix: Option<String> = {
        let tops: std::collections::HashSet<&str> = names
            .iter()
            .filter_map(|n| n.split('/').next())
            .filter(|t| !t.is_empty())
            .collect();
        let all_nested = names.iter().all(|n| n.contains('/'));
        if tops.len() == 1 && all_nested {
            tops.into_iter().next().map(|t| format!("{t}/"))
        } else {
            None
        }
    };
    std::fs::create_dir_all(&target).map_err(|err| format!("创建技能目录失败：{err}"))?;
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("zip 读取失败：{err}"))?;
        if file.is_dir() {
            continue;
        }
        let Some(rel) = file.enclosed_name() else {
            let _ = std::fs::remove_dir_all(&target);
            return Err(format!("zip 含不安全路径（{}），已中止安装", file.name()));
        };
        let rel = match &top_prefix {
            Some(prefix) => {
                let stripped = rel
                    .to_string_lossy()
                    .strip_prefix(prefix.as_str())
                    .map(PathBuf::from);
                match stripped {
                    Some(stripped) if !stripped.as_os_str().is_empty() => stripped,
                    _ => continue,
                }
            }
            None => rel.to_path_buf(),
        };
        total += file.size();
        if file.size() > ZIP_MAX_FILE_BYTES || total > ZIP_MAX_TOTAL_BYTES {
            let _ = std::fs::remove_dir_all(&target);
            return Err("zip 解压后过大（上限 16MB），已中止安装".to_string());
        }
        let out_path = target.join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("创建子目录失败：{err}"))?;
        }
        let mut out_file =
            std::fs::File::create(&out_path).map_err(|err| format!("写入文件失败：{err}"))?;
        std::io::copy(&mut file, &mut out_file).map_err(|err| format!("解压失败：{err}"))?;
    }

    Ok(SkillMeta {
        name: if !manifest_name.is_empty() {
            manifest_name
        } else if !front_name.is_empty() {
            front_name
        } else {
            folder.clone()
        },
        description: if !manifest_description.is_empty() {
            manifest_description
        } else {
            front_description
        },
        enabled: true,
        folder,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an in-memory zip (deflate) from (path, bytes) pairs.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(buf);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut zip, data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    const SKILL_MD: &str =
        "---\nname: front-name\ndescription: front desc\n---\n\n# 正文\n\n按步骤执行。";

    #[test]
    fn flat_zip_manifest_wins_and_extracts_all_files() {
        let bytes = build_zip(&[
            ("SKILL.md", SKILL_MD.as_bytes()),
            (
                "manifest.json",
                br#"{"name":"manifest-name","description":"manifest desc","version":"1.2"}"#,
            ),
            ("resources/guide.md", b"# guide"),
        ]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let meta = install_zip_bytes(&tmp, Path::new("any.zip"), &bytes).unwrap();
        assert_eq!(meta.name, "manifest-name", "manifest beats frontmatter");
        assert_eq!(meta.description, "manifest desc");
        assert_eq!(meta.folder, "manifest-name");
        assert!(meta.enabled);
        assert!(tmp.join("manifest-name").join("SKILL.md").is_file());
        assert!(tmp
            .join("manifest-name")
            .join("resources")
            .join("guide.md")
            .is_file());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn zipball_prefix_layout_resolves_and_falls_back_to_frontmatter() {
        // GitHub zipball: everything under owner-repo-sha/.
        let bytes = build_zip(&[
            ("atoncooper-skillx-ab12f/SKILL.md", SKILL_MD.as_bytes()),
            ("atoncooper-skillx-ab12f/resources/a.txt", b"a"),
        ]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-zb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let meta =
            install_zip_bytes(&tmp, Path::new("atoncooper-skillx-ab12f.zip"), &bytes).unwrap();
        assert_eq!(meta.name, "front-name", "no manifest → frontmatter name");
        assert_eq!(meta.description, "front desc");
        assert_eq!(meta.folder, "front-name");
        // 前缀目录必须被剥离：SKILL.md 直接落在 folder 根（扫描约定）。
        assert!(
            tmp.join("front-name").join("SKILL.md").is_file(),
            "zipball prefix must be stripped so SKILL.md lands at folder root"
        );
        assert!(!tmp
            .join("front-name")
            .join("atoncooper-skillx-ab12f")
            .exists());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn duplicate_install_is_rejected_and_zip_slip_aborts() {
        let bytes = build_zip(&[("SKILL.md", SKILL_MD.as_bytes())]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-dup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        install_zip_bytes(&tmp, Path::new("dup.zip"), &bytes).unwrap();
        let second = install_zip_bytes(&tmp, Path::new("dup.zip"), &bytes);
        assert!(
            second.is_err(),
            "second install must fail on existing folder"
        );

        // zip-slip: an entry escaping the target aborts and cleans up.
        let mut evil_zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        evil_zip.start_file("../evil.txt", options).unwrap();
        std::io::Write::write_all(&mut evil_zip, b"x").unwrap();
        let evil_bytes = evil_zip.finish().unwrap().into_inner();
        let tmp2 = std::env::temp_dir().join(format!("mb-skills-test-slip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp2);
        let result = install_zip_bytes(&tmp2, Path::new("evil.zip"), &evil_bytes);
        assert!(result.is_err(), "zip-slip entry must abort");
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::remove_dir_all(&tmp2).ok();
    }

    #[test]
    fn zip_without_skill_md_is_rejected() {
        let bytes = build_zip(&[("readme.txt", b"not a skill".as_slice())]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let result = install_zip_bytes(&tmp, Path::new("x.zip"), &bytes);
        assert!(result.unwrap_err().contains("SKILL.md"));
        std::fs::remove_dir_all(&tmp).ok();
    }
}

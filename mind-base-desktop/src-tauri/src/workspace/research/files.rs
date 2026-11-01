//! 科研项目「文件」tab 的后端：列目录、读文本/图片、PDF 单页渲染、DOCX→HTML。
//!
//! 安全边界：项目 id 必须是单一普通路径段；所有文件路径先拒绝绝对路径与
//! `..`，再 canonicalize 并校验 `starts_with(项目根 canonical)`，因此符号
//! 链接逃逸同样会被拒绝。命令层只做锁/参数校验，Python 渲染放到阻塞线程。

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::infra::db::Db;

const MAX_LIST_DEPTH: usize = 8;
const MAX_LIST_ENTRIES: usize = 3000;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const SKIP_DIRS: [&str; 4] = [".git", "__pycache__", "node_modules", ".venv"];
const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "svg"];

/// 文件树条目（path 是相对项目根的 '/' 分隔路径）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFileEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_at: i64,
}

/// 文本预览。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFileText {
    pub path: String,
    pub absolute_path: String,
    pub text: String,
    pub size: u64,
    pub truncated: bool,
}

/// 图片预览。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFileImage {
    pub base64: String,
    pub mime: String,
    pub size: u64,
}

/// 原样文件字节（Word/PDF 原样展示用）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFileBytes {
    pub base64: String,
    pub mime: String,
    pub size: u64,
}

/// PDF 单页渲染结果（PNG base64）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFilePdfPage {
    pub base64: String,
    pub mime: String,
    pub page: u32,
    pub page_count: u32,
}

/// DOCX 转 HTML 预览。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFileDocxHtml {
    pub html: String,
    pub size: u64,
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/// 项目根目录（未 canonicalize；可能尚不存在）。
pub(crate) fn project_root(data_dir: &Path, project_id: &str) -> Result<PathBuf, String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }
    let mut components = Path::new(project_id).components();
    let single = matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !single || project_id.contains('\\') {
        return Err("研究项目 ID 非法".to_string());
    }
    Ok(data_dir.join("research").join(project_id))
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(root)
        .map_err(|_| format!("研究项目目录不存在：{}", root.display()))
}

/// 把项目内相对路径解析成 canonical 绝对路径，拒绝任何项目外访问。
pub(crate) fn resolve_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim();
    if relative.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err("文件路径必须是项目内相对路径".to_string());
    }
    if candidate.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("不允许访问项目目录之外的文件".to_string());
    }
    let root = canonical_root(root)?;
    let joined = root.join(candidate);
    let target = std::fs::canonicalize(&joined).map_err(|_| format!("文件不存在：{relative}"))?;
    if !target.starts_with(&root) {
        return Err("不允许访问项目目录之外的文件".to_string());
    }
    Ok(target)
}

fn extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default()
}

fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn modified_secs(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 文件树 / 文本 / 图片
// ---------------------------------------------------------------------------

fn collect_entries(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<ResearchFileEntry>,
) -> Result<(), String> {
    if depth > MAX_LIST_DEPTH || out.len() >= MAX_LIST_ENTRIES {
        return Ok(());
    }
    let read_dir = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        // 无权限/已被删除的子目录不影响整体浏览。
        Err(_) => return Ok(()),
    };
    let mut children: Vec<std::fs::DirEntry> = read_dir.filter_map(Result::ok).collect();
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        if out.len() >= MAX_LIST_ENTRIES {
            return Ok(());
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        // 不跟随符号链接（避免列出项目外内容）。
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        out.push(ResearchFileEntry {
            path: relative_path(root, &path),
            name,
            is_dir: file_type.is_dir(),
            size: if file_type.is_file() { metadata.len() } else { 0 },
            modified_at: modified_secs(&metadata),
        });
        if file_type.is_dir() {
            collect_entries(root, &path, depth + 1, out)?;
        }
    }
    Ok(())
}

/// 递归列出项目文件树：目录在前、同类按路径字典序，深度/条目有上限。
pub(crate) fn list_project_files(root: &Path) -> Result<Vec<ResearchFileEntry>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let root = canonical_root(root)?;
    let mut entries = Vec::new();
    collect_entries(&root, &root, 0, &mut entries)?;
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.path.cmp(&right.path))
    });
    entries.truncate(MAX_LIST_ENTRIES);
    Ok(entries)
}

/// 读取文本文件（≤2 MB，超出截断；非 UTF-8 拒绝）。
pub(crate) fn read_text_file(root: &Path, relative: &str) -> Result<ResearchFileText, String> {
    let target = resolve_path(root, relative)?;
    let metadata =
        std::fs::metadata(&target).map_err(|err| format!("读取文件信息失败：{err}"))?;
    if !metadata.is_file() {
        return Err(format!("不是文件：{relative}"));
    }
    let size = metadata.len();
    let truncated = size > MAX_TEXT_BYTES;
    let bytes = if truncated {
        let file =
            std::fs::File::open(&target).map_err(|err| format!("读取文件失败：{err}"))?;
        let mut buffer = vec![0_u8; MAX_TEXT_BYTES as usize];
        let mut reader = std::io::BufReader::new(file);
        reader
            .read_exact(&mut buffer)
            .map_err(|err| format!("读取文件失败：{err}"))?;
        buffer
    } else {
        std::fs::read(&target).map_err(|err| format!("读取文件失败：{err}"))?
    };
    let mut text =
        String::from_utf8(bytes).map_err(|_| "二进制文件不支持文本预览".to_string())?;
    if let Some(stripped) = text.strip_prefix('\u{feff}') {
        text = stripped.to_string();
    }
    Ok(ResearchFileText {
        path: relative.trim().to_string(),
        absolute_path: target.to_string_lossy().to_string(),
        text,
        size,
        truncated,
    })
}

fn image_mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn document_mime(ext: &str) -> &'static str {
    match ext {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// 读取项目内任意文件原始字节并转 base64（≤50 MB；docx/pdf 给出专用 mime）。
pub(crate) fn read_file_bytes(root: &Path, relative: &str) -> Result<ResearchFileBytes, String> {
    let target = resolve_path(root, relative)?;
    let metadata =
        std::fs::metadata(&target).map_err(|err| format!("读取文件信息失败：{err}"))?;
    if !metadata.is_file() {
        return Err(format!("不是文件：{relative}"));
    }
    let size = metadata.len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（上限 50 MB，当前 {} MB）",
            size / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&target).map_err(|err| format!("读取文件失败：{err}"))?;
    Ok(ResearchFileBytes {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: document_mime(&extension_lower(&target)).to_string(),
        size,
    })
}

/// 读取图片并转 base64（≤20 MB）。
pub(crate) fn read_image_file(root: &Path, relative: &str) -> Result<ResearchFileImage, String> {
    let target = resolve_path(root, relative)?;
    let ext = extension_lower(&target);
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的图片格式：{}（仅支持 png / jpg / jpeg / webp / gif / svg）",
            if ext.is_empty() { "无扩展名" } else { ext.as_str() }
        ));
    }
    let metadata =
        std::fs::metadata(&target).map_err(|err| format!("读取图片信息失败：{err}"))?;
    if !metadata.is_file() {
        return Err(format!("不是文件：{relative}"));
    }
    let size = metadata.len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（上限 20 MB，当前 {} MB）",
            size / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&target).map_err(|err| format!("读取图片失败：{err}"))?;
    Ok(ResearchFileImage {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: image_mime(&ext).to_string(),
        size,
    })
}

// ---------------------------------------------------------------------------
// Python 侧渲染（PDF 单页 / DOCX→HTML）
// ---------------------------------------------------------------------------

fn script_path(name: &str) -> PathBuf {
    // dev: CARGO_MANIFEST_DIR/scripts; packaged: resources/scripts
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join(name);
    if dev.exists() {
        return dev;
    }
    Path::new("scripts").join(name).to_path_buf()
}

fn last_json_line(stdout: &str) -> &str {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

fn run_python_script(
    data_dir: &Path,
    script_name: &str,
    need_pdf: bool,
    need_docx: bool,
    args: &[String],
    purpose: &str,
) -> Result<String, String> {
    let script = script_path(script_name);
    if !script.is_file() {
        return Err(format!("预览脚本缺失：{}", script.display()));
    }
    let exe = crate::infra::python_runtime::ensure_doc_extract_python(
        data_dir, need_pdf, need_docx, false,
    )?;
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = StdCommand::new(&exe);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(not(windows))]
    let mut command = StdCommand::new(&exe);
    let output = command
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg(&script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("无法启动{purpose}：{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(400)
            .collect();
        return Err(format!(
            "{purpose}失败（退出码 {}）：{}",
            output.status,
            if stderr.trim().is_empty() {
                "无输出"
            } else {
                stderr.trim()
            }
        ));
    }
    Ok(stdout)
}

#[derive(Debug, Deserialize)]
struct PdfPayload {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    base64: String,
    #[serde(default)]
    page: u32,
    #[serde(default, rename = "pageCount")]
    page_count: u32,
    #[serde(default)]
    error: String,
}

fn render_pdf_page(
    data_dir: &Path,
    target: &Path,
    page: u32,
    dpi: u32,
) -> Result<ResearchFilePdfPage, String> {
    let args = vec![
        target.to_string_lossy().to_string(),
        page.to_string(),
        dpi.to_string(),
    ];
    let stdout = run_python_script(
        data_dir,
        "pdf_page.py",
        true,
        false,
        &args,
        "PDF 页渲染",
    )?;
    let payload: PdfPayload = serde_json::from_str(last_json_line(&stdout)).map_err(|err| {
        format!(
            "PDF 渲染输出无法解析：{err}（输出片段：{}）",
            last_json_line(&stdout).chars().take(160).collect::<String>()
        )
    })?;
    if !payload.ok {
        return Err(if payload.error.trim().is_empty() {
            "PDF 页渲染失败（未知原因）".to_string()
        } else {
            payload.error
        });
    }
    Ok(ResearchFilePdfPage {
        base64: payload.base64,
        mime: "image/png".to_string(),
        page: if payload.page == 0 { page } else { payload.page },
        page_count: payload.page_count,
    })
}

#[derive(Debug, Deserialize)]
struct DocxPayload {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    html: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    error: String,
}

fn render_docx_html(data_dir: &Path, target: &Path) -> Result<ResearchFileDocxHtml, String> {
    let args = vec![target.to_string_lossy().to_string()];
    let stdout = run_python_script(
        data_dir,
        "docx_preview.py",
        false,
        true,
        &args,
        "DOCX 预览渲染",
    )?;
    let payload: DocxPayload =
        serde_json::from_str(last_json_line(&stdout)).map_err(|err| {
            format!(
                "DOCX 预览输出无法解析：{err}（输出片段：{}）",
                last_json_line(&stdout).chars().take(160).collect::<String>()
            )
        })?;
    if !payload.ok {
        return Err(if payload.error.trim().is_empty() {
            "DOCX 预览失败（未知原因）".to_string()
        } else {
            payload.error
        });
    }
    Ok(ResearchFileDocxHtml {
        html: payload.html,
        size: payload.size,
    })
}

fn ensure_extension(target: &Path, allowed: &[&str], label: &str) -> Result<(), String> {
    let ext = extension_lower(target);
    if allowed.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "仅支持 {label} 文件预览（当前：{}）",
            if ext.is_empty() { "无扩展名" } else { ext.as_str() }
        ))
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn data_dir_of(db: &State<'_, Db>) -> Result<PathBuf, String> {
    db.data_dir
        .lock()
        .map_err(|err| format!("无法获取数据目录锁：{err}"))
        .map(|guard| guard.clone())
}

/// 列出项目目录树（目录在前、按路径字典序；深度 ≤8、条目 ≤3000）。
#[tauri::command]
pub fn research_files_list(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<ResearchFileEntry>, String> {
    let data_dir = data_dir_of(&db)?;
    let root = project_root(&data_dir, &project_id)?;
    list_project_files(&root)
}

/// 文本预览（≤2 MB，超出截断；二进制文件报错）。
#[tauri::command]
pub fn research_file_read(
    db: State<'_, Db>,
    project_id: String,
    path: String,
) -> Result<ResearchFileText, String> {
    let data_dir = data_dir_of(&db)?;
    let root = project_root(&data_dir, &project_id)?;
    read_text_file(&root, &path)
}

/// 图片预览（png/jpg/jpeg/webp/gif/svg，≤20 MB）。
#[tauri::command]
pub fn research_file_image(
    db: State<'_, Db>,
    project_id: String,
    path: String,
) -> Result<ResearchFileImage, String> {
    let data_dir = data_dir_of(&db)?;
    let root = project_root(&data_dir, &project_id)?;
    read_image_file(&root, &path)
}

/// 原样文件字节（Word/PDF 原样展示；≤50 MB，base64 标准编码）。
// 命令待 Lead 在 app/commands.rs 注册；注册前 crate 内暂无调用方。
#[allow(dead_code)]
#[tauri::command]
pub fn research_file_bytes(
    db: State<'_, Db>,
    project_id: String,
    path: String,
) -> Result<ResearchFileBytes, String> {
    let data_dir = data_dir_of(&db)?;
    let root = project_root(&data_dir, &project_id)?;
    read_file_bytes(&root, &path)
}

/// PDF 单页渲染成 PNG base64（dpi 夹取 72..200，默认 144）。
#[tauri::command]
pub async fn research_file_pdf_page(
    db: State<'_, Db>,
    project_id: String,
    path: String,
    page: u32,
    dpi: Option<u32>,
) -> Result<ResearchFilePdfPage, String> {
    let data_dir = data_dir_of(&db)?;
    let root = project_root(&data_dir, &project_id)?;
    let target = resolve_path(&root, &path)?;
    ensure_extension(&target, &["pdf"], "PDF")?;
    if page == 0 {
        return Err("页码必须从 1 开始".to_string());
    }
    let dpi = dpi.unwrap_or(144).clamp(72, 200);
    tauri::async_runtime::spawn_blocking(move || render_pdf_page(&data_dir, &target, page, dpi))
        .await
        .map_err(|err| format!("PDF 渲染任务执行失败：{err}"))?
}

/// DOCX 转安全 HTML（标题/段落/行内格式/列表/表格/换行）。
#[tauri::command]
pub async fn research_file_docx_html(
    db: State<'_, Db>,
    project_id: String,
    path: String,
) -> Result<ResearchFileDocxHtml, String> {
    let data_dir = data_dir_of(&db)?;
    let root = project_root(&data_dir, &project_id)?;
    let target = resolve_path(&root, &path)?;
    ensure_extension(&target, &["docx"], "DOCX")?;
    tauri::async_runtime::spawn_blocking(move || render_docx_html(&data_dir, &target))
        .await
        .map_err(|err| format!("DOCX 预览任务执行失败：{err}"))?
}

/// 打开文件用：返回校验过的绝对路径（前端用 plugin-opener 打开）。
#[tauri::command]
pub fn research_file_open_path(
    db: State<'_, Db>,
    project_id: String,
    path: String,
) -> Result<String, String> {
    let data_dir = data_dir_of(&db)?;
    let root = project_root(&data_dir, &project_id)?;
    let target = resolve_path(&root, &path)?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mindbase-research-files-{tag}-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(path, bytes).expect("write test file");
    }

    #[test]
    fn project_root_rejects_unsafe_ids() {
        let data_dir = Path::new("/data");
        assert_eq!(
            project_root(data_dir, "proj-1").expect("valid id"),
            data_dir.join("research").join("proj-1")
        );
        for unsafe_id in ["", "  ", "../escape", "a/b", ".."] {
            let err = project_root(data_dir, unsafe_id).expect_err("unsafe project id");
            assert!(!err.is_empty(), "unexpected: {err}");
        }
    }

    #[test]
    fn resolve_path_rejects_absolute_and_parent_traversal() {
        let root = temp_root("resolve");
        write_file(&root.join("inside.txt"), b"inside");
        let outside = root.parent().expect("parent").join(format!(
            "mindbase-research-outside-{}.txt",
            crate::infra::db::local_id()
        ));
        std::fs::write(&outside, b"outside").expect("write outside file");

        assert!(resolve_path(&root, "inside.txt").is_ok());
        let err = resolve_path(&root, "../inside.txt").expect_err("parent traversal");
        assert!(err.contains("项目目录之外"), "unexpected: {err}");
        let err = resolve_path(&root, "a/../../x").expect_err("nested traversal");
        assert!(err.contains("项目目录之外"), "unexpected: {err}");
        let absolute = outside.to_string_lossy().to_string();
        let err = resolve_path(&root, &absolute).expect_err("absolute path");
        assert!(err.contains("相对路径"), "unexpected: {err}");
        let err = read_text_file(&root, "../inside.txt").expect_err("read traversal");
        assert!(err.contains("项目目录之外"), "unexpected: {err}");
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_project_files_sorts_dirs_first_and_skips_noise() {
        let root = temp_root("list");
        write_file(&root.join("b-file.txt"), b"b");
        write_file(&root.join("a-file.py"), b"print(1)");
        write_file(&root.join("dir-b/one.txt"), b"1");
        write_file(&root.join("dir-a/two.txt"), b"2");
        write_file(&root.join(".git/config"), b"noise");
        write_file(&root.join("__pycache__/x.pyc"), b"noise");
        write_file(&root.join("node_modules/pkg/index.js"), b"noise");
        write_file(&root.join(".venv/pyvenv.cfg"), b"noise");
        // 深度 9 的文件（根下 9 层目录）应被深度上限裁掉。
        let mut deep = root.clone();
        for level in 0..9 {
            deep = deep.join(format!("d{level}"));
        }
        write_file(&deep.join("too-deep.txt"), b"deep");

        let entries = list_project_files(&root).expect("list files");
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&"a-file.py"), "missing file: {paths:?}");
        assert!(paths.contains(&"dir-a/two.txt"), "missing nested: {paths:?}");
        for skipped in [
            ".git/config",
            "__pycache__/x.pyc",
            "node_modules/pkg/index.js",
            ".venv/pyvenv.cfg",
        ] {
            assert!(!paths.contains(&skipped), "must skip {skipped}: {paths:?}");
        }
        assert!(
            paths.iter().all(|path| !path.ends_with("too-deep.txt")),
            "depth limit exceeded: {paths:?}"
        );
        // 目录在前，同类按 path 字典序。
        let first_file = entries.iter().position(|entry| !entry.is_dir).expect("file");
        assert!(entries[..first_file].iter().all(|entry| entry.is_dir));
        let files: Vec<&str> = entries[first_file..]
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        let mut sorted = files.clone();
        sorted.sort_unstable();
        assert_eq!(files, sorted, "files must be lexicographic");

        let dir_names: Vec<&str> = entries
            .iter()
            .filter(|entry| entry.is_dir)
            .map(|entry| entry.path.as_str())
            .collect();
        let mut sorted_dirs = dir_names.clone();
        sorted_dirs.sort_unstable();
        assert_eq!(dir_names, sorted_dirs, "dirs must be lexicographic");
        assert!(dir_names.contains(&"dir-a") && dir_names.contains(&"dir-b"));
        assert!(entries.iter().find(|entry| entry.path == "a-file.py").expect("file entry").size == 8);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_missing_project_dir_is_empty() {
        let root = temp_root("missing");
        let entries = list_project_files(&root.join("no-such-project")).expect("empty list");
        assert!(entries.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_text_truncates_oversize_and_rejects_binary() {
        let root = temp_root("read");
        let big = root.join("big.txt");
        let bytes = vec![b'a'; MAX_TEXT_BYTES as usize + 10];
        write_file(&big, &bytes);
        let result = read_text_file(&root, "big.txt").expect("read big text");
        assert!(result.truncated, "oversize must be truncated");
        assert_eq!(result.size, MAX_TEXT_BYTES + 10);
        assert_eq!(result.text.len(), MAX_TEXT_BYTES as usize);
        assert_eq!(result.path, "big.txt");

        let small = root.join("small.txt");
        write_file(&small, b"hello");
        let result = read_text_file(&root, "small.txt").expect("read small text");
        assert!(!result.truncated);
        assert_eq!(result.text, "hello");

        let binary = root.join("binary.bin");
        write_file(&binary, &[0xff, 0xfe, 0x00, 0x01]);
        let err = read_text_file(&root, "binary.bin").expect_err("binary must fail");
        assert!(err.contains("二进制"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn image_preview_checks_extension_and_encodes_base64() {
        let root = temp_root("image");
        let png_bytes = [0x89_u8, b'P', b'N', b'G', 0x0d, 0x0a];
        write_file(&root.join("pic.png"), &png_bytes);
        let image = read_image_file(&root, "pic.png").expect("read png");
        assert_eq!(image.mime, "image/png");
        assert_eq!(image.size, png_bytes.len() as u64);
        assert_eq!(
            image.base64,
            base64::engine::general_purpose::STANDARD.encode(png_bytes)
        );

        write_file(&root.join("notes.txt"), b"not an image");
        let err = read_image_file(&root, "notes.txt").expect_err("unsupported ext");
        assert!(err.contains("不支持的图片格式"), "unexpected: {err}");

        assert_eq!(extension_lower(Path::new("a.PDF")), "pdf");
        assert!(ensure_extension(Path::new("a.pdf"), &["pdf"], "PDF").is_ok());
        let err = ensure_extension(Path::new("a.txt"), &["pdf"], "PDF").expect_err("wrong ext");
        assert!(err.contains("仅支持 PDF"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn file_bytes_reads_docx_pdf_and_rejects_traversal() {
        use base64::Engine as _;

        let root = temp_root("bytes");
        let docx_bytes = [0x50_u8, 0x4b, 0x03, 0x04, 0x00];
        write_file(&root.join("report.docx"), &docx_bytes);
        let bytes = read_file_bytes(&root, "report.docx").expect("read docx bytes");
        assert_eq!(bytes.size, docx_bytes.len() as u64);
        assert_eq!(
            bytes.mime,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&bytes.base64)
            .expect("base64 decode");
        assert_eq!(decoded, docx_bytes.to_vec());

        write_file(&root.join("scan.pdf"), b"%PDF-1.7");
        assert_eq!(
            read_file_bytes(&root, "scan.pdf").expect("pdf bytes").mime,
            "application/pdf"
        );
        write_file(&root.join("blob.bin"), b"x");
        assert_eq!(
            read_file_bytes(&root, "blob.bin").expect("bin bytes").mime,
            "application/octet-stream"
        );

        let outside = root.parent().expect("parent").join(format!(
            "mindbase-bytes-outside-{}.txt",
            crate::infra::db::local_id()
        ));
        std::fs::write(&outside, b"outside").expect("write outside");
        let err = read_file_bytes(&root, "../escape.txt").expect_err("parent traversal");
        assert!(err.contains("项目目录之外"), "unexpected: {err}");
        let absolute = outside.to_string_lossy().to_string();
        let err = read_file_bytes(&root, &absolute).expect_err("absolute path");
        assert!(err.contains("相对路径"), "unexpected: {err}");
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }
}

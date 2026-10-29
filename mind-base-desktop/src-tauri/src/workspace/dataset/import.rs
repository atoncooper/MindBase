//! Import pipeline: file archiving with MD5, Python profiling and name slugs.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use serde_json::Value;

use super::now_secs;

/// 可导入的数据文件扩展名（小写，不含点）。
pub(super) const ALLOWED_EXT: &[&str] = &["csv", "xlsx", "xls"];

/// 画像脚本路径：开发态用 `CARGO_MANIFEST_DIR/scripts`，打包后用相对
/// 可执行文件的 `resources/scripts`（与 file_ingest.rs 的 script_path 写法一致）。
fn profile_script_path() -> PathBuf {
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("dataset_profile.py");
    if dev.exists() {
        return dev;
    }
    Path::new("scripts")
        .join("dataset_profile.py")
        .to_path_buf()
}

/// 复制源文件到 `original_dir`（重名追加 `_1` / `_2` …），同时计算 MD5。
///
/// 分块读写，避免把大文件整个读进内存；MD5 按契约写入 `sha256` 列。
fn copy_with_md5(source: &Path, original_dir: &Path) -> Result<(PathBuf, String), String> {
    use md5::{Digest, Md5};

    std::fs::create_dir_all(original_dir)
        .map_err(|err| format!("无法创建数据目录 {}：{err}", original_dir.display()))?;

    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("无法读取源文件名：{}", source.display()))?;
    let stem = Path::new(&file_name)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "dataset".to_string());
    let ext = Path::new(&file_name)
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();

    let mut target = original_dir.join(&file_name);
    let mut serial = 1;
    while target.exists() {
        target = original_dir.join(format!("{stem}_{serial}{ext}"));
        serial += 1;
    }

    let input = File::open(source)
        .map_err(|err| format!("读取源文件失败（{}）：{err}", source.display()))?;
    let output = File::create(&target)
        .map_err(|err| format!("写入数据文件失败（{}）：{err}", target.display()))?;
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    let mut hasher = Md5::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("读取源文件失败：{err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        writer
            .write_all(&buffer[..read])
            .map_err(|err| format!("写入数据文件失败：{err}"))?;
    }
    writer
        .flush()
        .map_err(|err| format!("刷新数据文件失败：{err}"))?;
    let digest = hasher.finalize();
    let sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((target, sha256))
}

/// 用 `dataset_profile.py` 画像一个数据文件，取 stdout 最后一个非空行
/// 解析 JSON（第三方库可能先打印告警）。
fn run_profile_script(exe: &Path, script: &Path, file: &Path) -> Result<Value, String> {
    if !script.is_file() {
        return Err(format!("画像脚本缺失：{}", script.display()));
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut command = StdCommand::new(exe);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(not(windows))]
    let mut cmd = StdCommand::new(exe);
    let output = cmd
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg(script)
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("无法运行画像脚本（{}）：{err}", exe.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|text| !text.is_empty())
        .unwrap_or("");
    let stderr = String::from_utf8_lossy(&output.stderr);
    let value: Value = serde_json::from_str(line).map_err(|err| {
        let snippet: String = line.chars().take(120).collect();
        let detail: String = stderr
            .lines()
            .rev()
            .map(str::trim)
            .find(|text| !text.is_empty())
            .unwrap_or("")
            .chars()
            .take(200)
            .collect();
        format!("画像脚本输出无法读取：{err}（输出片段：{snippet}；错误输出：{detail}）")
    })?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let error = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("未知原因");
        return Err(format!("数据集画像失败：{error}"));
    }
    Ok(value)
}

/// 归档 + 画像（阻塞，供 `spawn_blocking` 调用）：
/// 返回（归档后的文件路径、MD5、画像 JSON）。
pub(super) fn archive_and_profile(
    source: &Path,
    data_dir: &Path,
    root: &Path,
    need_excel: bool,
) -> Result<(PathBuf, String, Value), String> {
    let (target, sha256) = copy_with_md5(source, &root.join("data").join("original"))?;
    // 首次使用可能需要安装 openpyxl（xlsx）——耗时，故整段在阻塞线程里做。
    let exe = crate::infra::python_runtime::ensure_dataset_python(data_dir, need_excel)?;
    let profile = run_profile_script(&exe, &profile_script_path(), &target)?;
    Ok((target, sha256, profile))
}

/// 从分析脚本名生成安全的文件名 slug：保留字母 / 数字（含中文）与 `_-`，
/// 其余字符替换为单个下划线；空名回退为 `analysis_<时间戳>`。
pub(super) fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut last_sep = false;
    for ch in name.trim().chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch);
            last_sep = false;
        } else if !last_sep && !slug.is_empty() {
            slug.push('_');
            last_sep = true;
        }
    }
    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        return format!("analysis_{}", now_secs());
    }
    // Windows 文件名上限 255：给扩展名和序号留足余量。
    slug.chars().take(80).collect()
}

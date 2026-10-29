//! Interpreter invocation, site-packages enabling and zip extraction.

use std::path::Path;
use std::process::Command;

/// The `.pth` file that controls sys.path for the embeddable build.
const PTH_FILE: &str = "python312._pth";

/// Run the embedded interpreter with the given arguments, capturing nothing.
pub(super) fn run_python(exe: &Path, args: &[String], cwd: &Path) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    // pip derives its proxy from the environment; forward the user's egress
    // proxy setting when one is configured (domestic mirrors stay direct
    // via NO_PROXY).
    for (name, value) in crate::llm::api_keys::child_proxy_env() {
        cmd.env(name, value);
    }
    let status = cmd
        .status()
        .map_err(|err| format!("运行 {} 失败：{err}", exe.display()))?;
    if !status.success() {
        return Err(format!("Python 命令失败（退出码 {status}）"));
    }
    Ok(())
}

/// Append `Lib\site-packages` and `import site` to the `.pth` file so
/// pip-installed packages resolve.
pub(super) fn enable_site_packages(py_dir: &Path) -> Result<(), String> {
    let pth = py_dir.join(PTH_FILE);
    if !pth.is_file() {
        return Err(format!("找不到 {}（Python 版本可能不符）", pth.display()));
    }
    let content = std::fs::read_to_string(&pth).unwrap_or_default();
    let mut lines: Vec<String> = content
        .lines()
        .map(|line| line.trim_end().to_string())
        .collect();
    // Compute flags first, then mutate (avoid holding a borrow across push).
    let has_site_packages = lines.iter().any(|x| x.trim() == "Lib\\site-packages");
    let has_import_site = lines.iter().any(|x| x.trim() == "import site");
    if !has_site_packages {
        lines.push("Lib\\site-packages".to_string());
    }
    // Replace any commented `import site` and append a live one.
    lines.retain(|l| l.trim() != "#import site");
    if !has_import_site {
        lines.push("import site".to_string());
    }
    std::fs::write(&pth, lines.join("\n") + "\n")
        .map_err(|err| format!("写入 {} 失败：{err}", pth.display()))
}

/// Extract a zip archive into `target_dir` with a zip-slip guard.
pub(super) fn extract_zip(target_dir: &Path, bytes: &[u8]) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|err| format!("zip 解析失败：{err}"))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|err| format!("zip 读取失败：{err}"))?;
        let name = file.name().to_string();
        let out_path = target_dir.join(&name);
        if !out_path.starts_with(target_dir) {
            return Err(format!("zip 条目路径越界：{name}"));
        }
        if name.ends_with('/') {
            std::fs::create_dir_all(&out_path)
                .map_err(|err| format!("创建目录失败 {name}：{err}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("创建父目录失败 {name}：{err}"))?;
            }
            let mut out = std::fs::File::create(&out_path)
                .map_err(|err| format!("创建文件失败 {name}：{err}"))?;
            std::io::copy(&mut file, &mut out)
                .map_err(|err| format!("写入文件失败 {name}：{err}"))?;
        }
    }
    Ok(())
}

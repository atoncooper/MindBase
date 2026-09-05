//! Self-contained Python runtime provisioning.
//!
//! The desktop app must run ASR without relying on a user-managed Python /
//! pip — system environments have failed with broken states (e.g. a stale
//! `pygmentize.exe` blocking pip). On first use we provision a self-contained
//! Python into `<data_dir>/python`:
//!
//!   1. download the official Windows "embeddable" Python zip and extract it;
//!   2. enable `site-packages` in the `.pth` file so pip-installed packages
//!      (like dashscope) are importable;
//!   3. bootstrap pip (get-pip.py);
//!   4. install the dashscope SDK (cloud ASR path) or the faster-whisper /
//!      FastAPI stack (local ASR server path), on demand per caller.
//!
//! Everything lives under the app's own data dir, so it is portable and needs
//! no manual system fixes. `transcribe_via_python` runs the ASR worker with
//! this interpreter, falling back to system `python`/`py` only if provisioning
//! fails. The local whisper server (`scripts/whisper_server.py`, managed by
//! `whisper_server.rs`) runs under the same runtime.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::asr::StageLog;

/// The Windows embeddable Python distribution to fetch — tried in order,
/// domestic mirrors first (the official python.org host is often slow or
/// unreachable from mainland networks).
const PY_EMBED_URLS: &[&str] = &[
    "https://mirrors.huaweicloud.com/python/3.12.7/python-3.12.7-embed-amd64.zip",
    "https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip",
];
/// The `.pth` file that controls sys.path for the embeddable build.
const PTH_FILE: &str = "python312._pth";
/// get-pip.py mirrors (domestic first).
const GET_PIP_URLS: &[&str] = &[
    "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/get-pip.py",
    "https://bootstrap.pypa.io/get-pip.py",
];
/// PyPI indexes for `pip install dashscope` (domestic first, official last).
const PIP_INDEXES: &[&str] = &[
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.org/simple",
];
const USER_AGENT: &str = "mind-base-desktop/0.1";

/// Directory that hosts the embedded runtime.
pub(crate) fn python_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("python")
}

/// Path to the embedded interpreter.
pub(crate) fn python_exe(data_dir: &Path) -> PathBuf {
    python_dir(data_dir).join("python.exe")
}

/// Install a package (or several) into the embedded Python, trying each PyPI
/// index in turn (domestic mirrors first) until one succeeds.
fn install_packages(exe: &Path, py_dir: &Path, packages: &[&str]) -> Result<(), String> {
    let mut last_err = String::new();
    for index in PIP_INDEXES {
        let mut args = vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--quiet".to_string(),
            "-i".to_string(),
            index.to_string(),
        ];
        args.extend(packages.iter().map(|p| p.to_string()));
        match run_python(exe, &args, py_dir) {
            Ok(()) => return Ok(()),
            Err(err) => last_err = format!("{index}: {err}"),
        }
    }
    Err(format!("安装失败（所有源）：{last_err}"))
}

/// Whether the embedded interpreter can import one module.
fn can_import(exe: &Path, module: &str) -> bool {
    Command::new(exe)
        .args(["-c", &format!("import {module}")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Ensure the embedded Python can import the local whisper server's
/// dependencies (faster-whisper + FastAPI stack), installing them on first
/// use. Returns the interpreter path. Used by the local ASR server manager.
pub(crate) fn ensure_server_deps(data_dir: &Path) -> Result<PathBuf, String> {
    // `multipart` is the import name of the python-multipart package, which
    // FastAPI's file-upload endpoints (`UploadFile = File(...)`) require.
    const REQUIRED: &[&str] = &["faster_whisper", "fastapi", "uvicorn", "multipart"];
    const PACKAGES: &[&str] = &["faster-whisper", "fastapi", "uvicorn", "python-multipart"];
    let exe = python_exe(data_dir);
    if exe.is_file() && REQUIRED.iter().all(|m| can_import(&exe, m)) {
        return Ok(exe);
    }
    ensure_python_base(data_dir)?;
    let exe = python_exe(data_dir);
    if !REQUIRED.iter().all(|m| can_import(&exe, m)) {
        crate::logging::info(
            "python",
            "安装本地 ASR 服务依赖（faster-whisper / FastAPI）…",
        );
        install_packages(&exe, &python_dir(data_dir), PACKAGES)?;
        crate::logging::info("python", "本地 ASR 服务依赖安装完成");
    }
    Ok(exe)
}

/// Ensure an interpreter able to run `scripts/doc_extract.py`, installing
/// pymupdf / python-docx / readability-lxml into the embedded runtime only
/// when the batch actually needs them (txt/md need nothing beyond the
/// stdlib; html prefers readability but degrades to the naive extractor).
///
/// Preference order when no extra deps are required: the embedded runtime if
/// already provisioned, then a system `python`/`py` (reading a text file
/// doesn't justify a runtime download), and only as a last resort a full
/// embedded-runtime provisioning.
pub(crate) fn ensure_doc_extract_python(
    data_dir: &Path,
    need_pdf: bool,
    need_docx: bool,
    need_readability: bool,
) -> Result<PathBuf, String> {
    let mut required: Vec<&str> = Vec::new();
    let mut packages: Vec<&str> = Vec::new();
    if need_pdf {
        required.push("fitz");
        packages.push("pymupdf");
    }
    if need_docx {
        required.push("docx");
        packages.push("python-docx");
    }
    if need_readability {
        required.push("readability");
        packages.push("readability-lxml");
    }

    let exe = python_exe(data_dir);
    if exe.is_file() && required.iter().all(|m| can_import(&exe, m)) {
        return Ok(exe);
    }
    if !required.is_empty() {
        ensure_python_base(data_dir)?;
        let exe = python_exe(data_dir);
        if !required.iter().all(|m| can_import(&exe, m)) {
            crate::logging::info("python", "安装文档解析依赖（pymupdf / python-docx）…");
            install_packages(&exe, &python_dir(data_dir), &packages)?;
            crate::logging::info("python", "文档解析依赖安装完成");
        }
        if !required.iter().all(|m| can_import(&exe, m)) {
            return Err("嵌入式 Python 已就绪但文档解析依赖不可用".to_string());
        }
        return Ok(exe);
    }
    if exe.is_file() {
        return Ok(exe);
    }
    for candidate in ["python", "py"] {
        let usable = Command::new(candidate)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if usable {
            return Ok(PathBuf::from(candidate));
        }
    }
    crate::logging::info("python", "未找到系统 Python，开始下载嵌入式运行时…");
    ensure_python_base(data_dir)?;
    Ok(python_exe(data_dir))
}

/// Ensure the embedded Python can run the PPT renderer (`python-pptx`),
/// installing it on first use. Returns the interpreter path.
pub(crate) fn ensure_pptx_python(data_dir: &Path) -> Result<PathBuf, String> {
    const REQUIRED: &[&str] = &["pptx"];
    const PACKAGES: &[&str] = &["python-pptx"];
    let exe = python_exe(data_dir);
    if exe.is_file() && REQUIRED.iter().all(|m| can_import(&exe, m)) {
        return Ok(exe);
    }
    ensure_python_base(data_dir)?;
    let exe = python_exe(data_dir);
    if !REQUIRED.iter().all(|m| can_import(&exe, m)) {
        crate::logging::info("python", "安装 PPT 渲染依赖（python-pptx）…");
        install_packages(&exe, &python_dir(data_dir), PACKAGES)?;
        crate::logging::info("python", "PPT 渲染依赖安装完成");
    }
    if !REQUIRED.iter().all(|m| can_import(&exe, m)) {
        return Err("嵌入式 Python 已就绪但 python-pptx 不可用".to_string());
    }
    Ok(exe)
}

/// Whether the installed onnxruntime exposes the CUDA execution provider.
fn onnxruntime_has_cuda(exe: &Path) -> bool {
    Command::new(exe)
        .args([
            "-c",
            "import onnxruntime; print('CUDAExecutionProvider' in onnxruntime.get_available_providers())",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "True")
        .unwrap_or(false)
}

/// Swap the CPU onnxruntime for the GPU build when the OCR device setting
/// asks for CUDA. CPU and GPU builds must not coexist in one environment
/// (double registration), and the GPU build alone still serves CPU — so the
/// swap is one-way. A failed swap is not fatal: the OCR script degrades to
/// CPU at runtime.
fn ensure_onnxruntime_gpu(exe: &Path, py_dir: &Path) {
    if onnxruntime_has_cuda(exe) {
        return;
    }
    crate::logging::info("python", "OCR 设备为 CUDA：安装 onnxruntime-gpu…");
    let uninstall = Command::new(exe)
        .args(["-m", "pip", "uninstall", "-y", "onnxruntime"])
        .current_dir(py_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !uninstall {
        crate::logging::warn("python", "卸载 CPU onnxruntime 失败，CUDA 可能不可用");
    }
    if let Err(err) = install_packages(exe, py_dir, &["onnxruntime-gpu"]) {
        crate::logging::warn(
            "python",
            &format!("onnxruntime-gpu 安装失败（将回退 CPU）：{err}"),
        );
        // Restore a CPU build so OCR keeps working.
        let _ = install_packages(exe, py_dir, &["onnxruntime"]);
        return;
    }
    if !onnxruntime_has_cuda(exe) {
        crate::logging::warn(
            "python",
            "onnxruntime-gpu 已安装但 CUDA 提供方不可用（驱动/CUDA 环境？），运行时将回退 CPU",
        );
    }
}

/// Ensure an interpreter able to run `scripts/ocr_extract.py`: the embedded
/// runtime with rapidocr-onnxruntime (+ pymupdf when a PDF may need page
/// rendering). Returns the interpreter path.
pub(crate) fn ensure_ocr_python(
    data_dir: &Path,
    need_pdf: bool,
    device: &str,
) -> Result<PathBuf, String> {
    let mut required: Vec<&str> = vec!["rapidocr_onnxruntime"];
    let mut packages: Vec<&str> = vec!["rapidocr-onnxruntime"];
    if need_pdf {
        required.push("fitz");
        packages.push("pymupdf");
    }
    let exe = python_exe(data_dir);
    if exe.is_file() && required.iter().all(|m| can_import(&exe, m)) {
        if device == "cuda" {
            ensure_onnxruntime_gpu(&exe, &python_dir(data_dir));
        }
        return Ok(exe);
    }
    ensure_python_base(data_dir)?;
    let exe = python_exe(data_dir);
    if !required.iter().all(|m| can_import(&exe, m)) {
        crate::logging::info(
            "python",
            "安装本地 OCR 依赖（rapidocr-onnxruntime / pymupdf）…",
        );
        install_packages(&exe, &python_dir(data_dir), &packages)?;
        crate::logging::info("python", "本地 OCR 依赖安装完成");
    }
    if device == "cuda" {
        ensure_onnxruntime_gpu(&exe, &python_dir(data_dir));
    }
    if !required.iter().all(|m| can_import(&exe, m)) {
        return Err("嵌入式 Python 已就绪但本地 OCR 依赖不可用".to_string());
    }
    Ok(exe)
}

/// Provision the embedded runtime skeleton (download, .pth, pip bootstrap)
/// without installing any extra package. Shared by the dashscope (cloud ASR)
/// and whisper-server (local ASR) paths. Returns the interpreter path.
///
/// Windows-only for now: the embeddable distribution and the pip bootstrap
/// layout are Windows-specific. On macOS the caller degrades to a system
/// `python3` where possible (plain text extraction) and the local ASR / OCR
/// features report this error instead of a cryptic download failure.
fn ensure_python_base(data_dir: &Path) -> Result<PathBuf, String> {
    if cfg!(not(windows)) {
        return Err(
            "本地 Python 运行时暂未适配 macOS（本地 ASR / 本地 OCR / 带依赖的文档解析不可用），\
             请使用云端模式"
                .to_string(),
        );
    }
    let exe = python_exe(data_dir);
    let py_dir = python_dir(data_dir);
    if !exe.is_file() {
        std::fs::create_dir_all(&py_dir)
            .map_err(|err| format!("无法创建 Python 目录 {}：{err}", py_dir.display()))?;
        crate::logging::info("python", "下载嵌入式 Python 运行时…");
        let bytes = download_bytes(PY_EMBED_URLS)?;
        extract_zip(&py_dir, &bytes)?;
        crate::logging::info("python", "嵌入式 Python 解压完成");
        if !exe.is_file() {
            return Err(format!("嵌入 Python 解压后缺少 {}", exe.display()));
        }
    }
    enable_site_packages(&py_dir)?;
    if !py_dir.join("Scripts").join("pip.exe").is_file() {
        crate::logging::info("python", "引导 pip…");
        let get_pip = download_bytes(GET_PIP_URLS)?;
        let tmp = py_dir.join("get-pip.py");
        std::fs::write(&tmp, &get_pip).map_err(|err| format!("写入 get-pip.py 失败：{err}"))?;
        let run_result = run_python(
            &exe,
            &[
                tmp.to_string_lossy().to_string(),
                "--no-warn-script-location".to_string(),
            ],
            &py_dir,
        );
        let _ = std::fs::remove_file(&tmp);
        run_result?;
        crate::logging::info("python", "pip 引导完成");
    }
    Ok(exe)
}

/// Ensure a working embedded Python (with dashscope) under `data_dir`.
///
/// Idempotent: returns early when the runtime already exists and dashscope is
/// importable. Provisioning failures are returned so callers can fall back to
/// the system interpreter.
pub(crate) fn ensure_python(data_dir: &Path, on_stage: &StageLog) -> Result<PathBuf, String> {
    let exe = python_exe(data_dir);
    if exe.is_file() && can_import(&exe, "dashscope") {
        return Ok(exe);
    }
    ensure_python_base(data_dir)?;
    let exe = python_exe(data_dir);
    if !can_import(&exe, "dashscope") {
        on_stage("安装 dashscope SDK…");
        crate::logging::info("python", "安装 dashscope SDK…");
        install_packages(&exe, &python_dir(data_dir), &["dashscope"])?;
        crate::logging::info("python", "dashscope 安装完成");
    }
    if !can_import(&exe, "dashscope") {
        return Err("嵌入式 Python 已就绪但 dashscope 不可用".to_string());
    }
    Ok(exe)
}

/// Run the embedded interpreter with the given arguments, capturing nothing.
fn run_python(exe: &Path, args: &[String], cwd: &Path) -> Result<(), String> {
    let status = Command::new(exe)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status()
        .map_err(|err| format!("运行 {} 失败：{err}", exe.display()))?;
    if !status.success() {
        return Err(format!("Python 命令失败（退出码 {status}）"));
    }
    Ok(())
}

/// Append `Lib\site-packages` and `import site` to the `.pth` file so
/// pip-installed packages resolve.
fn enable_site_packages(py_dir: &Path) -> Result<(), String> {
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

/// Download from the first URL that works (domestic mirrors first, so a
/// mainland network still succeeds when the official host is blocked/slow).
fn download_bytes(urls: &[&str]) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();
    for url in urls {
        match download_one(url) {
            Ok(bytes) => return Ok(bytes),
            Err(err) => last_err = format!("{url}: {err}"),
        }
    }
    Err(format!("所有下载源均失败：{last_err}"))
}

/// Download a single URL into memory with a generous timeout.
fn download_one(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(300))
        .user_agent(USER_AGENT)
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|err| format!("下载失败：{err}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    response
        .into_reader()
        .take(512 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("读取下载内容失败：{err}"))?;
    Ok(bytes)
}

/// Extract a zip archive into `target_dir` with a zip-slip guard.
fn extract_zip(target_dir: &Path, bytes: &[u8]) -> Result<(), String> {
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

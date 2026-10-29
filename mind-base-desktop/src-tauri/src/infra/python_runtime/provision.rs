//! Embedded-runtime provisioning and per-feature dependency sets.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::download::download_bytes;
use super::layout::{python_dir, python_exe};
use super::onnx::ensure_onnxruntime_gpu;
use super::scripts::{enable_site_packages, extract_zip, run_python};
use crate::media::asr::StageLog;

/// The Windows embeddable Python distribution to fetch — tried in order,
/// domestic mirrors first (the official python.org host is often slow or
/// unreachable from mainland networks).
const PY_EMBED_URLS: &[&str] = &[
    "https://mirrors.huaweicloud.com/python/3.12.7/python-3.12.7-embed-amd64.zip",
    "https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip",
];

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

/// Install a package (or several) into the embedded Python, trying each PyPI
/// index in turn (domestic mirrors first) until one succeeds.
pub(super) fn install_packages(exe: &Path, py_dir: &Path, packages: &[&str]) -> Result<(), String> {
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
        crate::infra::logging::info(
            "python",
            "安装本地 ASR 服务依赖（faster-whisper / FastAPI）…",
        );
        install_packages(&exe, &python_dir(data_dir), PACKAGES)?;
        crate::infra::logging::info("python", "本地 ASR 服务依赖安装完成");
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
            crate::infra::logging::info("python", "安装文档解析依赖（pymupdf / python-docx）…");
            install_packages(&exe, &python_dir(data_dir), &packages)?;
            crate::infra::logging::info("python", "文档解析依赖安装完成");
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
    crate::infra::logging::info("python", "未找到系统 Python，开始下载嵌入式运行时…");
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
        crate::infra::logging::info("python", "安装 PPT 渲染依赖（python-pptx）…");
        install_packages(&exe, &python_dir(data_dir), PACKAGES)?;
        crate::infra::logging::info("python", "PPT 渲染依赖安装完成");
    }
    if !REQUIRED.iter().all(|m| can_import(&exe, m)) {
        return Err("嵌入式 Python 已就绪但 python-pptx 不可用".to_string());
    }
    Ok(exe)
}

/// 找到一个可用的系统 Python（`python` / `python3` / `py`）。
///
/// 仅作为降级路径使用：嵌入式运行时尚未就绪、且任务不需要任何第三方
/// 依赖时（例如纯 CSV 画像），没必要为了一个标准库脚本下载整套运行时。
fn find_system_python() -> Option<PathBuf> {
    for candidate in ["python", "python3", "py"] {
        let usable = Command::new(candidate)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if usable {
            return Some(PathBuf::from(candidate));
        }
    }
    None
}

/// 确保有解释器能运行 `scripts/dataset_profile.py`（数据集导入画像）。
///
/// - CSV 画像只用标准库：已有嵌入式运行时就用它，否则先用系统 Python，
///   避免为导入一个纯文本表就下载整套运行时；
/// - xlsx 画像需要 openpyxl：安装到嵌入式运行时（首次使用可能较慢）。
/// 返回解释器路径。
pub(crate) fn ensure_dataset_python(data_dir: &Path, need_excel: bool) -> Result<PathBuf, String> {
    if !need_excel {
        let exe = python_exe(data_dir);
        if exe.is_file() {
            return Ok(exe);
        }
        if let Some(system) = find_system_python() {
            return Ok(system);
        }
        // 系统也没有 Python：退回嵌入式运行时（下载 + 引导 pip）。
        ensure_python_base(data_dir)?;
        return Ok(python_exe(data_dir));
    }

    const REQUIRED: &[&str] = &["openpyxl"];
    const PACKAGES: &[&str] = &["openpyxl"];
    let exe = python_exe(data_dir);
    if exe.is_file() && REQUIRED.iter().all(|module| can_import(&exe, module)) {
        return Ok(exe);
    }
    ensure_python_base(data_dir)?;
    let exe = python_exe(data_dir);
    if !REQUIRED.iter().all(|module| can_import(&exe, module)) {
        crate::infra::logging::info("python", "安装数据集画像依赖（openpyxl）…");
        install_packages(&exe, &python_dir(data_dir), PACKAGES)?;
        crate::infra::logging::info("python", "数据集画像依赖安装完成");
    }
    if !REQUIRED.iter().all(|module| can_import(&exe, module)) {
        return Err("嵌入式 Python 已就绪但 openpyxl 不可用（xlsx 画像依赖）".to_string());
    }
    Ok(exe)
}

/// 确保嵌入式 Python 能执行用户分析脚本（`analysis_run`）：
/// pandas / numpy / matplotlib / openpyxl 按需安装（首次可能数分钟）。
/// 返回解释器路径。
pub(crate) fn ensure_analysis_python(data_dir: &Path) -> Result<PathBuf, String> {
    const REQUIRED: &[&str] = &["pandas", "numpy", "matplotlib", "openpyxl"];
    const PACKAGES: &[&str] = &["pandas", "numpy", "matplotlib", "openpyxl"];
    let exe = python_exe(data_dir);
    if exe.is_file() && REQUIRED.iter().all(|module| can_import(&exe, module)) {
        return Ok(exe);
    }
    ensure_python_base(data_dir)?;
    let exe = python_exe(data_dir);
    if !REQUIRED.iter().all(|module| can_import(&exe, module)) {
        crate::infra::logging::info(
            "python",
            "安装分析脚本依赖（pandas / numpy / matplotlib / openpyxl）…",
        );
        install_packages(&exe, &python_dir(data_dir), PACKAGES)?;
        crate::infra::logging::info("python", "分析脚本依赖安装完成");
    }
    if !REQUIRED.iter().all(|module| can_import(&exe, module)) {
        return Err(
            "嵌入式 Python 已就绪但分析依赖（pandas / numpy / matplotlib / openpyxl）不可用"
                .to_string(),
        );
    }
    Ok(exe)
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
        crate::infra::logging::info(
            "python",
            "安装本地 OCR 依赖（rapidocr-onnxruntime / pymupdf）…",
        );
        install_packages(&exe, &python_dir(data_dir), &packages)?;
        crate::infra::logging::info("python", "本地 OCR 依赖安装完成");
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
        crate::infra::logging::info("python", "下载嵌入式 Python 运行时…");
        let bytes = download_bytes(PY_EMBED_URLS)?;
        extract_zip(&py_dir, &bytes)?;
        crate::infra::logging::info("python", "嵌入式 Python 解压完成");
        if !exe.is_file() {
            return Err(format!("嵌入 Python 解压后缺少 {}", exe.display()));
        }
    }
    enable_site_packages(&py_dir)?;
    if !py_dir.join("Scripts").join("pip.exe").is_file() {
        crate::infra::logging::info("python", "引导 pip…");
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
        crate::infra::logging::info("python", "pip 引导完成");
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
        crate::infra::logging::info("python", "安装 dashscope SDK…");
        install_packages(&exe, &python_dir(data_dir), &["dashscope"])?;
        crate::infra::logging::info("python", "dashscope 安装完成");
    }
    if !can_import(&exe, "dashscope") {
        return Err("嵌入式 Python 已就绪但 dashscope 不可用".to_string());
    }
    Ok(exe)
}

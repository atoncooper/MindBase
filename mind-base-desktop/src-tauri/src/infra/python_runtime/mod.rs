//! Self-contained Python runtime provisioning (cross-platform).
//!
//! 桌面端依赖 Python 的功能（ASR / 写作导出 DOCX / DOCX/PDF 预览 / 数据集画像 /
//! 分析脚本 / PPTX）需要一个可控的解释器，不能依赖用户手工维护的系统 pip 环境。
//!
//! 平台策略：
//! - Windows：下载官方 "embeddable" Python zip 解压到 <data_dir>/python，
//!   启用 .pth 的 site-packages（pip 安装的包可 import），用 get-pip.py 引导 pip；
//! - macOS / Linux：用系统 python3 执行 "-m venv <data_dir>/python-venv"
//!   创建虚拟环境（已存在则复用），pip 缺失时用 ensurepip 兜底；依赖 pip 安装
//!   到该 venv，不污染系统环境。前置：python3 + python3-venv / python3-pip。
//!
//! 之后按调用方需要安装 dashscope SDK、faster-whisper/FastAPI（本地 ASR）等。
//! transcribe_via_python 用这个解释器跑 ASR worker，失败时才回退系统 python/py。
//! 本地 whisper server（scripts/whisper_server.py）也运行在同一运行时上。
//!
//! - layout：运行时在数据目录中的位置（Windows 嵌入版 / macOS+Linux venv）。
//! - provision：运行时创建与按功能安装依赖。
//! - onnx：CUDA OCR 的 onnxruntime-gpu 替换（仅 Windows）。
//! - download：Windows 嵌入运行时的镜像下载。
//! - scripts：解释器调用、site-packages 与 zip 解压。

#[cfg(windows)]
mod download;
mod layout;
mod onnx;
mod provision;
mod scripts;

#[allow(unused_imports)]
pub(crate) use layout::{python_dir, python_exe};
pub(crate) use provision::{
    ensure_analysis_python, ensure_dataset_python, ensure_doc_extract_python, ensure_ocr_python,
    ensure_pptx_python, ensure_python, ensure_server_deps,
};

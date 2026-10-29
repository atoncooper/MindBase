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
//!
//! - [`layout`] — where the runtime lives inside the data directory.
//! - [`provision`] — runtime provisioning and per-feature dependency sets.
//! - [`onnx`] — onnxruntime GPU swap for CUDA OCR.
//! - [`download`] — mirrored downloads for runtime assets.
//! - [`scripts`] — interpreter invocation, site-packages and zip extraction.

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

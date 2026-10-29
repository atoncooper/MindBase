//! onnxruntime GPU swap for the local OCR path.

use std::path::Path;
use std::process::Command;

use super::provision::install_packages;

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
pub(super) fn ensure_onnxruntime_gpu(exe: &Path, py_dir: &Path) {
    if onnxruntime_has_cuda(exe) {
        return;
    }
    crate::infra::logging::info("python", "OCR 设备为 CUDA：安装 onnxruntime-gpu…");
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
        crate::infra::logging::warn("python", "卸载 CPU onnxruntime 失败，CUDA 可能不可用");
    }
    if let Err(err) = install_packages(exe, py_dir, &["onnxruntime-gpu"]) {
        crate::infra::logging::warn(
            "python",
            &format!("onnxruntime-gpu 安装失败（将回退 CPU）：{err}"),
        );
        // Restore a CPU build so OCR keeps working.
        let _ = install_packages(exe, py_dir, &["onnxruntime"]);
        return;
    }
    if !onnxruntime_has_cuda(exe) {
        crate::infra::logging::warn(
            "python",
            "onnxruntime-gpu 已安装但 CUDA 提供方不可用（驱动/CUDA 环境？），运行时将回退 CPU",
        );
    }
}

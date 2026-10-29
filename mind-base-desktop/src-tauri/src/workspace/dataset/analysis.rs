//! Analysis script execution: embedded Python, hard timeout and captured output.

use std::io::Read;
use std::path::Path;
use std::process::{Command as StdCommand, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::AnalysisResult;

/// 分析脚本的默认执行超时（超时即 kill 子进程）。
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(120);

/// 轮询子进程退出状态的间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 读完一个被接管子进程的管道（stdout / stderr）。
fn read_pipe<R: Read>(pipe: Option<R>) -> Vec<u8> {
    let mut buffer = Vec::new();
    if let Some(mut pipe) = pipe {
        // 读失败不致命：保留已读到的部分输出。
        let _ = pipe.read_to_end(&mut buffer);
    }
    buffer
}

/// 执行分析脚本（阻塞，供 `spawn_blocking` 调用）：
/// 写脚本 → 以项目根目录为 cwd 跑 Python（120s 超时 kill）→ stdout 落文件。
pub(super) fn run_analysis_script(
    data_dir: &Path,
    root: &Path,
    slug: &str,
    script: &str,
) -> Result<AnalysisResult, String> {
    let scripts_dir = root.join("analysis").join("scripts");
    let outputs_dir = root.join("analysis").join("outputs");
    std::fs::create_dir_all(&scripts_dir)
        .map_err(|err| format!("无法创建脚本目录 {}：{err}", scripts_dir.display()))?;
    std::fs::create_dir_all(&outputs_dir)
        .map_err(|err| format!("无法创建输出目录 {}：{err}", outputs_dir.display()))?;

    let script_path = scripts_dir.join(format!("{slug}.py"));
    // 统一换行并补尾换行，避免 Windows 下末行被截断导致的语法问题。
    let mut body = script.replace("\r\n", "\n").replace('\r', "\n");
    if !body.ends_with('\n') {
        body.push('\n');
    }
    std::fs::write(&script_path, body.as_bytes())
        .map_err(|err| format!("写入分析脚本失败（{}）：{err}", script_path.display()))?;

    let exe = crate::infra::python_runtime::ensure_analysis_python(data_dir)?;

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut command = StdCommand::new(&exe);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(not(windows))]
    let mut cmd = StdCommand::new(&exe);
    let mut child = cmd
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .current_dir(root)
        .arg(&script_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("无法启动分析脚本（{}）：{err}", exe.display()))?;

    // 轮询期间必须持续读走 stdout / stderr：管道缓冲区写满会让子进程阻塞，
    // try_wait 就永远等不到退出。
    let stdout_reader = thread::spawn({
        let pipe = child.stdout.take();
        move || read_pipe(pipe)
    });
    let stderr_reader = thread::spawn({
        let pipe = child.stderr.take();
        move || read_pipe(pipe)
    });

    let deadline = Instant::now() + ANALYSIS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    // 超时：先 kill 再 wait，随后读取线程因管道关闭而结束。
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!(
                        "分析脚本执行超时（{} 秒），已强制终止",
                        ANALYSIS_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("等待分析脚本退出失败：{err}"));
            }
        }
    };

    let stdout = String::from_utf8_lossy(&stdout_reader.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&stderr_reader.join().unwrap_or_default()).to_string();
    let exit_code = status.code().unwrap_or(-1);

    let output_path = outputs_dir.join(format!("{slug}.txt"));
    if let Err(err) = std::fs::write(&output_path, stdout.as_bytes()) {
        crate::infra::logging::warn(
            "dataset",
            &format!("分析输出写入失败（{}）：{err}", output_path.display()),
        );
    }

    Ok(AnalysisResult {
        stdout,
        stderr,
        exit_code,
        script_path: script_path.to_string_lossy().to_string(),
    })
}

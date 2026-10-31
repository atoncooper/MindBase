//! Windows 沙箱后端：AppContainer + Job Object（windows-rs 直接实现）。
//!
//! 沙箱进程以 app container SID 运行；stdout/stderr 直接重定向到文件（不经管道/内存）。
//! 文件 ACL 只授权沙箱目录（icacls），默认无 capability => 无网络；network=on 时把
//! internetClient 能力 SID 放进 SECURITY_CAPABILITIES 放行网络，文件隔离不变。
//!
//! 说明：曾尝试复用 rappct 0.13 的 launch 封装，但其 CreateProcessW 在本机
//! （Windows 11 25H2 / build 26200）稳定返回 E_INVALIDARG，因此保留自实现；
//! 库调研见 docs/desktop-rust-architecture.md §8。

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, HANDLE, HLOCAL, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSidToSidW,
};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{
    PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_CREATION_DISPOSITION, FILE_SHARE_MODE,
};
/// GENERIC_WRITE（winnt.h）。
const GENERIC_WRITE: u32 = 0x4000_0000;
const FILE_SHARE_READ_WRITE: FILE_SHARE_MODE = FILE_SHARE_MODE(0x1 | 0x2);
const CREATE_ALWAYS_DISPOSITION: FILE_CREATION_DISPOSITION = FILE_CREATION_DISPOSITION(2);
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, STARTUPINFOW,
};

use super::{SandboxNetwork, SandboxOutput, SandboxShell};

/// 每个用户一份 AppContainer profile（重复创建幂等）。
const PROFILE_NAME: &str = "MindBase.Sandbox";

fn hstring(value: &str) -> HSTRING {
    HSTRING::from(value)
}

fn profile_sid() -> Result<PSID, String> {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let name = hstring(PROFILE_NAME);
        unsafe {
            let _ = CreateAppContainerProfile(
                &name,
                &hstring("MindBase Sandbox"),
                &hstring("MindBase sandboxed command execution"),
                None,
            );
        }
    });
    let name = hstring(PROFILE_NAME);
    unsafe {
        DeriveAppContainerSidFromAppContainerName(&name)
            .map_err(|err| format!("无法获取 AppContainer profile SID：{err}"))
    }
}

fn sid_to_string(sid: PSID) -> Result<String, String> {
    let mut raw = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut raw).map_err(|err| format!("SID 转换失败：{err}"))?;
        let text = raw
            .to_string()
            .map_err(|err| format!("SID 转字符串失败：{err}"))?;
        let _ = LocalFree(Some(HLOCAL(raw.0 as *mut c_void)));
        Ok(text)
    }
}

fn capability_sid(sid_text: &str) -> Result<PSID, String> {
    let mut sid = PSID(std::ptr::null_mut());
    unsafe {
        ConvertStringSidToSidW(&hstring(sid_text), &mut sid)
            .map_err(|err| format!("创建能力 SID（{sid_text}）失败：{err}"))?;
    }
    Ok(sid)
}

fn grant_sandbox_acl(dir: &Path, sid_text: &str) -> Result<(), String> {
    let status = std::process::Command::new("icacls")
        .arg(dir)
        .arg("/grant")
        .arg(format!("*{sid_text}:(OI)(CI)M"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|err| format!("无法执行 icacls 授予沙箱目录权限：{err}"))?;
    if !status.success() {
        return Err(format!("icacls 授予沙箱目录权限失败（退出码 {:?}）", status.code()));
    }
    Ok(())
}

fn system_exe(relative: &str) -> Result<PathBuf, String> {
    let root = std::env::var_os("SystemRoot")
        .ok_or("无法获取 SystemRoot，Windows 沙箱不可用")?;
    let path = PathBuf::from(root).join("System32").join(relative);
    if !path.is_file() {
        return Err(format!("沙箱目标可执行文件不存在：{}", path.display()));
    }
    Ok(path)
}

pub(super) fn run(
    command: &str,
    shell: SandboxShell,
    dir: &Path,
    timeout: Duration,
    network: SandboxNetwork,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<SandboxOutput, String> {
    let sid = profile_sid()?;
    let sid_text = sid_to_string(sid)?;
    grant_sandbox_acl(dir, &sid_text)?;

    // 命令写成沙箱内脚本文件再执行，避免命令行引号/转义问题；PowerShell
    // 脚本带 UTF-8 BOM，保证 Windows PowerShell 5.1 正确识别中文。
    let (script_name, script_body, program, args) = match shell {
        SandboxShell::Pwsh => (
            ".mindbase-run.ps1",
            format!("\u{FEFF}{command}"),
            system_exe("WindowsPowerShell\\v1.0\\powershell.exe")?,
            vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                ".mindbase-run.ps1".to_string(),
            ],
        ),
        SandboxShell::Cmd => (
            ".mindbase-run.bat",
            command.to_string(),
            system_exe("cmd.exe")?,
            vec!["/C".to_string(), ".mindbase-run.bat".to_string()],
        ),
        SandboxShell::Bash => {
            return Err("Windows 沙箱不支持 bash；请使用 pwsh 或 cmd".to_string())
        }
    };
    let script_path = dir.join(script_name);
    std::fs::write(&script_path, script_body.as_bytes())
        .map_err(|err| format!("写入沙箱脚本失败（{}）：{err}", script_path.display()))?;
    let result = spawn_to_files(
        &program.to_string_lossy(),
        &args,
        dir,
        sid,
        network,
        timeout,
        stdout_path,
        stderr_path,
    );
    let _ = std::fs::remove_file(&script_path);
    result
}

/// 属性表内存的 RAII 清理。
struct Cleanup {
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
    layout: std::alloc::Layout,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if !self.list.0.is_null() {
            unsafe {
                DeleteProcThreadAttributeList(self.list);
                std::alloc::dealloc(self.list.0 as *mut u8, self.layout);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_to_files(
    program: &str,
    args: &[String],
    dir: &Path,
    sid: PSID,
    network: SandboxNetwork,
    timeout: Duration,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<SandboxOutput, String> {
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: true.into(),
    };
    // stdout/stderr 直接写宿主文件：句柄可继承，子进程写，父进程只读大小/摘要。
    let out_handle = unsafe {
        CreateFileW(
            &hstring(&stdout_path.to_string_lossy()),
            GENERIC_WRITE,
            FILE_SHARE_READ_WRITE,
            Some(&sa),
            CREATE_ALWAYS_DISPOSITION,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .map_err(|err| format!("创建 stdout 日志失败（{}）：{err}", stdout_path.display()))?;
    let err_handle = match unsafe {
        CreateFileW(
            &hstring(&stderr_path.to_string_lossy()),
            GENERIC_WRITE,
            FILE_SHARE_READ_WRITE,
            Some(&sa),
            CREATE_ALWAYS_DISPOSITION,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    } {
        Ok(handle) => handle,
        Err(err) => {
            unsafe {
                let _ = CloseHandle(out_handle);
            }
            return Err(format!("创建 stderr 日志失败（{}）：{err}", stderr_path.display()));
        }
    };

    let mut size = 0usize;
    unsafe {
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
    }
    if size == 0 {
        unsafe {
            let _ = CloseHandle(out_handle);
            let _ = CloseHandle(err_handle);
        }
        return Err("初始化进程属性表失败（size=0）".to_string());
    }
    let layout = std::alloc::Layout::from_size_align(size, 8)
        .map_err(|err| format!("属性表内存布局失败：{err}"))?;
    let list_mem = unsafe { std::alloc::alloc(layout) };
    if list_mem.is_null() {
        return Err("属性表内存分配失败".to_string());
    }
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(list_mem as *mut c_void);
    let cleanup = Cleanup { list, layout };
    unsafe {
        InitializeProcThreadAttributeList(Some(list), 1, None, &mut size)
            .map_err(|err| format!("初始化进程属性表失败：{err}"))?;
    }

    let mut capability_storage: Option<Box<[SID_AND_ATTRIBUTES; 1]>> = None;
    let mut capability_sids: Vec<PSID> = Vec::new();
    let mut capability_ptr: *mut SID_AND_ATTRIBUTES = std::ptr::null_mut();
    let mut capability_count = 0u32;
    if network == SandboxNetwork::On {
        let cap = capability_sid("S-1-15-3-1")?;
        capability_sids.push(cap);
        let mut storage = Box::new([SID_AND_ATTRIBUTES {
            Sid: cap,
            // SE_GROUP_ENABLED = 4。
            Attributes: 4,
        }]);
        capability_ptr = storage.as_mut_ptr();
        capability_count = 1;
        capability_storage = Some(storage);
    }
    let caps = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: capability_ptr,
        CapabilityCount: capability_count,
        Reserved: 0,
    };
    unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(&caps as *const _ as *const c_void),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .map_err(|err| format!("设置 AppContainer 能力失败：{err}"))?;
    }

    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = HANDLE::default();
    startup.StartupInfo.hStdOutput = out_handle;
    startup.StartupInfo.hStdError = err_handle;
    startup.lpAttributeList = list;

    let command_line = format!("\"{program}\" {}", args.join(" "));
    let mut wide: Vec<u16> = command_line
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let cwd = hstring(&dir.to_string_lossy());
    let mut process_info = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(wide.as_mut_ptr())),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT,
            None,
            &cwd,
            &startup as *const STARTUPINFOEXW as *const STARTUPINFOW,
            &mut process_info,
        )
    };
    drop(cleanup);
    unsafe {
        let _ = CloseHandle(out_handle);
        let _ = CloseHandle(err_handle);
    }
    for cap in &capability_sids {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(cap.0)));
        }
    }
    drop(capability_storage);
    if let Err(err) = created {
        return Err(format!("沙箱内创建进程失败：{err}"));
    }

    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.ok();
    if let Some(job) = job {
        unsafe {
            let _ = AssignProcessToJobObject(job, process_info.hProcess);
        }
    }

    let started = Instant::now();
    let mut timed_out = false;
    loop {
        let wait = unsafe { WaitForSingleObject(process_info.hProcess, 100) };
        if wait == WAIT_OBJECT_0 {
            break;
        }
        if started.elapsed() >= timeout {
            if let Some(job) = job {
                unsafe {
                    let _ = TerminateJobObject(job, 1);
                }
            }
            unsafe {
                let _ = TerminateProcess(process_info.hProcess, 1);
                let _ = WaitForSingleObject(process_info.hProcess, 5_000);
            }
            timed_out = true;
            break;
        }
        if wait != WAIT_TIMEOUT {
            break;
        }
    }
    let mut exit_code = 0u32;
    unsafe {
        let _ = GetExitCodeProcess(process_info.hProcess, &mut exit_code);
    }
    unsafe {
        let _ = CloseHandle(process_info.hThread);
        let _ = CloseHandle(process_info.hProcess);
        if let Some(job) = job {
            let _ = CloseHandle(job);
        }
    }

    let stdout_bytes = std::fs::metadata(stdout_path).map(|m| m.len()).unwrap_or(0);
    let stderr_bytes = std::fs::metadata(stderr_path).map(|m| m.len()).unwrap_or(0);
    Ok(SandboxOutput {
        exit_code: Some(exit_code as i32),
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout_path: stdout_path.to_path_buf(),
        stderr_path: stderr_path.to_path_buf(),
        stdout_bytes,
        stderr_bytes,
    })
}

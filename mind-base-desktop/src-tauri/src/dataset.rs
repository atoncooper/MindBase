//! 学术项目数据层（Phase 1）：数据集导入 / 画像列表 / 分析脚本执行。
//!
//! 契约见 `plan/1.0.12-AcademicAgent/phase1-spec.md` §2：
//!
//! - `dataset_list` / `dataset_import`：源文件复制到
//!   `<data_dir>/research/<project_id>/data/original/<文件名>`（重名加序号），
//!   MD5 摘要写入 `datasets.sha256` 列（项目无 sha2 依赖，按契约用 MD5），
//!   画像由 `scripts/dataset_profile.py`（嵌入式 Python）计算后落库；
//! - `analysis_run`：脚本写到
//!   `analysis/scripts/<slug>.py`，以项目根目录为 cwd 用嵌入式 Python 执行
//!   （pandas / numpy / matplotlib / openpyxl），默认 120 秒超时后 kill，
//!   stdout 另存 `analysis/outputs/<slug>.txt`。
//!
//! 约定：
//! - 计算密集 / 可能阻塞数分钟的部分（首次安装 Python 依赖）全部走
//!   `spawn_blocking`，不阻塞 Tauri 主线程；
//! - 数据库锁沿用项目约定「先 conn 后 data_dir」，且不在 await 期间持有；
//! - 用户可见错误一律中文。

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::db::{self, Db};

/// 可导入的数据文件扩展名（小写，不含点）。
const ALLOWED_EXT: &[&str] = &["csv", "xlsx", "xls"];

/// 分析脚本的默认执行超时（超时即 kill 子进程）。
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(120);

/// 轮询子进程退出状态的间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 一行 `datasets` 记录（前端「数据」Tab 的数据集卡片）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetRow {
    pub id: String,
    pub name: String,
    pub path: String,
    /// MD5 摘要（沿用既有列名 sha256，避免改表）。
    pub sha256: String,
    pub rows: Option<i64>,
    pub cols: Option<i64>,
    pub privacy: String,
    /// 列画像 JSON 数组字符串（前端 JSON.parse 后渲染表头）。
    pub schema_json: String,
    /// `dataset_profile.py` 输出的完整 JSON 字符串。
    pub profile_json: String,
    pub created_at: i64,
}

/// `analysis_run` 的执行结果（脚本非 0 退出也算正常返回）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub script_path: String,
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// 项目根目录：`<data_dir>/research/<project_id>`（与 research.rs 一致）。
fn project_root(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir.join("research").join(project_id)
}

/// 项目目录骨架（幂等）。旧版本创建的项目可能缺 analysis 目录。
fn ensure_project_dirs(root: &Path) -> Result<(), String> {
    for sub in [
        "data/original",
        "data/derived",
        "analysis/scripts",
        "analysis/outputs",
        "analysis/figures",
    ] {
        let dir = root.join(sub);
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("无法创建项目目录 {}：{err}", dir.display()))?;
    }
    Ok(())
}

/// 校验研究项目存在（和 research.rs 的报错口径一致）。
fn ensure_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    conn.query_row(
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )
    .optional()
    .map_err(|err| format!("查询研究项目失败：{err}"))?
    .ok_or_else(|| format!("研究项目不存在：{project_id}"))
}

/// 追加审计事件；事件流是附加信息，写失败不能影响业务写入。
fn record_event(conn: &Connection, project_id: &str, kind: &str, payload: &Value) {
    let _ = conn.execute(
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![project_id, now_secs(), "user", kind, payload.to_string()],
    );
}

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

fn dataset_from_row(row: &Row<'_>) -> rusqlite::Result<DatasetRow> {
    Ok(DatasetRow {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        sha256: row.get(3)?,
        rows: row.get(4)?,
        cols: row.get(5)?,
        privacy: row.get(6)?,
        schema_json: row.get(7)?,
        profile_json: row.get(8)?,
        created_at: row.get(9)?,
    })
}

const DATASET_COLS: &str = "id, name, path, sha256, rows, cols, privacy, schema_json, \
                            profile_json, created_at";

// ---------------------------------------------------------------------------
// 文件归档 + 画像（阻塞核心）
// ---------------------------------------------------------------------------

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
fn archive_and_profile(
    source: &Path,
    data_dir: &Path,
    root: &Path,
    need_excel: bool,
) -> Result<(PathBuf, String, Value), String> {
    let (target, sha256) = copy_with_md5(source, &root.join("data").join("original"))?;
    // 首次使用可能需要安装 openpyxl（xlsx）——耗时，故整段在阻塞线程里做。
    let exe = crate::python_runtime::ensure_dataset_python(data_dir, need_excel)?;
    let profile = run_profile_script(&exe, &profile_script_path(), &target)?;
    Ok((target, sha256, profile))
}

// ---------------------------------------------------------------------------
// 分析脚本执行（阻塞核心）
// ---------------------------------------------------------------------------

/// 从分析脚本名生成安全的文件名 slug：保留字母 / 数字（含中文）与 `_-`，
/// 其余字符替换为单个下划线；空名回退为 `analysis_<时间戳>`。
fn slugify(name: &str) -> String {
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
fn run_analysis_script(
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

    let exe = crate::python_runtime::ensure_analysis_python(data_dir)?;

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
        crate::logging::warn(
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

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 列出某研究项目已导入的数据集（最新在前）。
#[tauri::command]
pub fn dataset_list(db: State<'_, Db>, project_id: String) -> Result<Vec<DatasetRow>, String> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("无法获取数据库锁：{err}"))?;
    ensure_project(&conn, &project_id)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {DATASET_COLS} FROM datasets WHERE project_id = ?1 ORDER BY created_at DESC"
        ))
        .map_err(|err| format!("准备数据集查询失败：{err}"))?;
    let rows = stmt
        .query_map(params![project_id], |row| dataset_from_row(row))
        .map_err(|err| format!("查询数据集失败：{err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取数据集失败：{err}"))
}

/// 导入一个本地数据文件：归档到项目目录 → MD5 → Python 画像 → 写库。
#[tauri::command]
pub async fn dataset_import(
    db: State<'_, Db>,
    project_id: String,
    path: String,
) -> Result<DatasetRow, String> {
    let source = PathBuf::from(path.trim());
    if !source.is_file() {
        return Err(format!("源文件不存在：{}", source.display()));
    }
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        let shown = if ext.is_empty() {
            "未知"
        } else {
            ext.as_str()
        };
        return Err(format!(
            "不支持的数据文件格式：{shown}（仅支持 {}）",
            ALLOWED_EXT.join(" / ")
        ));
    }
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }

    // 锁顺序：先 conn 后 data_dir；两者都在进入 await 前释放。
    let data_dir = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("无法获取数据库锁：{err}"))?;
        ensure_project(&conn, &project_id)?;
        drop(conn);
        db.data_dir
            .lock()
            .map_err(|err| format!("无法获取数据目录锁：{err}"))?
            .clone()
    };
    let root = project_root(&data_dir, &project_id);
    ensure_project_dirs(&root)?;

    let display_name = source
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or_else(|| "dataset".to_string());
    let need_excel = ext != "csv";

    let blocking_source = source.clone();
    let blocking_dir = data_dir.clone();
    let blocking_root = root.clone();
    let (target, sha256, profile) = tauri::async_runtime::spawn_blocking(move || {
        archive_and_profile(&blocking_source, &blocking_dir, &blocking_root, need_excel)
    })
    .await
    .map_err(|err| format!("数据集导入任务执行失败：{err}"))??;

    let rows = profile.get("rows").and_then(Value::as_i64);
    let cols = profile.get("cols").and_then(Value::as_i64);
    let schema_json = profile
        .get("columns")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .to_string();
    let profile_json = profile.to_string();
    let stored_path = target.to_string_lossy().to_string();

    let id = db::local_id();
    let created_at = now_secs();
    {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("无法获取数据库锁：{err}"))?;
        conn.execute(
            "INSERT INTO datasets(
                 id, project_id, name, path, sha256, rows, cols, privacy,
                 schema_json, profile_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'local', ?8, ?9, ?10)",
            params![
                id,
                project_id,
                display_name,
                stored_path,
                sha256,
                rows,
                cols,
                schema_json,
                profile_json,
                created_at,
            ],
        )
        .map_err(|err| format!("写入数据集记录失败：{err}"))?;
        record_event(
            &conn,
            &project_id,
            "dataset.imported",
            &json!({
                "dataset": id.clone(),
                "name": display_name.clone(),
                "rows": rows,
                "cols": cols,
            }),
        );
    }

    Ok(DatasetRow {
        id,
        name: display_name,
        path: stored_path,
        sha256,
        rows,
        cols,
        privacy: "local".to_string(),
        schema_json,
        profile_json,
        created_at,
    })
}

/// 在项目根目录执行一段分析脚本，返回 stdout / stderr / 退出码。
/// 默认 120 秒超时（超时即 kill，返回中文错误）；脚本非 0 退出不算命令失败。
#[tauri::command]
pub async fn analysis_run(
    db: State<'_, Db>,
    project_id: String,
    name: String,
    script: String,
) -> Result<AnalysisResult, String> {
    if script.trim().is_empty() {
        return Err("分析脚本内容不能为空".to_string());
    }
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }
    let slug = slugify(&name);

    let (data_dir, root) = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("无法获取数据库锁：{err}"))?;
        ensure_project(&conn, &project_id)?;
        drop(conn);
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("无法获取数据目录锁：{err}"))?
            .clone();
        let root = project_root(&dir, &project_id);
        (dir, root)
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_analysis_script(&data_dir, &root, &slug, &script)
    })
    .await
    .map_err(|err| format!("分析任务执行失败：{err}"))??;

    // 审计事件：失败不影响返回结果。
    if let Ok(conn) = db.conn.lock() {
        record_event(
            &conn,
            &project_id,
            "analysis.run",
            &json!({
                "script": result.script_path.clone(),
                "exitCode": result.exit_code,
            }),
        );
    }
    Ok(result)
}

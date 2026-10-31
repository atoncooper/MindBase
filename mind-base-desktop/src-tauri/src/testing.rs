//! Test support surface for the separate end-to-end test package.
//!
//! 本 crate 的模块几乎都是 `pub(crate)`：外部集成测试 crate（`src-tauri/tests/`）
//! 无法直接构造 `Db` / `ToolContext`。这里（`#[doc(hidden)]`）只暴露 e2e 需要的最小
//! 接口：临时数据目录 + 内存库、按名执行已注册工具、写配置、定位执行日志。
//!
//! 测试分层约定：
//! - 纯函数 / 解析器 / 状态机单测：留在源码内联 `#[cfg(test)] mod tests`；
//! - 工具执行 / 沙箱 / 文件系统 / 数据库等端到端测试：放独立测试包
//!   `src-tauri/tests/`（workspace member，依赖本 crate 的 testing API）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::infra::db::Db;

/// 一个隔离的测试环境：临时数据目录 + 内存 SQLite + 已注册的工具表。
pub struct TestHarness {
    db: Db,
    data_dir: PathBuf,
}

impl TestHarness {
    /// 创建临时数据目录与内存库；`tag` 仅用于目录命名，便于排查。
    pub fn new(tag: &str) -> Self {
        let data_dir = std::env::temp_dir().join(format!(
            "mindbase-e2e-{tag}-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&data_dir).expect("create e2e data dir");
        let conn = rusqlite::Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL)
            .expect("apply schema");
        let db = Db {
            conn: Arc::new(Mutex::new(conn)),
            data_dir: Arc::new(Mutex::new(data_dir.clone())),
            default_dir: data_dir.clone(),
        };
        Self { db, data_dir }
    }

    /// 数据目录（临时，Drop 时删除）。
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// 执行日志目录（<data_dir>/logs/exec），用于断言输出已落盘。
    pub fn exec_log_dir(&self) -> PathBuf {
        crate::infra::exec_log::log_root(&self.data_dir)
    }

    /// 开启 / 关闭命令执行总开关（AppConfig.shell_enabled）。
    pub fn set_shell_enabled(&self, enabled: bool) {
        let conn = self.db.conn.lock().expect("db lock");
        crate::infra::config::save(
            &conn,
            &crate::infra::config::AppConfig {
                shell_enabled: enabled,
                ..Default::default()
            },
        )
        .expect("save test config");
    }

    /// 按名执行一个已注册工具，返回模型可见文本（错误原样返回）。
    pub fn run_tool(
        &self,
        agent: &str,
        tool: &str,
        arguments: &str,
    ) -> Result<String, String> {
        let agent = parse_agent(agent)?;
        let ctx = crate::agent::harness::ToolContext {
            db: self.db.clone(),
            embed_client: None,
            chat_client: None,
            session_id: "e2e".to_string(),
            agent,
            delegate: None,
        };
        let tool = crate::agent::harness::harness()
            .tool(tool)
            .ok_or_else(|| format!("tool not registered: {tool}"))?;
        tool.execute(&ctx, arguments)
            .map(|output| output.content)
    }

    /// 已注册工具名列表（可用于断言工具是否暴露给 agent）。
    pub fn registered_tools(&self) -> Vec<String> {
        crate::agent::harness::harness()
            .tool_names()
            .iter()
            .map(|name| (*name).to_string())
            .collect()
    }
}

impl Drop for TestHarness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

fn parse_agent(name: &str) -> Result<crate::agent::agents::AgentKind, String> {
    use crate::agent::agents::AgentKind;
    match name.trim().to_ascii_lowercase().as_str() {
        "chat" => Ok(AgentKind::Chat),
        "memory" => Ok(AgentKind::Memory),
        "note" => Ok(AgentKind::Note),
        "code" => Ok(AgentKind::Code),
        "search" => Ok(AgentKind::Search),
        "academic" => Ok(AgentKind::Academic),
        "research" => Ok(AgentKind::Research),
        other => Err(format!("unknown agent for test harness: {other}")),
    }
}

/// 记录一次 token 消耗（usage 统计测试用）。
impl TestHarness {
    pub fn record_usage(&self, session_id: &str, model: &str, input: u64, output: u64, cached: u64) {
        let conn = self.db.conn.lock().expect("db lock");
        let usage = crate::llm::client::TokenUsage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input.saturating_add(output),
            cached_tokens: cached,
        };
        crate::infra::usage::record(&conn, session_id, "chat", model, usage, None)
            .expect("record usage");
    }

    /// 近 days 天的 (calls, input, output, cached, total)。
    pub fn usage_totals(&self, days: u32) -> (u64, u64, u64, u64, u64) {
        let conn = self.db.conn.lock().expect("db lock");
        let since = crate::automation::now_secs() - days as i64 * 86_400;
        let totals = crate::infra::usage::totals(&conn, since).expect("usage totals");
        (
            totals.calls,
            totals.input_tokens,
            totals.output_tokens,
            totals.cached_tokens,
            totals.total_tokens,
        )
    }

    pub fn usage_summary(&self, days: u32) -> String {
        let conn = self.db.conn.lock().expect("db lock");
        crate::infra::usage::summary_text(&conn, days).expect("usage summary")
    }
}

/// 研究项目测试辅助（学术工具测试用）：建项目 + 六阶段。
impl TestHarness {
    pub fn create_research_project(&self, title: &str) -> String {
        let conn = self.db.conn.lock().expect("db lock");
        let id = crate::infra::db::local_id();
        let now = crate::automation::now_secs();
        conn.execute(
            "INSERT INTO research_projects(id, title, current_stage, created_at, updated_at)
             VALUES(?1, ?2, 'topic', ?3, ?3)",
            rusqlite::params![id, title, now],
        )
        .expect("insert research project");
        for stage in crate::workspace::research::STAGES {
            conn.execute(
                "INSERT INTO research_stages(project_id, stage, status, gate_json)
                 VALUES(?1, ?2, 'locked', '[]')",
                rusqlite::params![id, stage],
            )
            .expect("insert research stage");
        }
        id
    }

    pub fn research_stage_status(&self, project_id: &str, stage: &str) -> String {
        let conn = self.db.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT status FROM research_stages WHERE project_id = ?1 AND stage = ?2",
            rusqlite::params![project_id, stage],
            |row| row.get(0),
        )
        .expect("stage status")
    }
}

/// 自定义 agent 断言辅助（create_agent 工具 / 存储层测试用）。
impl TestHarness {
    pub fn custom_agent_names(&self) -> Vec<String> {
        let conn = self.db.conn.lock().expect("db lock");
        crate::agent::custom_agents::list(&conn)
            .expect("list custom agents")
            .into_iter()
            .map(|agent| agent.name)
            .collect()
    }

    pub fn custom_agent_prompt(&self, name: &str) -> Option<String> {
        let conn = self.db.conn.lock().expect("db lock");
        crate::agent::custom_agents::get_by_name(&conn, name)
            .expect("get custom agent")
            .map(|agent| agent.system_prompt)
    }
}

/// 读取当前 shell_enabled 开关（配置持久化断言用）。
impl TestHarness {
    pub fn shell_enabled(&self) -> bool {
        let conn = self.db.conn.lock().expect("db lock");
        crate::infra::config::load(&conn)
            .map(|config| config.shell_enabled)
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// 面向 tests/ 的只读包装：非 agent 包的 pub(crate) 逻辑，外部测试无法直接访问，
// 这里以薄包装暴露（不改变内部可见性，也不引入 agent 依赖）。
// ---------------------------------------------------------------------------

/// 执行日志：头/尾摘要（<data_dir>/logs/exec 之外的任意文件也可用）。
pub fn summarize_log(path: &std::path::Path, total_bytes: u64) -> String {
    crate::infra::exec_log::summarize(path, total_bytes)
}

/// 执行日志：按字节区间读取（read_file 分页的实现）。
pub fn read_log_slice(
    path: &std::path::Path,
    offset: u64,
    limit: usize,
) -> Result<(String, u64), String> {
    crate::infra::exec_log::read_slice(path, offset, limit)
}

/// 执行日志：清理超出配额（64MB / 200 文件）的旧文件。
pub fn prune_logs(dir: &std::path::Path) {
    crate::infra::exec_log::prune(dir)
}

/// 切块结果（对外可读视图，避免暴露内部类型）。
#[derive(Debug, Clone)]
pub struct ChunkView {
    pub display_text: String,
    pub embedding_text: String,
}

/// 知识库切块（knowledge::chunker 的对外包装）。
pub fn chunk_text(
    text: &str,
    video_title: &str,
    page_title: Option<&str>,
    outline_titles: &[String],
) -> Vec<ChunkView> {
    crate::knowledge::chunker::chunk_text(text, video_title, page_title, outline_titles)
        .into_iter()
        .map(|chunk| ChunkView {
            display_text: chunk.display_text,
            embedding_text: chunk.embedding_text,
        })
        .collect()
}

/// 笔记 Markdown 服务端消毒（notes::markdown 的对外包装）。
pub fn sanitize_markdown(markdown: &str) -> String {
    crate::workspace::notes::sanitize_markdown(markdown)
}

/// quiz 模型回复解析（quiz::parse 的对外包装）。
pub fn parse_quiz_questions(reply: &str) -> Result<Vec<serde_json::Value>, String> {
    crate::workspace::quiz::parse_questions_reply(reply)
}

// ---------------------------------------------------------------------------
// 自动化任务测试驱动（不经过 agent）：内存库 + 临时数据目录 + supervisor。
// ---------------------------------------------------------------------------

/// automation 包的测试环境：创建任务、等待终态、读取上下文包 / 日志。
pub struct AutomationTestEnv {
    conn: std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    data_dir: std::path::PathBuf,
}

impl AutomationTestEnv {
    pub fn new(tag: &str) -> Self {
        let data_dir = std::env::temp_dir().join(format!(
            "mindbase-automation-{tag}-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&data_dir).expect("create automation test dir");
        let conn = rusqlite::Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL)
            .expect("apply schema");
        Self {
            conn: std::sync::Arc::new(std::sync::Mutex::new(conn)),
            data_dir,
        }
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// 创建并启动任务，返回 task_id（内部会写入 cwd = 临时数据目录）。
    pub fn start(&self, name: &str, command: &str, interval_secs: u64) -> Result<i64, String> {
        let spec = crate::automation::store::TaskSpec {
            name: name.to_string(),
            command: command.to_string(),
            cwd: Some(self.data_dir.clone()),
            interval_secs,
            max_attempts: 3,
        };
        let task = {
            let guard = self.conn.lock().map_err(|_| "db lock".to_string())?;
            crate::automation::store::create_task(&guard, &spec, crate::automation::now_secs())?
        };
        crate::automation::supervisor::start(&self.conn, &self.data_dir, &task, "test")?;
        Ok(task.id)
    }

    pub fn task_state(&self, task_id: i64) -> Result<String, String> {
        let guard = self.conn.lock().map_err(|_| "db lock".to_string())?;
        Ok(crate::automation::store::get_task(&guard, task_id)?
            .state
            .as_str()
            .to_string())
    }

    /// 轮询等待终态（succeeded / failed / stopped / interrupted）。
    pub fn wait_done(&self, task_id: i64, timeout: std::time::Duration) -> Result<String, String> {
        let started = std::time::Instant::now();
        loop {
            let state = self.task_state(task_id)?;
            if matches!(state.as_str(), "succeeded" | "failed" | "stopped" | "interrupted") {
                return Ok(state);
            }
            if started.elapsed() > timeout {
                return Err(format!("等待任务 {task_id} 超时（当前 {state}）"));
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    pub fn context_pack(&self, task_id: i64) -> Result<serde_json::Value, String> {
        let guard = self.conn.lock().map_err(|_| "db lock".to_string())?;
        crate::automation::report::build_pack(&guard, &self.data_dir, task_id)
    }

    pub fn log_paths(&self, task_id: i64) -> Result<Vec<std::path::PathBuf>, String> {
        let guard = self.conn.lock().map_err(|_| "db lock".to_string())?;
        Ok(crate::automation::store::log_segments(&guard, task_id)?
            .into_iter()
            .map(|segment| segment.path)
            .collect())
    }

    pub fn search_logs(
        &self,
        task_id: i64,
        query: &str,
        limit: usize,
    ) -> Result<Vec<crate::automation::log_index::LogMatch>, String> {
        let paths = self.log_paths(task_id)?;
        crate::automation::log_index::search_lines(&paths, query, limit)
    }

    pub fn due_reports(&self) -> Result<Vec<crate::automation::scheduler::DueReport>, String> {
        let guard = self.conn.lock().map_err(|_| "db lock".to_string())?;
        crate::automation::scheduler::due_reports(&guard, crate::automation::now_secs())
    }

    pub fn record_due_reports(&self) -> Result<usize, String> {
        let now = crate::automation::now_secs();
        let due = self.due_reports()?;
        let guard = self.conn.lock().map_err(|_| "db lock".to_string())?;
        for item in &due {
            let pack = crate::automation::report::build_pack(&guard, &self.data_dir, item.task_id)?;
            crate::automation::report::record(&guard, item.task_id, item.kind, &pack, now)?;
        }
        Ok(due.len())
    }

    pub fn kill(&self, task_id: i64) -> Result<(), String> {
        crate::automation::supervisor::kill(&self.conn, task_id).map(|_| ())
    }
}

impl Drop for AutomationTestEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

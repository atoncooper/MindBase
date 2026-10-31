//! LLM token usage ledger + DeepSeek-Harness-style aggregates.
//!
//! 每个完成的 assistant 回合写一行 llm_usage（session/purpose/model/task_id +
//! 输入/输出/缓存命中/合计）。统计接口供 usage_stats 工具与后续 UI 使用。

use rusqlite::{params, Connection};

use crate::llm::client::TokenUsage;

/// 一组累计消耗。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UsageTotals {
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
}

impl UsageTotals {
    #[allow(dead_code)]
    fn add(&mut self, usage: TokenUsage) {
        self.calls += 1;
        self.input_tokens = self.input_tokens.saturating_add(usage.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(usage.output_tokens);
        self.cached_tokens = self.cached_tokens.saturating_add(usage.cached_tokens);
        self.total_tokens = self.total_tokens.saturating_add(usage.total_tokens);
    }

    #[allow(dead_code)]
    pub fn merge(&mut self, other: UsageTotals) {
        self.calls += other.calls;
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cached_tokens = self.cached_tokens.saturating_add(other.cached_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
    }

    /// 缓存命中率（0..=1，按输入 token 计）。
    pub fn cache_hit_rate(&self) -> f64 {
        if self.input_tokens == 0 {
            return 0.0;
        }
        self.cached_tokens as f64 / self.input_tokens as f64
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 记录一次完成回合的 token 消耗（空 usage 不入账，避免噪声）。
pub fn record(
    conn: &Connection,
    session_id: &str,
    purpose: &str,
    model: &str,
    usage: TokenUsage,
    task_id: Option<i64>,
) -> Result<(), String> {
    if usage.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO llm_usage(ts, session_id, purpose, model, task_id,
             input_tokens, output_tokens, cached_tokens, total_tokens)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            now_secs(),
            session_id,
            purpose,
            model,
            task_id,
            usage.input_tokens as i64,
            usage.output_tokens as i64,
            usage.cached_tokens as i64,
            usage.total_tokens as i64,
        ],
    )
    .map_err(|err| format!("写入 token 用量失败：{err}"))?;
    Ok(())
}

fn totals_from_row(
    calls: i64,
    input: i64,
    output: i64,
    cached: i64,
    total: i64,
) -> UsageTotals {
    UsageTotals {
        calls: calls.max(0) as u64,
        input_tokens: input.max(0) as u64,
        output_tokens: output.max(0) as u64,
        cached_tokens: cached.max(0) as u64,
        total_tokens: total.max(0) as u64,
    }
}

const SUM_COLUMNS: &str = "COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),      COALESCE(SUM(cached_tokens), 0), COALESCE(SUM(total_tokens), 0)";

/// 全量/时间窗总览（since 为 Unix 秒，0 表示全部）。
pub fn totals(conn: &Connection, since: i64) -> Result<UsageTotals, String> {
    conn.query_row(
        &format!("SELECT {SUM_COLUMNS} FROM llm_usage WHERE ts >= ?1"),
        params![since],
        |row| {
            Ok(totals_from_row(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .map_err(|err| format!("统计 token 用量失败：{err}"))
}

/// 指定自动化任务的累计消耗（task_id 为空时返回全量）。
pub fn totals_for_task(conn: &Connection, task_id: i64, since: i64) -> Result<UsageTotals, String> {
    conn.query_row(
        &format!("SELECT {SUM_COLUMNS} FROM llm_usage WHERE task_id = ?1 AND ts >= ?2"),
        params![task_id, since],
        |row| {
            Ok(totals_from_row(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .map_err(|err| format!("统计任务 token 用量失败：{err}"))
}

/// 按模型分组，按总 token 降序。
pub fn by_model(conn: &Connection, since: i64) -> Result<Vec<(String, UsageTotals)>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT model, {SUM_COLUMNS} FROM llm_usage WHERE ts >= ?1              GROUP BY model ORDER BY SUM(total_tokens) DESC"
        ))
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![since], |row| {
            let model: String = row.get(0)?;
            Ok((
                model,
                totals_from_row(
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ),
            ))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// 按会话分组（automation-* 会话即自动化任务消耗），按总 token 降序。
pub fn by_session(
    conn: &Connection,
    since: i64,
    limit: usize,
) -> Result<Vec<(String, UsageTotals)>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT session_id, {SUM_COLUMNS} FROM llm_usage WHERE ts >= ?1              GROUP BY session_id ORDER BY SUM(total_tokens) DESC LIMIT ?2"
        ))
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![since, limit as i64], |row| {
            let session: String = row.get(0)?;
            Ok((
                session,
                totals_from_row(
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ),
            ))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// 按天分组（UTC），最近 days 天。
pub fn daily(conn: &Connection, since: i64) -> Result<Vec<(String, UsageTotals)>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT strftime('%Y-%m-%d', ts, 'unixepoch'), {SUM_COLUMNS} FROM llm_usage              WHERE ts >= ?1 GROUP BY 1 ORDER BY 1 ASC"
        ))
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![since], |row| {
            let day: String = row.get(0)?;
            Ok((
                day,
                totals_from_row(
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ),
            ))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// 生成紧凑的多行统计文本（供 usage_stats 工具 / 设置页复用）。
pub fn summary_text(conn: &Connection, days: u32) -> Result<String, String> {
    let days = days.clamp(1, 30);
    let since = now_secs() - days as i64 * 86_400;
    let totals = totals(conn, since)?;
    let mut out = String::new();
    out.push_str(&format!("LLM token 统计（近 {days} 天，UTC）\n"));
    out.push_str(&format!(
        "总览：调用 {} 次 · 输入 {} · 输出 {} · 缓存命中 {}（{:.1}%）· 合计 {}\n",
        totals.calls,
        totals.input_tokens,
        totals.output_tokens,
        totals.cached_tokens,
        totals.cache_hit_rate() * 100.0,
        totals.total_tokens
    ));
    let models = by_model(conn, since)?;
    if !models.is_empty() {
        out.push_str("按模型：\n");
        for (model, usage) in models.iter().take(8) {
            out.push_str(&format!(
                "  {}：{} 次 / 输入 {} / 输出 {} / 合计 {} / 缓存 {}\n",
                if model.is_empty() { "(unknown)" } else { model },
                usage.calls,
                usage.input_tokens,
                usage.output_tokens,
                usage.total_tokens,
                usage.cached_tokens
            ));
        }
    }
    let sessions = by_session(conn, since, 5)?;
    if !sessions.is_empty() {
        out.push_str("会话 Top 5：\n");
        for (session, usage) in sessions {
            out.push_str(&format!(
                "  {}：{} 次 / 合计 {}\n",
                if session.is_empty() { "(default)" } else { &session },
                usage.calls,
                usage.total_tokens
            ));
        }
    }
    let days_rows = daily(conn, since)?;
    if !days_rows.is_empty() {
        out.push_str("按天：\n");
        for (day, usage) in days_rows {
            out.push_str(&format!(
                "  {}：{} 次 / 合计 {}\n",
                day, usage.calls, usage.total_tokens
            ));
        }
    }
    Ok(out.trim_end().to_string())
}

//! 数据访问层（repository pattern）。
//!
//! **已迁移域（科研 / 写作 / 文献 / 数据 / 实验）的 SQL 只允许出现在本包。**
//! 业务层（workspace / agent 工具 / Tauri 命令）只调用这里的类型化函数，
//! 不再自己拼 SQL；其余域（notes / quiz / mindmap / automation / knowledge /
//! agent 会话等）按同一模式逐步迁移。
//!
//! 写法对齐 SQLx：一个查询一个函数、参数用 params! 绑定、行映射函数与
//! 领域 DTO 分离、统一返回 RepoResult；在命令边界用 ? 自动转成前端
//! 需要的 String 错误（见 From<RepoError> for String）。
//!
//! 为什么不是 sqlx crate：桌面端是**离线内置 SQLite（rusqlite bundled）**，
//! Tauri 命令是同步模型；sqlx 的编译期校验要求构建时 DATABASE_URL / 离线
//! 元数据，还会引入第二套连接池与异步运行时。这里保留 rusqlite，但按
//! SQLx 的 repository 风格组织查询（等价于 query_as(...).fetch_all()）。
//!
//! 分层约定：
//! - repository 只做 SQL，不做业务校验/流程编排；
//! - 业务不变式（例如"同一时刻只有一个 active 阶段"）放在
//!   workspace::research::service 等 service 层，由它组合多个 repository；
//! - repository 函数接收 &rusqlite::Connection，因此未来可直接传
//!   Transaction（Deref 到 Connection）获得事务能力；
//! - repository 可复用 workspace 的纯数据结构（DTO，如 ResearchEvent），
//!   但不得调用业务函数（主方向仍是 workspace/agent → repositories → infra）。

use rusqlite::{Connection, OptionalExtension, Params, Row};

pub(crate) mod dataset;
pub(crate) mod experiment;
pub(crate) mod literature;
pub(crate) mod manuscript;
pub(crate) mod research;

/// repository 统一返回类型；命令层 ? 会经 From<RepoError> for String 转换。
pub(crate) type RepoResult<T> = Result<T, RepoError>;

/// 数据访问错误（含 SQL 上下文）。不携带业务语义，业务错误由 service 返回。
#[derive(Debug)]
pub(crate) struct RepoError {
    message: String,
}

impl RepoError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// 给底层 rusqlite 错误补一句上下文，例如「查询研究项目失败：...」。
    pub(crate) fn db(action: &str, err: rusqlite::Error) -> Self {
        Self::new(format!("{action}：{err}"))
    }
}

impl std::fmt::Display for RepoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RepoError {}

impl From<rusqlite::Error> for RepoError {
    fn from(err: rusqlite::Error) -> Self {
        Self::db("数据库操作失败", err)
    }
}

impl From<RepoError> for String {
    fn from(err: RepoError) -> Self {
        err.message
    }
}

/// SQLx 风格的 query_as(...).fetch_all()：绑定参数 + 行映射 → Vec<T>。
pub(crate) fn query_all<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    mut map: F,
) -> RepoResult<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut statement = conn
        .prepare(sql)
        .map_err(|err| RepoError::db("准备查询失败", err))?;
    let rows = statement
        .query_map(params, |row| map(row))
        .map_err(|err| RepoError::db("执行查询失败", err))?;
    rows.collect::<rusqlite::Result<Vec<T>>>()
        .map_err(|err| RepoError::db("读取查询结果失败", err))
}

/// SQLx 风格的 fetch_optional()：0 或 1 行。
pub(crate) fn query_optional<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    mut map: F,
) -> RepoResult<Option<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    conn.query_row(sql, params, |row| map(row))
        .optional()
        .map_err(|err| RepoError::db("查询单行失败", err))
}

/// SQLx 风格的 fetch_one()：必须恰好 1 行。
pub(crate) fn query_one<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    mut map: F,
) -> RepoResult<T>
where
    P: Params,
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    conn.query_row(sql, params, |row| map(row))
        .map_err(|err| RepoError::db("查询单行失败", err))
}

/// SQLx 风格的 execute()：返回受影响行数。
pub(crate) fn execute<P: Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> RepoResult<usize> {
    conn.execute(sql, params)
        .map_err(|err| RepoError::db("写入数据库失败", err))
}

/// SELECT COUNT(*) ... 的便捷封装。
pub(crate) fn count<P: Params>(conn: &Connection, sql: &str, params: P) -> RepoResult<i64> {
    query_one(conn, sql, params, |row| row.get(0))
}

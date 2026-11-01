//! 科研项目域数据访问：项目 / 阶段 / 事件 / 产物 / 阶段建议 / 统计。
//!
//! 只做 SQL；阶段流转等业务不变式在 workspace::research::service。

pub(crate) mod artifacts;
pub(crate) mod events;
pub(crate) mod guidance;
pub(crate) mod projects;
pub(crate) mod stages;
pub(crate) mod stats;

/// 测试用内存库（已应用建表脚本）；让 service 单测无需自己写 SQL。
#[cfg(test)]
pub(crate) fn in_memory_conn() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
    conn.execute_batch(crate::infra::db::SCHEMA_SQL)
        .expect("apply schema");
    conn
}

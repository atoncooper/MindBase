//! 主 agent 自建的自定义子代理（角色提示词持久化，可重复委托）。
//!
//! 与内置 AgentKind 的区别：内置 agent 的提示词/工具是编译期固定的；自定义 agent
//! 由主 agent 在运行时用 create_agent 创建，名字 + 角色设定存 SQLite，委托时以
//! chat 的 ReAct 能力执行（共享知识库/历史/文件工具），并把角色提示词注入任务。

use rusqlite::{params, Connection};

pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_DESCRIPTION_CHARS: usize = 400;
pub const MAX_PROMPT_CHARS: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 名称规则：小写字母/数字/连字符/下划线，2..=40 字符（作为委托目标名使用）。
pub fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.chars().count() < 2 || trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "agent 名称长度需在 2..={MAX_NAME_CHARS} 字符（收到 {:?}）",
            name
        ));
    }
    const RESERVED: [&str; 7] = [
        "chat", "memory", "note", "code", "search", "academic", "research",
    ];
    if RESERVED.contains(&trimmed) {
        return Err(format!(
            "不能使用内置 agent 名称（{trimmed}）；请换一个自定义名字"
        ));
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
    {
        return Err("agent 名称只能包含小写字母、数字、连字符和下划线".to_string());
    }
    Ok(())
}

pub fn get_by_name(conn: &Connection, name: &str) -> Result<Option<CustomAgent>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, description, system_prompt, created_at, updated_at
             FROM custom_agents WHERE name = ?1",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = statement
        .query(params![name])
        .map_err(|err| err.to_string())?;
    match rows.next().map_err(|err| err.to_string())? {
        Some(row) => Ok(Some(CustomAgent {
            id: row.get(0).map_err(|e| e.to_string())?,
            name: row.get(1).map_err(|e| e.to_string())?,
            description: row.get(2).map_err(|e| e.to_string())?,
            system_prompt: row.get(3).map_err(|e| e.to_string())?,
            created_at: row.get(4).map_err(|e| e.to_string())?,
            updated_at: row.get(5).map_err(|e| e.to_string())?,
        })),
        None => Ok(None),
    }
}

pub fn list(conn: &Connection) -> Result<Vec<CustomAgent>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, description, system_prompt, created_at, updated_at
             FROM custom_agents ORDER BY updated_at DESC, name ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(CustomAgent {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                system_prompt: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// 新建或更新（同名覆盖角色设定），返回最新记录。
pub fn upsert(
    conn: &Connection,
    name: &str,
    description: &str,
    system_prompt: &str,
    now: i64,
) -> Result<CustomAgent, String> {
    validate_name(name)?;
    let name = name.trim();
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!("description 过长（上限 {MAX_DESCRIPTION_CHARS} 字符）"));
    }
    let system_prompt = system_prompt.trim();
    if system_prompt.is_empty() {
        return Err("system_prompt 不能为空：请写清这个 agent 的角色与工作方式".to_string());
    }
    if system_prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("system_prompt 过长（上限 {MAX_PROMPT_CHARS} 字符）"));
    }
    let id = crate::infra::db::local_id();
    conn.execute(
        "INSERT INTO custom_agents(id, name, description, system_prompt, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(name) DO UPDATE SET
             description = excluded.description,
             system_prompt = excluded.system_prompt,
             updated_at = excluded.updated_at",
        params![id, name, description.trim(), system_prompt, now],
    )
    .map_err(|err| format!("保存自定义 agent 失败：{err}"))?;
    get_by_name(conn, name)?.ok_or_else(|| "自定义 agent 保存后读取失败".to_string())
}

#[allow(dead_code)] // 预留：UI/工具删除自定义 agent
pub fn delete(conn: &Connection, name: &str) -> Result<bool, String> {
    let changed = conn
        .execute("DELETE FROM custom_agents WHERE name = ?1", params![name])
        .map_err(|err| format!("删除自定义 agent 失败：{err}"))?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");
        conn
    }

    #[test]
    fn name_validation_rejects_bad_slugs() {
        assert!(validate_name("data-cleaner").is_ok());
        assert!(validate_name("x").is_err());
        assert!(validate_name("Bad Name").is_err());
        assert!(validate_name("名字").is_err());
        assert!(validate_name(&"a".repeat(41)).is_err());
        assert!(validate_name("academic").is_err(), "builtin names are reserved");
    }

    #[test]
    fn upsert_creates_then_updates_the_same_name() {
        let conn = conn();
        let created = upsert(&conn, "data-cleaner", "清洗数据", "你是数据清洗工程师。", 100).unwrap();
        assert_eq!(created.name, "data-cleaner");
        let updated = upsert(&conn, "data-cleaner", "清洗与校验", "你负责数据质量。", 200).unwrap();
        assert_eq!(updated.description, "清洗与校验");
        assert_eq!(updated.created_at, 100);
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(delete(&conn, "data-cleaner").unwrap());
        assert!(get_by_name(&conn, "data-cleaner").unwrap().is_none());
    }
}

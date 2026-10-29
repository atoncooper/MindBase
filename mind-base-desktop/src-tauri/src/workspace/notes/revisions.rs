//! Revision snapshot policy: bigram diff ratio, time/diff gates and pruning.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::infra::db;

/// A snapshot is due only this long after the previous one.
const SNAPSHOT_MIN_INTERVAL_SECS: i64 = 600;
/// Char-bigram Jaccard distance a save must reach to earn a snapshot.
const SNAPSHOT_DIFF_THRESHOLD: f64 = 0.30;
/// Revisions kept per note; older ones are pruned.
const MAX_REVISIONS_PER_NOTE: i64 = 20;

/// Hash every adjacent character pair into a set of u64 fingerprints.
fn bigram_hashes(text: &str) -> HashSet<u64> {
    use std::hash::{Hash, Hasher};
    let chars: Vec<char> = text.chars().collect();
    let mut set = HashSet::with_capacity(chars.len());
    for pair in chars.windows(2) {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        pair[0].hash(&mut hasher);
        pair[1].hash(&mut hasher);
        set.insert(hasher.finish());
    }
    set
}

/// Symmetric-difference over union of the two bigram sets — an O(n)
/// stand-in for difflib's ratio (backend uses difflib; at desktop note sizes
/// a quadratic edit distance would dominate save latency). Identical texts
/// score 0; disjoint non-empty texts approach 1.
pub(crate) fn diff_ratio(old_text: &str, new_text: &str) -> f64 {
    let old_set = bigram_hashes(old_text);
    let new_set = bigram_hashes(new_text);
    if old_set.is_empty() && new_set.is_empty() {
        return 0.0;
    }
    let union = old_set.union(&new_set).count();
    if union == 0 {
        return 0.0;
    }
    let symmetric_difference = old_set.symmetric_difference(&new_set).count();
    symmetric_difference as f64 / union as f64
}

/// Decide whether this save earns a snapshot, then insert one for the OLD
/// content. Policy mirrors the backend: at least [`SNAPSHOT_MIN_INTERVAL_SECS`]
/// since the last snapshot AND at least [`SNAPSHOT_DIFF_THRESHOLD`]
/// difference. The very first non-empty version always snapshots so every
/// note has a base revision.
pub(super) fn maybe_snapshot_conn(
    conn: &Connection,
    note_id: &str,
    old_content: &str,
    new_content: &str,
    now: i64,
) -> Result<(), String> {
    if old_content.trim().is_empty() || old_content == new_content {
        return Ok(());
    }

    let last_created: Option<i64> = conn
        .query_row(
            "SELECT created_at FROM note_revisions WHERE note_id = ?1
             ORDER BY created_at DESC LIMIT 1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("failed to read revisions: {err}"))?;

    let elapsed_ok = match last_created {
        Some(last) => now - last >= SNAPSHOT_MIN_INTERVAL_SECS,
        None => true, // no baseline yet — first meaningful save snapshots
    };
    let changed_ok = diff_ratio(old_content, new_content) >= SNAPSHOT_DIFF_THRESHOLD;
    if !elapsed_ok || !changed_ok {
        return Ok(());
    }

    insert_revision_conn(conn, note_id, old_content, now)?;
    prune_revisions_conn(conn, note_id)?;
    Ok(())
}

pub(super) fn insert_revision_conn(
    conn: &Connection,
    note_id: &str,
    content: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO note_revisions(id, note_id, content, char_count, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![db::local_id(), note_id, content, content.chars().count() as i64, now],
    )
    .map_err(|err| format!("failed to insert revision: {err}"))?;
    Ok(())
}

/// Keep only the newest [`MAX_REVISIONS_PER_NOTE`] revisions of one note.
pub(super) fn prune_revisions_conn(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM note_revisions WHERE note_id = ?1 AND id NOT IN (
             SELECT id FROM note_revisions WHERE note_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT ?2
         )",
        params![note_id, MAX_REVISIONS_PER_NOTE],
    )
    .map_err(|err| format!("failed to prune revisions: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::notes::store::insert_note_conn;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");
        conn
    }

    fn seed_note(conn: &Connection, id: &str, content: &str) {
        insert_note_conn(conn, id, "测试笔记").expect("seed");
        conn.execute(
            "UPDATE notes SET content = ?2 WHERE id = ?1",
            params![id, content],
        )
        .expect("seed content");
    }

    // -- snapshot policy ------------------------------------------------------

    #[test]
    fn diff_ratio_scores_identical_and_disjoint() {
        assert_eq!(diff_ratio("完全相同", "完全相同"), 0.0);
        let ratio = diff_ratio("aaaaaa", "bbbbbb");
        assert!(ratio > 0.9, "disjoint texts should differ strongly: {ratio}");
        // Empty vs non-empty is maximal change.
        assert!(diff_ratio("", "内容") > 0.9);
        assert_eq!(diff_ratio("", ""), 0.0);
    }

    #[test]
    fn snapshot_policy_respects_time_and_change_gates() {
        let conn = memory_db();
        seed_note(&conn, "n1", "第一版内容，足够长以产生差异。");
        let big_new = "完全不同的第二版内容。".repeat(10);

        // Same instant, tiny change → below threshold → no snapshot.
        maybe_snapshot_conn(&conn, "n1", "第一版内容，足够长以产生差异。", "第一版内容，足够长以产生差异！", 100).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);

        // Big rewrite with no prior revision → baseline snapshot lands even
        // at the same instant (every note needs a base version).
        maybe_snapshot_conn(&conn, "n1", "第一版内容，足够长以产生差异。", &big_new, 100).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "baseline snapshots immediately");

        // Another big rewrite within the interval → gated by time.
        maybe_snapshot_conn(&conn, "n1", &big_new, "第三版，同样大幅重写的内容。", 100).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "time gate holds after baseline");

        // After the interval AND a real change → second snapshot lands.
        maybe_snapshot_conn(&conn, "n1", &big_new, "第三版，同样大幅重写的内容。", 100 + 601).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);

        // Empty old content never snapshots.
        seed_note(&conn, "n2", "");
        maybe_snapshot_conn(&conn, "n2", "", "全新内容", 999).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions WHERE note_id='n2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn pruning_keeps_only_the_newest_window() {
        let conn = memory_db();
        seed_note(&conn, "n1", "基线");
        for step in 0..30_i64 {
            let now = 1_000_000 + step * 700; // spaced beyond the interval
            let new_content = format!("第 {step} 次大改写，内容完全不同一些。{step}");
            maybe_snapshot_conn(&conn, "n1", "基线", &new_content, now).unwrap();
            conn.execute(
                "UPDATE notes SET content = ? WHERE id = 'n1'",
                rusqlite::params![new_content],
            )
            .unwrap();
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_revisions WHERE note_id='n1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_REVISIONS_PER_NOTE);
    }
}

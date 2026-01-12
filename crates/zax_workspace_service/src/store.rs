//! `SQLite` storage initialization and query functions.

use refinery::embed_migrations;
use rusqlite::{params, Connection, Transaction};
use std::path::Path;
use thiserror::Error;

embed_migrations!("migrations");

/// Errors that can occur during storage operations.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] refinery::Error),
}

/// A test failure to insert into the database.
pub struct TestFailureRow {
    pub stable_id: String,
    pub test_id: String,
    pub file: String,
    pub message: String,
}

/// A completed run for delta computation.
pub struct RunInfo {
    pub run_id: String,
}

/// Initializes the `SQLite` database at `<cache_dir>/db.sqlite`.
pub fn init_storage(cache_dir: &Path) -> Result<(), StoreError> {
    let db_path = cache_dir.join("db.sqlite");
    let mut conn = Connection::open(&db_path)?;
    migrations::runner().run(&mut conn)?;
    Ok(())
}

/// Opens a connection to the database.
pub fn open_connection(cache_dir: &Path) -> Result<Connection, StoreError> {
    let db_path = cache_dir.join("db.sqlite");
    Ok(Connection::open(db_path)?)
}

/// Inserts a new run record.
pub fn insert_run(
    tx: &Transaction,
    workspace_id: &str,
    run_id: &str,
    started_at: i64,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO runs (workspace_id, run_id, started_at) VALUES (?1, ?2, ?3)",
        params![workspace_id, run_id, started_at],
    )?;
    Ok(())
}

/// Marks a run as completed.
pub fn complete_run(tx: &Transaction, run_id: &str, completed_at: i64) -> Result<(), StoreError> {
    tx.execute(
        "UPDATE runs SET completed_at = ?1 WHERE run_id = ?2",
        params![completed_at, run_id],
    )?;
    Ok(())
}

/// Inserts test failures in batch.
pub fn insert_test_failures(
    tx: &Transaction,
    run_id: &str,
    failures: &[TestFailureRow],
) -> Result<(), StoreError> {
    let mut stmt = tx.prepare(
        "INSERT INTO test_failures (run_id, stable_id, test_id, file, message) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for f in failures {
        stmt.execute(params![run_id, f.stable_id, f.test_id, f.file, f.message])?;
    }
    Ok(())
}

/// Gets the most recent completed runs for a workspace.
pub fn get_recent_runs(
    conn: &Connection,
    workspace_id: &str,
    limit: usize,
) -> Result<Vec<RunInfo>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT run_id FROM runs \
         WHERE workspace_id = ?1 AND completed_at IS NOT NULL \
         ORDER BY started_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![workspace_id, limit], |row| {
        Ok(RunInfo {
            run_id: row.get(0)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

/// Gets all `stable_ids` for a given run.
pub fn get_stable_ids_for_run(conn: &Connection, run_id: &str) -> Result<Vec<String>, StoreError> {
    let mut stmt = conn.prepare("SELECT stable_id FROM test_failures WHERE run_id = ?1")?;
    let rows = stmt.query_map(params![run_id], |row| row.get(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempdir().unwrap();
        init_storage(dir.path()).unwrap();
        let conn = open_connection(dir.path()).unwrap();
        (dir, conn)
    }

    #[test]
    fn init_creates_db_and_is_idempotent() {
        let dir = tempdir().unwrap();
        init_storage(dir.path()).unwrap();
        assert!(dir.path().join("db.sqlite").exists());
        init_storage(dir.path()).unwrap(); // Second call succeeds
    }

    #[test]
    fn schema_has_correct_tables_and_indices() {
        let (_dir, conn) = setup();
        // Runs table with workspace_id
        conn.prepare("SELECT workspace_id FROM runs LIMIT 0").unwrap();
        // Test failures table
        conn.prepare("SELECT stable_id, test_id FROM test_failures LIMIT 0")
            .unwrap();
        // Indices exist
        let idx_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND \
                 name IN ('idx_runs_workspace_started', 'idx_test_failures_run_stable')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx_count, 2);
    }

    #[test]
    fn insert_and_query_runs() {
        let (_dir, mut conn) = setup();
        let tx = conn.transaction().unwrap();
        insert_run(&tx, "ws1", "run1", 1000).unwrap();
        complete_run(&tx, "run1", 2000).unwrap();
        tx.commit().unwrap();

        let runs = get_recent_runs(&conn, "ws1", 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "run1");
    }

    #[test]
    fn insert_and_query_failures() {
        let (_dir, mut conn) = setup();
        let tx = conn.transaction().unwrap();
        insert_run(&tx, "ws1", "run1", 1000).unwrap();
        let failures = vec![TestFailureRow {
            stable_id: "abc123".into(),
            test_id: "test1".into(),
            file: "test.ts".into(),
            message: "failed".into(),
        }];
        insert_test_failures(&tx, "run1", &failures).unwrap();
        tx.commit().unwrap();

        let ids = get_stable_ids_for_run(&conn, "run1").unwrap();
        assert_eq!(ids, vec!["abc123"]);
    }

    #[test]
    fn error_on_invalid_storage() {
        let dir = tempdir().unwrap();
        let bad_path = dir.path().join("nonexistent");
        assert!(init_storage(&bad_path).is_err());

        let corrupt_db = dir.path().join("corrupt");
        fs::create_dir(&corrupt_db).unwrap();
        fs::write(corrupt_db.join("db.sqlite"), b"garbage").unwrap();
        assert!(init_storage(&corrupt_db).is_err());
    }
}

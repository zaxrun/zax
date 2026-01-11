//! `SQLite` storage initialization for the workspace service.

use refinery::embed_migrations;
use rusqlite::Connection;
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

/// Initializes the `SQLite` database at `<cache_dir>/db.sqlite`.
///
/// Creates the database file if it doesn't exist, then runs all pending
/// migrations. Already-applied migrations are skipped.
pub fn init_storage(cache_dir: &Path) -> Result<(), StoreError> {
    let db_path = cache_dir.join("db.sqlite");
    let mut conn = Connection::open(&db_path)?;
    migrations::runner().run(&mut conn)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn init_storage_creates_db_file() {
        let dir = tempdir().unwrap();
        init_storage(dir.path()).unwrap();
        assert!(dir.path().join("db.sqlite").exists());
    }

    #[test]
    fn init_storage_idempotent() {
        let dir = tempdir().unwrap();
        init_storage(dir.path()).unwrap();
        // Second call should succeed without error
        init_storage(dir.path()).unwrap();

        // Verify migration was not re-run (only one entry in history)
        let conn = Connection::open(dir.path().join("db.sqlite")).unwrap();
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "Migration should only be applied once");
    }

    #[test]
    fn init_storage_runs_table_exists() {
        let dir = tempdir().unwrap();
        init_storage(dir.path()).unwrap();

        let conn = Connection::open(dir.path().join("db.sqlite")).unwrap();
        // Verify runs table exists with correct columns
        let stmt = conn
            .prepare("SELECT id, run_id, started_at, completed_at FROM runs LIMIT 0")
            .unwrap();
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        assert_eq!(columns, vec!["id", "run_id", "started_at", "completed_at"]);
    }

    #[test]
    fn init_storage_run_id_unique_constraint() {
        let dir = tempdir().unwrap();
        init_storage(dir.path()).unwrap();

        let conn = Connection::open(dir.path().join("db.sqlite")).unwrap();
        conn.execute(
            "INSERT INTO runs (run_id, started_at) VALUES ('test-run', 1234567890)",
            [],
        )
        .unwrap();

        // Duplicate run_id should fail
        let result = conn.execute(
            "INSERT INTO runs (run_id, started_at) VALUES ('test-run', 1234567891)",
            [],
        );
        assert!(result.is_err(), "Duplicate run_id should fail");
    }

    #[test]
    fn init_storage_refinery_schema_history_exists() {
        let dir = tempdir().unwrap();
        init_storage(dir.path()).unwrap();

        let conn = Connection::open(dir.path().join("db.sqlite")).unwrap();
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(count >= 1, "Should have at least one migration in history");
    }

    #[test]
    fn init_storage_read_only_dir_fails() {
        let dir = tempdir().unwrap();
        let readonly_path = dir.path().join("readonly");
        fs::create_dir(&readonly_path).unwrap();

        // Make directory read-only
        let mut perms = fs::metadata(&readonly_path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&readonly_path, perms).unwrap();

        let result = init_storage(&readonly_path);
        assert!(result.is_err(), "Should fail on read-only directory");

        // Clean up: restore write permissions for tempdir cleanup
        let mut perms = fs::metadata(&readonly_path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&readonly_path, perms).unwrap();
    }

    #[test]
    fn init_storage_corrupt_db_fails() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("db.sqlite");

        // Write garbage bytes to simulate corrupt database
        fs::write(&db_path, b"not a valid sqlite database").unwrap();

        let result = init_storage(dir.path());
        assert!(result.is_err(), "Should fail on corrupt database");
    }

    #[test]
    fn init_storage_nonexistent_dir_fails() {
        let dir = tempdir().unwrap();
        let nonexistent = dir.path().join("does_not_exist");
        let result = init_storage(&nonexistent);
        assert!(
            matches!(result, Err(StoreError::Sqlite(_))),
            "Should fail with Sqlite error when cache_dir doesn't exist"
        );
    }

    #[test]
    fn init_storage_read_only_returns_sqlite_error() {
        let dir = tempdir().unwrap();
        let readonly_path = dir.path().join("readonly2");
        fs::create_dir(&readonly_path).unwrap();

        let mut perms = fs::metadata(&readonly_path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&readonly_path, perms).unwrap();

        let result = init_storage(&readonly_path);
        assert!(
            matches!(result, Err(StoreError::Sqlite(_))),
            "Read-only dir should return StoreError::Sqlite"
        );

        // Clean up
        let mut perms = fs::metadata(&readonly_path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&readonly_path, perms).unwrap();
    }
}

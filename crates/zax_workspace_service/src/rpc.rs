//! RPC handler implementations for `IngestManifest` and `GetDeltaSummary`.

use crate::normalize::stable_id;
use crate::parsers::vitest;
use crate::store::{self, TestFailureRow};
use crate::zax::v1::{ArtifactKind, ArtifactManifest};
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tonic::Status;

/// Maximum artifact file size in bytes (100MB).
const MAX_ARTIFACT_SIZE: u64 = 100 * 1024 * 1024;

/// Shared state for RPC handlers.
pub struct RpcState {
    pub cache_dir: std::path::PathBuf,
    pub conn: Arc<Mutex<Connection>>,
}

/// Handles `IngestManifest` RPC.
#[allow(clippy::result_large_err)]
pub fn ingest_manifest(state: &RpcState, manifest: &ArtifactManifest) -> Result<(), Status> {
    validate_manifest(manifest)?;
    let artifact = get_test_failure_artifact(manifest)?;
    let artifact_path = validate_artifact_path(&state.cache_dir, &artifact.path)?;
    let content = read_artifact_file(&artifact_path)?;
    let failures = parse_and_compute_stable_ids(&content, &manifest.workspace_id)?;
    store_failures(state, manifest, &failures)?;
    Ok(())
}

#[allow(clippy::result_large_err)]
fn validate_manifest(manifest: &ArtifactManifest) -> Result<(), Status> {
    if manifest.workspace_id.is_empty() {
        return Err(Status::invalid_argument("workspace_id is required"));
    }
    if manifest.run_id.is_empty() {
        return Err(Status::invalid_argument("run_id is required"));
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
fn get_test_failure_artifact(
    manifest: &ArtifactManifest,
) -> Result<&crate::zax::v1::ArtifactRef, Status> {
    manifest
        .artifacts
        .iter()
        .find(|a| a.kind == ArtifactKind::TestFailure as i32)
        .ok_or_else(|| Status::invalid_argument("no test failure artifact in manifest"))
}

#[allow(clippy::result_large_err)]
fn validate_artifact_path(cache_dir: &Path, artifact_path: &str) -> Result<std::path::PathBuf, Status> {
    let path = std::path::PathBuf::from(artifact_path);
    let canonical = path.canonicalize().map_err(|_| {
        Status::not_found(format!("artifact file not found: {artifact_path}"))
    })?;
    let artifacts_dir = cache_dir.join("artifacts");
    if !canonical.starts_with(&artifacts_dir) {
        return Err(Status::not_found("artifact path outside artifacts directory"));
    }
    Ok(canonical)
}

#[allow(clippy::result_large_err)]
fn read_artifact_file(path: &Path) -> Result<String, Status> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| Status::not_found("artifact file not found"))?;
    if metadata.len() > MAX_ARTIFACT_SIZE {
        return Err(Status::invalid_argument(format!(
            "artifact file exceeds 100MB limit: {} bytes",
            metadata.len()
        )));
    }
    std::fs::read_to_string(path)
        .map_err(|e| Status::internal(format!("failed to read artifact: {e}")))
}

#[allow(clippy::result_large_err)]
fn parse_and_compute_stable_ids(content: &str, _workspace_id: &str) -> Result<Vec<TestFailureRow>, Status> {
    let parsed = vitest::parse(content, "")
        .map_err(|e| Status::invalid_argument(format!("parse error: {e}")))?;
    Ok(parsed
        .into_iter()
        .map(|f| TestFailureRow {
            stable_id: stable_id::compute(&f.file, &f.test_id),
            test_id: f.test_id,
            file: f.file,
            message: f.message,
        })
        .collect())
}

#[allow(clippy::result_large_err)]
fn store_failures(
    state: &RpcState,
    manifest: &ArtifactManifest,
    failures: &[TestFailureRow],
) -> Result<(), Status> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| Status::internal(format!("time error: {e}")))?
        .as_secs() as i64;
    let mut conn = state.conn.lock().map_err(|_| Status::internal("lock error"))?;
    let tx = conn
        .transaction()
        .map_err(|e| Status::internal(format!("transaction error: {e}")))?;
    store::insert_run(&tx, &manifest.workspace_id, &manifest.run_id, now)
        .map_err(|e| Status::internal(format!("insert run: {e}")))?;
    store::insert_test_failures(&tx, &manifest.run_id, failures)
        .map_err(|e| Status::internal(format!("insert failures: {e}")))?;
    store::complete_run(&tx, &manifest.run_id, now)
        .map_err(|e| Status::internal(format!("complete run: {e}")))?;
    tx.commit()
        .map_err(|e| Status::internal(format!("commit: {e}")))?;
    Ok(())
}

/// Handles `GetDeltaSummary` RPC.
#[allow(clippy::result_large_err)]
pub fn get_delta_summary(state: &RpcState, workspace_id: &str) -> Result<(i32, i32), Status> {
    if workspace_id.is_empty() {
        return Err(Status::invalid_argument("workspace_id is required"));
    }
    let conn = state.conn.lock().map_err(|_| Status::internal("lock error"))?;
    let runs = store::get_recent_runs(&conn, workspace_id, 2)
        .map_err(|e| Status::internal(format!("query runs: {e}")))?;
    compute_delta(&conn, &runs)
}

#[allow(clippy::result_large_err)]
fn compute_delta(conn: &Connection, runs: &[store::RunInfo]) -> Result<(i32, i32), Status> {
    if runs.is_empty() {
        return Ok((0, 0));
    }
    let current_ids: HashSet<String> = store::get_stable_ids_for_run(conn, &runs[0].run_id)
        .map_err(|e| Status::internal(format!("query current: {e}")))?
        .into_iter()
        .collect();
    if runs.len() < 2 {
        return Ok((current_ids.len() as i32, 0));
    }
    let previous_ids: HashSet<String> = store::get_stable_ids_for_run(conn, &runs[1].run_id)
        .map_err(|e| Status::internal(format!("query previous: {e}")))?
        .into_iter()
        .collect();
    let new_count = current_ids.difference(&previous_ids).count() as i32;
    let fixed_count = previous_ids.difference(&current_ids).count() as i32;
    Ok((new_count, fixed_count))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::store::{init_storage, open_connection};
    use crate::zax::v1::{ArtifactManifest, ArtifactRef};
    use tempfile::tempdir;

    fn state() -> (tempfile::TempDir, RpcState) {
        let d = tempdir().unwrap();
        init_storage(d.path()).unwrap();
        let c = open_connection(d.path()).unwrap();
        let p = d.path().to_path_buf();
        (d, RpcState { cache_dir: p, conn: Arc::new(Mutex::new(c)) })
    }

    fn mfst(ws: &str, run: &str) -> ArtifactManifest {
        ArtifactManifest { workspace_id: ws.into(), run_id: run.into(),
            artifacts: vec![ArtifactRef { artifact_id: "a".into(), kind: 2, path: "/x".into(), hash: String::new() }] }
    }

    #[test]
    fn ingest_validation_and_delta_validation() {
        let (_d, s) = state();
        assert_eq!(ingest_manifest(&s, &mfst("", "r")).unwrap_err().code(), tonic::Code::InvalidArgument);
        assert_eq!(ingest_manifest(&s, &mfst("w", "")).unwrap_err().code(), tonic::Code::InvalidArgument);
        assert_eq!(get_delta_summary(&s, "").unwrap_err().code(), tonic::Code::InvalidArgument);
        assert_eq!(get_delta_summary(&s, "ws1").unwrap(), (0, 0));
    }
}

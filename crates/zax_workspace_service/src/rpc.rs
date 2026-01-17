//! RPC handler implementations for `IngestManifest` and `GetDeltaSummary`.

// tonic::Status is 3 words (24 bytes) which exceeds clippy's default threshold.
// This is intentional - Status provides rich error info for gRPC responses.
#![allow(clippy::result_large_err)]
// Allow eprintln! for logging - output goes to engine.log via stderr redirect.
#![allow(clippy::print_stderr)]

use crate::normalize::stable_id;
use crate::parsers::{eslint, vitest};
use crate::store::{self, FindingRow, TestFailureRow};
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
pub fn ingest_manifest(state: &RpcState, manifest: &ArtifactManifest) -> Result<(), Status> {
    eprintln!(
        "[rpc] IngestManifest: workspace={}, run={}, artifacts={}",
        manifest.workspace_id,
        manifest.run_id,
        manifest.artifacts.len()
    );
    validate_manifest(manifest)?;
    let (failures, findings) = parse_artifacts(state, manifest)?;
    eprintln!(
        "[rpc] Parsed: {} test failures, {} findings",
        failures.len(),
        findings.len()
    );
    store_all(state, manifest, &failures, &findings)
}

fn validate_manifest(manifest: &ArtifactManifest) -> Result<(), Status> {
    if manifest.workspace_id.is_empty() {
        return Err(Status::invalid_argument("workspace_id is required"));
    }
    if manifest.run_id.is_empty() {
        return Err(Status::invalid_argument("run_id is required"));
    }
    Ok(())
}

fn parse_artifacts(
    state: &RpcState,
    manifest: &ArtifactManifest,
) -> Result<(Vec<TestFailureRow>, Vec<FindingRow>), Status> {
    let mut failures = Vec::new();
    let mut findings = Vec::new();

    for artifact in &manifest.artifacts {
        let path = validate_artifact_path(&state.cache_dir, &artifact.path)?;
        let content = read_artifact_file(&path)?;

        if artifact.kind == ArtifactKind::TestFailure as i32 {
            failures = parse_test_failures(&content)?;
        } else if artifact.kind == ArtifactKind::Finding as i32 {
            findings = parse_findings(&content)?;
        }
    }
    Ok((failures, findings))
}

fn validate_artifact_path(
    cache_dir: &Path,
    artifact_path: &str,
) -> Result<std::path::PathBuf, Status> {
    let path = std::path::PathBuf::from(artifact_path);
    let canonical = path
        .canonicalize()
        .map_err(|_| Status::not_found(format!("artifact file not found: {artifact_path}")))?;
    let artifacts_dir = cache_dir.join("artifacts");
    if !canonical.starts_with(&artifacts_dir) {
        return Err(Status::not_found(
            "artifact path outside artifacts directory",
        ));
    }
    Ok(canonical)
}

fn read_artifact_file(path: &Path) -> Result<String, Status> {
    let metadata =
        std::fs::metadata(path).map_err(|_| Status::not_found("artifact file not found"))?;
    if metadata.len() > MAX_ARTIFACT_SIZE {
        return Err(Status::invalid_argument(format!(
            "artifact file exceeds 100MB limit: {} bytes",
            metadata.len()
        )));
    }
    std::fs::read_to_string(path)
        .map_err(|e| Status::internal(format!("failed to read artifact: {e}")))
}

/// Parses test failures from pre-normalized Vitest JSON output.
///
/// NOTE: The Engine layer (TypeScript) normalizes file paths before writing
/// artifact files, stripping the `workspace_root` prefix. Therefore we pass
/// empty `workspace_root` here - paths are already relative.
fn parse_test_failures(content: &str) -> Result<Vec<TestFailureRow>, Status> {
    let parsed = vitest::parse(content, "").map_err(|e| {
        eprintln!("[rpc] Vitest parse error: {e}");
        Status::invalid_argument(format!("parse error: {e}"))
    })?;
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

/// Parses findings from pre-normalized `ESLint` JSON output.
///
/// NOTE: The Engine layer (TypeScript) normalizes file paths before writing
/// artifact files, stripping the `workspace_root` prefix. Therefore we pass
/// empty `workspace_root` here - paths are already relative.
fn parse_findings(content: &str) -> Result<Vec<FindingRow>, Status> {
    let parsed = eslint::parse(content, "").map_err(|e| {
        eprintln!("[rpc] ESLint parse error: {e}");
        Status::invalid_argument(format!("parse error: {e}"))
    })?;
    Ok(parsed
        .into_iter()
        .map(|f| FindingRow {
            stable_id: f.stable_id,
            tool: f.tool,
            rule: f.rule,
            file: f.file,
            start_line: f.start_line,
            start_column: f.start_column,
            end_line: f.end_line,
            end_column: f.end_column,
            message: f.message,
        })
        .collect())
}

fn store_all(
    state: &RpcState,
    manifest: &ArtifactManifest,
    failures: &[TestFailureRow],
    findings: &[FindingRow],
) -> Result<(), Status> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| Status::internal(format!("time error: {e}")))?
        .as_secs() as i64;
    let mut conn = state
        .conn
        .lock()
        .map_err(|_| Status::internal("lock error"))?;
    let tx = conn
        .transaction()
        .map_err(|e| Status::internal(format!("transaction error: {e}")))?;
    store::insert_run(&tx, &manifest.workspace_id, &manifest.run_id, now)
        .map_err(|e| Status::internal(format!("insert run: {e}")))?;
    store::insert_test_failures(&tx, &manifest.run_id, failures)
        .map_err(|e| Status::internal(format!("insert failures: {e}")))?;
    store::insert_findings(&tx, &manifest.run_id, findings)
        .map_err(|e| Status::internal(format!("insert findings: {e}")))?;
    store::complete_run(&tx, &manifest.run_id, now)
        .map_err(|e| Status::internal(format!("complete run: {e}")))?;
    tx.commit()
        .map_err(|e| Status::internal(format!("commit: {e}")))?;
    Ok(())
}

/// Delta result with test failures and findings counts.
#[derive(Debug)]
pub struct DeltaResult {
    pub new_test_failures: i32,
    pub fixed_test_failures: i32,
    pub new_findings: i32,
    pub fixed_findings: i32,
}

/// Handles `GetDeltaSummary` RPC.
pub fn get_delta_summary(state: &RpcState, workspace_id: &str) -> Result<DeltaResult, Status> {
    eprintln!("[rpc] GetDeltaSummary: workspace={}", workspace_id);
    if workspace_id.is_empty() {
        return Err(Status::invalid_argument("workspace_id is required"));
    }
    let conn = state
        .conn
        .lock()
        .map_err(|_| Status::internal("lock error"))?;
    let runs = store::get_recent_runs(&conn, workspace_id, 2)
        .map_err(|e| Status::internal(format!("query runs: {e}")))?;
    let result = compute_delta(&conn, &runs)?;
    eprintln!(
        "[rpc] Delta: new_tf={}, fixed_tf={}, new_f={}, fixed_f={}",
        result.new_test_failures,
        result.fixed_test_failures,
        result.new_findings,
        result.fixed_findings
    );
    Ok(result)
}

fn compute_delta(conn: &Connection, runs: &[store::RunInfo]) -> Result<DeltaResult, Status> {
    if runs.is_empty() {
        return Ok(DeltaResult {
            new_test_failures: 0,
            fixed_test_failures: 0,
            new_findings: 0,
            fixed_findings: 0,
        });
    }
    let (new_tf, fixed_tf) = compute_entity_delta(conn, runs, store::get_stable_ids_for_run)?;
    let (new_f, fixed_f) = compute_entity_delta(conn, runs, store::get_finding_stable_ids_for_run)?;
    Ok(DeltaResult {
        new_test_failures: new_tf,
        fixed_test_failures: fixed_tf,
        new_findings: new_f,
        fixed_findings: fixed_f,
    })
}

fn compute_entity_delta<F>(
    conn: &Connection,
    runs: &[store::RunInfo],
    query_fn: F,
) -> Result<(i32, i32), Status>
where
    F: Fn(&Connection, &str) -> Result<Vec<String>, store::StoreError>,
{
    let current_ids: HashSet<String> = query_fn(conn, &runs[0].run_id)
        .map_err(|e| Status::internal(format!("query current: {e}")))?
        .into_iter()
        .collect();
    if runs.len() < 2 {
        return Ok((current_ids.len() as i32, 0));
    }
    let previous_ids: HashSet<String> = query_fn(conn, &runs[1].run_id)
        .map_err(|e| Status::internal(format!("query previous: {e}")))?
        .into_iter()
        .collect();
    Ok((
        current_ids.difference(&previous_ids).count() as i32,
        previous_ids.difference(&current_ids).count() as i32,
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::store::{init_storage, open_connection};
    use crate::zax::v1::ArtifactRef;
    use std::fs;
    use tempfile::tempdir;

    fn create_test_state() -> (tempfile::TempDir, RpcState) {
        let temp_dir = tempdir().unwrap();
        init_storage(temp_dir.path()).unwrap();
        let conn = open_connection(temp_dir.path()).unwrap();
        let cache_dir = temp_dir.path().to_path_buf();
        (
            temp_dir,
            RpcState {
                cache_dir,
                conn: Arc::new(Mutex::new(conn)),
            },
        )
    }

    fn create_manifest(
        workspace_id: &str,
        run_id: &str,
        kind: ArtifactKind,
        path: &str,
    ) -> ArtifactManifest {
        ArtifactManifest {
            workspace_id: workspace_id.into(),
            run_id: run_id.into(),
            artifacts: vec![ArtifactRef {
                artifact_id: "a1".into(),
                kind: kind as i32,
                path: path.into(),
                hash: String::new(),
            }],
        }
    }

    #[test]
    fn manifest_validation_rejects_empty_fields() {
        let (_dir, state) = create_test_state();
        let m1 = create_manifest("", "run1", ArtifactKind::TestFailure, "/p");
        assert!(ingest_manifest(&state, &m1)
            .unwrap_err()
            .message()
            .contains("workspace_id"));
        let m2 = create_manifest("ws1", "", ArtifactKind::TestFailure, "/p");
        assert!(ingest_manifest(&state, &m2)
            .unwrap_err()
            .message()
            .contains("run_id"));
    }

    #[test]
    fn delta_validation_rejects_empty_workspace() {
        let (_dir, state) = create_test_state();
        assert!(get_delta_summary(&state, "")
            .unwrap_err()
            .message()
            .contains("workspace_id"));
    }

    #[test]
    fn path_traversal_rejected() {
        let (temp_dir, state) = create_test_state();
        let artifacts_dir = temp_dir.path().join("artifacts");
        fs::create_dir_all(&artifacts_dir).unwrap();
        fs::write(temp_dir.path().join("secret.txt"), "secret").unwrap();
        let path = artifacts_dir.join("..").join("secret.txt");
        let err = validate_artifact_path(&state.cache_dir, path.to_str().unwrap()).unwrap_err();
        assert!(err.message().contains("outside"));
    }

    #[test]
    fn artifact_size_limit_is_100mb() {
        assert_eq!(MAX_ARTIFACT_SIZE, 100 * 1024 * 1024);
    }

    #[test]
    fn delta_with_findings_and_failures() {
        let (_dir, state) = create_test_state();
        // Run 1
        {
            let mut conn = state.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            store::insert_run(&tx, "ws1", "run1", 1000).unwrap();
            store::insert_test_failures(
                &tx,
                "run1",
                &[TestFailureRow {
                    stable_id: "tf1".into(),
                    test_id: "t1".into(),
                    file: "f".into(),
                    message: "m".into(),
                }],
            )
            .unwrap();
            store::insert_findings(
                &tx,
                "run1",
                &[FindingRow {
                    stable_id: "f1".into(),
                    tool: "eslint".into(),
                    rule: "r".into(),
                    file: "f".into(),
                    start_line: 1,
                    start_column: 1,
                    end_line: 1,
                    end_column: 1,
                    message: "m".into(),
                }],
            )
            .unwrap();
            store::complete_run(&tx, "run1", 1001).unwrap();
            tx.commit().unwrap();
        }
        let result = get_delta_summary(&state, "ws1").unwrap();
        assert_eq!(result.new_test_failures, 1);
        assert_eq!(result.fixed_test_failures, 0);
        assert_eq!(result.new_findings, 1);
        assert_eq!(result.fixed_findings, 0);
    }

    // P18: Empty findings delta
    #[test]
    fn delta_with_no_findings_returns_zero() {
        let (_dir, state) = create_test_state();
        // Run with no findings
        {
            let mut conn = state.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            store::insert_run(&tx, "ws1", "run1", 1000).unwrap();
            store::complete_run(&tx, "run1", 1001).unwrap();
            tx.commit().unwrap();
        }
        let result = get_delta_summary(&state, "ws1").unwrap();
        assert_eq!(result.new_findings, 0);
        assert_eq!(result.fixed_findings, 0);
    }

    // P17: First run baseline - all findings are new
    #[test]
    fn first_run_all_findings_are_new() {
        let (_dir, state) = create_test_state();
        {
            let mut conn = state.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            store::insert_run(&tx, "ws1", "run1", 1000).unwrap();
            store::insert_findings(
                &tx,
                "run1",
                &[
                    FindingRow {
                        stable_id: "f1".into(),
                        tool: "eslint".into(),
                        rule: "r".into(),
                        file: "f".into(),
                        start_line: 1,
                        start_column: 1,
                        end_line: 1,
                        end_column: 1,
                        message: "m".into(),
                    },
                    FindingRow {
                        stable_id: "f2".into(),
                        tool: "eslint".into(),
                        rule: "r".into(),
                        file: "f".into(),
                        start_line: 2,
                        start_column: 1,
                        end_line: 2,
                        end_column: 1,
                        message: "m".into(),
                    },
                ],
            )
            .unwrap();
            store::complete_run(&tx, "run1", 1001).unwrap();
            tx.commit().unwrap();
        }
        let result = get_delta_summary(&state, "ws1").unwrap();
        assert_eq!(result.new_findings, 2);
        assert_eq!(result.fixed_findings, 0);
    }

    // P16: Delta computation - finds new and fixed findings
    #[test]
    fn delta_detects_new_and_fixed_findings() {
        let (_dir, state) = create_test_state();
        // Run 1: has f1, f2
        {
            let mut conn = state.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            store::insert_run(&tx, "ws1", "run1", 1000).unwrap();
            store::insert_findings(
                &tx,
                "run1",
                &[
                    FindingRow {
                        stable_id: "f1".into(),
                        tool: "eslint".into(),
                        rule: "r".into(),
                        file: "f".into(),
                        start_line: 1,
                        start_column: 1,
                        end_line: 1,
                        end_column: 1,
                        message: "m".into(),
                    },
                    FindingRow {
                        stable_id: "f2".into(),
                        tool: "eslint".into(),
                        rule: "r".into(),
                        file: "f".into(),
                        start_line: 2,
                        start_column: 1,
                        end_line: 2,
                        end_column: 1,
                        message: "m".into(),
                    },
                ],
            )
            .unwrap();
            store::complete_run(&tx, "run1", 1001).unwrap();
            tx.commit().unwrap();
        }
        // Run 2: has f1, f3 (f2 fixed, f3 new)
        {
            let mut conn = state.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            store::insert_run(&tx, "ws1", "run2", 2000).unwrap();
            store::insert_findings(
                &tx,
                "run2",
                &[
                    FindingRow {
                        stable_id: "f1".into(),
                        tool: "eslint".into(),
                        rule: "r".into(),
                        file: "f".into(),
                        start_line: 1,
                        start_column: 1,
                        end_line: 1,
                        end_column: 1,
                        message: "m".into(),
                    },
                    FindingRow {
                        stable_id: "f3".into(),
                        tool: "eslint".into(),
                        rule: "r".into(),
                        file: "f".into(),
                        start_line: 3,
                        start_column: 1,
                        end_line: 3,
                        end_column: 1,
                        message: "m".into(),
                    },
                ],
            )
            .unwrap();
            store::complete_run(&tx, "run2", 2001).unwrap();
            tx.commit().unwrap();
        }
        let result = get_delta_summary(&state, "ws1").unwrap();
        assert_eq!(result.new_findings, 1); // f3 is new
        assert_eq!(result.fixed_findings, 1); // f2 is fixed
    }
}

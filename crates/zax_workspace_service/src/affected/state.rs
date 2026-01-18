//! Affected state integration.
//!
//! Combines dirty tracker, dependency graph, and affected computation
//! into a unified state for the RPC handler.
#![allow(clippy::print_stderr)]

use super::compute::compute_affected;
use super::discovery::discover_tests;
use super::graph::{new_shared_graph, SharedDepGraph};
use super::parser::parse_imports;
use super::resolver::PathResolver;
use super::watcher::{is_config_file, start_watcher, DirtyTracker, WatcherConfig};
use ignore::WalkBuilder;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Result of affected test computation.
#[derive(Debug, Clone)]
pub struct AffectedResult {
    pub test_files: Vec<String>,
    pub dirty_files: Vec<String>,
    pub is_full_run: bool,
}

impl AffectedResult {
    /// Create an empty result (no tests affected).
    fn empty() -> Self {
        Self { test_files: Vec::new(), dirty_files: Vec::new(), is_full_run: false }
    }

    /// Create a full run result with no tests discovered yet.
    fn full_run_empty() -> Self {
        Self { test_files: Vec::new(), dirty_files: Vec::new(), is_full_run: true }
    }
}

/// Shared state for affected test selection.
pub struct AffectedState {
    pub tracker: DirtyTracker,
    pub graph: SharedDepGraph,
    pub graph_ready: Arc<AtomicBool>,
    pub workspace_root: PathBuf,
    event_rx: Option<mpsc::Receiver<PathBuf>>,
}

impl AffectedState {
    /// Create a new affected state for the workspace.
    pub fn new(workspace_root: PathBuf) -> Self {
        let tracker = DirtyTracker::new(workspace_root.clone());
        let graph = new_shared_graph();
        let graph_ready = Arc::new(AtomicBool::new(false));

        Self {
            tracker,
            graph,
            graph_ready,
            workspace_root,
            event_rx: None,
        }
    }

    /// Start the file watcher background task.
    /// Returns an error if the watcher fails to start.
    pub fn start_watcher(&mut self) -> Result<(), String> {
        let config = WatcherConfig::new(self.workspace_root.clone());
        let rx = start_watcher(config).map_err(|e| format!("watcher start failed: {e}"))?;
        self.event_rx = Some(rx);
        Ok(())
    }

    /// Process pending file events from the watcher.
    pub fn process_events(&mut self) {
        // Collect paths first to avoid borrowing issues
        let paths: Vec<PathBuf> = if let Some(ref mut rx) = self.event_rx {
            let mut collected = Vec::new();
            while let Ok(path) = rx.try_recv() {
                collected.push(path);
            }
            collected
        } else {
            return;
        };

        for path in paths {
            // Check if config file changed
            if is_config_file(&path) && self.tracker.check_config_change(&path) {
                eprintln!(
                    "[affected] INFO: config file changed: {}",
                    path.display()
                );
                self.tracker.set_config_changed();
            }

            // Add to dirty set
            self.tracker.add_dirty(path.clone());

            // Update graph if ready
            if self.graph_ready.load(Ordering::SeqCst) {
                self.update_graph_for_file(&path);
            }
        }
    }

    /// Update the graph when a file changes.
    fn update_graph_for_file(&self, path: &Path) {
        if !is_ts_js_file(path) {
            return;
        }

        let Ok(path) = path.canonicalize() else {
            return;
        };

        // Check if file still exists (delete case)
        if !path.exists() {
            if let Ok(mut graph) = self.graph.write() {
                graph.remove_file(&path);
            }
            return;
        }

        // Parse and update edges
        let resolver = PathResolver::new(self.workspace_root.clone());
        let imports = parse_imports(&path);

        // Add file if new
        if let Ok(mut graph) = self.graph.write() {
            graph.add_file(path.clone());
        }

        // Resolve imports
        let mut resolved = Vec::new();
        for import in imports {
            if let Some(resolved_path) = resolver.resolve(&path, &import.specifier) {
                if let Ok(mut graph) = self.graph.write() {
                    if graph.add_file(resolved_path.clone()).is_some() {
                        resolved.push(resolved_path);
                    }
                }
            }
        }

        // Update edges
        if let Ok(mut graph) = self.graph.write() {
            graph.update_edges(&path, &resolved);
        }
    }

    /// Get affected tests based on current dirty set.
    /// If `package_scope` is non-empty, filters tests to those within the package.
    pub fn get_affected_tests(&mut self, force_full: bool, package_scope: &str) -> AffectedResult {
        let request_id = generate_request_id();
        log_request_start(&request_id, force_full, package_scope);
        self.process_events();

        if force_full {
            return self.handle_full_run(&request_id, package_scope, Vec::new());
        }

        if !self.graph_ready.load(Ordering::SeqCst) {
            log_info(&request_id, "graph still building, returning is_full_run=true");
            return AffectedResult::full_run_empty();
        }

        let (dirty, overflow, config_changed) = self.tracker.drain();
        let dirty_files = to_relative_strings(&dirty, &self.workspace_root);

        if let Some(result) = self.check_full_run_conditions(
            &request_id, package_scope, &dirty_files, overflow, config_changed
        ) {
            return result;
        }

        if dirty.is_empty() {
            log_info(&request_id, "dirty set empty, no tests affected");
            return AffectedResult::empty();
        }

        self.compute_affected_result(&request_id, package_scope, &dirty, dirty_files)
    }

    /// Handle conditions that require a full test run.
    #[allow(clippy::too_many_arguments)]
    fn check_full_run_conditions(
        &self,
        request_id: &str,
        package_scope: &str,
        dirty_files: &[String],
        overflow: bool,
        config_changed: bool,
    ) -> Option<AffectedResult> {
        if config_changed {
            return Some(self.handle_full_run_with_dirty(request_id, "config changed", package_scope, dirty_files));
        }
        if overflow {
            return Some(self.handle_full_run_with_dirty(request_id, "dirty overflow", package_scope, dirty_files));
        }
        if self.is_graph_overflow() {
            return Some(self.handle_full_run_with_dirty(request_id, "graph overflow", package_scope, dirty_files));
        }
        None
    }

    /// Check if the dependency graph has overflowed.
    fn is_graph_overflow(&self) -> bool {
        self.graph.read().map(|g| g.is_overflow()).unwrap_or(true)
    }

    /// Handle a full run request, returning all tests in scope.
    fn handle_full_run(&self, request_id: &str, package_scope: &str, dirty_files: Vec<String>) -> AffectedResult {
        let test_files = self.discover_all_tests_scoped(package_scope);
        log_info(request_id, &format!("force_full=true, returning {} tests", test_files.len()));
        AffectedResult { test_files, dirty_files, is_full_run: true }
    }

    /// Handle a full run with dirty files already computed.
    #[allow(clippy::too_many_arguments)]
    fn handle_full_run_with_dirty(&self, request_id: &str, reason: &str, package_scope: &str, dirty_files: &[String]) -> AffectedResult {
        let test_files = self.discover_all_tests_scoped(package_scope);
        log_info(request_id, &format!("{}, returning {} tests", reason, test_files.len()));
        AffectedResult { test_files, dirty_files: dirty_files.to_vec(), is_full_run: true }
    }

    /// Compute affected tests from dirty set.
    #[allow(clippy::too_many_arguments)]
    fn compute_affected_result(
        &self,
        request_id: &str,
        package_scope: &str,
        dirty: &HashSet<PathBuf>,
        dirty_files: Vec<String>,
    ) -> AffectedResult {
        let affected = self.graph.read()
            .map(|g| compute_affected(dirty, &g))
            .unwrap_or_default();

        let test_paths = discover_tests(&affected, &self.workspace_root);
        let test_files = filter_by_package_scope(
            to_relative_strings_vec(&test_paths, &self.workspace_root),
            package_scope,
        );

        log_info(request_id, &format!(
            "dirty={}, affected={}, tests={}", dirty.len(), affected.len(), test_files.len()
        ));

        AffectedResult { test_files, dirty_files, is_full_run: false }
    }

    /// Discover all test files, filtered by package scope.
    fn discover_all_tests_scoped(&self, package_scope: &str) -> Vec<String> {
        let mut tests = Vec::new();
        let walker = WalkBuilder::new(&self.workspace_root)
            .hidden(false)
            .git_ignore(true)
            .build();

        for entry in walker.flatten() {
            let path = entry.path();
            if super::discovery::is_test_file(path) {
                if let Some(rel) = path_to_relative(path, &self.workspace_root) {
                    if matches_package_scope(&rel, package_scope) {
                        tests.push(rel);
                    }
                }
            }
        }
        tests
    }
}

fn is_ts_js_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    matches!(
        ext,
        "ts" | "tsx" | "js" | "jsx" | "mts" | "mjs" | "cts" | "cjs"
    )
}

fn log_request_start(request_id: &str, force_full: bool, package_scope: &str) {
    let pkg = if package_scope.is_empty() { "<none>" } else { package_scope };
    eprintln!("[affected:{request_id}] INFO: GetAffectedTests force_full={force_full}, package={pkg}");
}

fn log_info(request_id: &str, msg: &str) {
    eprintln!("[affected:{request_id}] INFO: {msg}");
}

fn generate_request_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", nanos % 0xFFFFFF)
}

fn path_to_relative(path: &Path, workspace_root: &Path) -> Option<String> {
    path.strip_prefix(workspace_root)
        .ok()
        .map(|p| p.display().to_string())
}

fn to_relative_strings(paths: &HashSet<PathBuf>, workspace_root: &Path) -> Vec<String> {
    paths
        .iter()
        .filter_map(|p| path_to_relative(p, workspace_root))
        .collect()
}

fn to_relative_strings_vec(paths: &[PathBuf], workspace_root: &Path) -> Vec<String> {
    paths
        .iter()
        .filter_map(|p| path_to_relative(p, workspace_root))
        .collect()
}

/// Checks if a path matches the package scope using directory-aware prefix matching.
/// Pattern: `path == scope || path.starts_with(scope + "/")`
/// Empty scope matches all paths.
fn matches_package_scope(path: &str, scope: &str) -> bool {
    if scope.is_empty() {
        return true;
    }
    path == scope || path.starts_with(&format!("{scope}/"))
}

/// Filters paths to those matching the package scope.
fn filter_by_package_scope(paths: Vec<String>, scope: &str) -> Vec<String> {
    if scope.is_empty() {
        return paths;
    }
    paths
        .into_iter()
        .filter(|p| matches_package_scope(p, scope))
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn is_ts_js_file_matches() {
        assert!(is_ts_js_file(Path::new("foo.ts")));
        assert!(is_ts_js_file(Path::new("foo.tsx")));
        assert!(is_ts_js_file(Path::new("foo.js")));
        assert!(is_ts_js_file(Path::new("foo.jsx")));
        assert!(is_ts_js_file(Path::new("foo.mts")));
        assert!(is_ts_js_file(Path::new("foo.mjs")));
        assert!(is_ts_js_file(Path::new("foo.cts")));
        assert!(is_ts_js_file(Path::new("foo.cjs")));
        assert!(!is_ts_js_file(Path::new("foo.rs")));
        assert!(!is_ts_js_file(Path::new("foo.json")));
    }

    #[test]
    fn path_to_relative_works() {
        let workspace = PathBuf::from("/workspace");
        let path = PathBuf::from("/workspace/src/foo.ts");
        assert_eq!(
            path_to_relative(&path, &workspace),
            Some("src/foo.ts".into())
        );
    }

    #[test]
    fn affected_state_new() {
        let dir = tempdir().unwrap();
        let state = AffectedState::new(dir.path().to_path_buf());
        assert!(!state.graph_ready.load(Ordering::SeqCst));
        assert_eq!(state.workspace_root, dir.path());
    }

    #[test]
    fn affected_result_force_full() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("main.test.ts"), "test('x', () => {})").unwrap();

        let mut state = AffectedState::new(dir.path().to_path_buf());
        state.graph_ready.store(true, Ordering::SeqCst);

        let result = state.get_affected_tests(true, "");
        assert!(result.is_full_run);
    }

    #[test]
    fn affected_result_graph_building() {
        let dir = tempdir().unwrap();
        let mut state = AffectedState::new(dir.path().to_path_buf());
        // graph_ready defaults to false

        let result = state.get_affected_tests(false, "");
        assert!(result.is_full_run);
    }

    #[test]
    fn affected_result_empty_dirty() {
        let dir = tempdir().unwrap();
        let mut state = AffectedState::new(dir.path().to_path_buf());
        state.graph_ready.store(true, Ordering::SeqCst);

        let result = state.get_affected_tests(false, "");
        assert!(!result.is_full_run);
        assert!(result.test_files.is_empty());
        assert!(result.dirty_files.is_empty());
    }

    #[test]
    fn generate_request_id_is_hex() {
        let id = generate_request_id();
        assert!(!id.is_empty());
        // Should be valid hex
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn matches_package_scope_empty_matches_all() {
        assert!(matches_package_scope("packages/auth/test.ts", ""));
        assert!(matches_package_scope("src/test.ts", ""));
    }

    #[test]
    fn matches_package_scope_exact_match() {
        assert!(matches_package_scope("packages/auth", "packages/auth"));
    }

    #[test]
    fn matches_package_scope_prefix_with_slash() {
        assert!(matches_package_scope("packages/auth/test.ts", "packages/auth"));
        assert!(matches_package_scope("packages/auth/src/test.ts", "packages/auth"));
    }

    #[test]
    fn matches_package_scope_no_partial_prefix() {
        // "packages/auth-admin" should NOT match "packages/auth"
        assert!(!matches_package_scope("packages/auth-admin/test.ts", "packages/auth"));
    }

    #[test]
    fn filter_by_package_scope_works() {
        let paths = vec![
            "packages/auth/test.ts".to_string(),
            "packages/web/test.ts".to_string(),
            "packages/auth-admin/test.ts".to_string(),
        ];
        let filtered = filter_by_package_scope(paths.clone(), "packages/auth");
        assert_eq!(filtered, vec!["packages/auth/test.ts"]);

        // Empty scope returns all
        let all = filter_by_package_scope(paths, "");
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn affected_tests_scoped_by_package() {
        let dir = tempdir().unwrap();
        // Create test files in different packages
        let auth = dir.path().join("packages/auth");
        let web = dir.path().join("packages/web");
        fs::create_dir_all(&auth).unwrap();
        fs::create_dir_all(&web).unwrap();
        fs::write(auth.join("test.test.ts"), "test('a', () => {})").unwrap();
        fs::write(web.join("test.test.ts"), "test('w', () => {})").unwrap();

        let mut state = AffectedState::new(dir.path().to_path_buf());
        state.graph_ready.store(true, Ordering::SeqCst);

        // Full run with scope returns only scoped tests
        let auth_result = state.get_affected_tests(true, "packages/auth");
        assert!(auth_result.is_full_run);
        assert_eq!(auth_result.test_files.len(), 1);
        assert!(auth_result.test_files[0].contains("auth"));

        // Empty scope returns all tests
        let all_result = state.get_affected_tests(true, "");
        assert_eq!(all_result.test_files.len(), 2);
    }
}

//! Affected state integration.
//!
//! Combines dirty tracker, dependency graph, and affected computation
//! into a unified state for the RPC handler.
#![allow(clippy::print_stderr)]
#![allow(clippy::unwrap_used)]

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
            let mut graph = self.graph.write().unwrap();
            graph.remove_file(&path);
            return;
        }

        // Parse and update edges
        let resolver = PathResolver::new(self.workspace_root.clone());
        let imports = parse_imports(&path);

        // Add file if new
        {
            let mut graph = self.graph.write().unwrap();
            graph.add_file(path.clone());
        }

        // Resolve imports
        let mut resolved = Vec::new();
        for import in imports {
            if let Some(resolved_path) = resolver.resolve(&path, &import.specifier) {
                let mut graph = self.graph.write().unwrap();
                if graph.add_file(resolved_path.clone()).is_some() {
                    resolved.push(resolved_path);
                }
            }
        }

        // Update edges
        {
            let mut graph = self.graph.write().unwrap();
            graph.update_edges(&path, &resolved);
        }
    }

    /// Get affected tests based on current dirty set.
    #[allow(clippy::too_many_lines)]
    pub fn get_affected_tests(&mut self, force_full: bool) -> AffectedResult {
        let request_id = generate_request_id();
        eprintln!(
            "[affected:{}] INFO: GetAffectedTests force_full={}",
            request_id, force_full
        );

        // Process any pending events first
        self.process_events();

        // Force full run requested
        if force_full {
            let test_files = self.discover_all_tests();
            eprintln!(
                "[affected:{}] INFO: force_full=true, returning {} tests",
                request_id,
                test_files.len()
            );
            return AffectedResult {
                test_files,
                dirty_files: Vec::new(),
                is_full_run: true,
            };
        }

        // Graph still building
        if !self.graph_ready.load(Ordering::SeqCst) {
            eprintln!(
                "[affected:{}] INFO: graph still building, returning is_full_run=true",
                request_id
            );
            return AffectedResult {
                test_files: Vec::new(),
                dirty_files: Vec::new(),
                is_full_run: true,
            };
        }

        // Drain dirty set
        let (dirty, overflow, config_changed) = self.tracker.drain();
        let dirty_count = dirty.len();

        // Check for config file change
        if config_changed {
            let test_files = self.discover_all_tests();
            eprintln!(
                "[affected:{}] INFO: config changed, returning {} tests",
                request_id,
                test_files.len()
            );
            return AffectedResult {
                test_files,
                dirty_files: to_relative_strings(&dirty, &self.workspace_root),
                is_full_run: true,
            };
        }

        // Check for dirty set overflow
        if overflow {
            let test_files = self.discover_all_tests();
            eprintln!(
                "[affected:{}] INFO: dirty overflow, returning {} tests",
                request_id,
                test_files.len()
            );
            return AffectedResult {
                test_files,
                dirty_files: to_relative_strings(&dirty, &self.workspace_root),
                is_full_run: true,
            };
        }

        // Check for graph overflow
        {
            let graph = self.graph.read().unwrap();
            if graph.is_overflow() {
                drop(graph);
                let test_files = self.discover_all_tests();
                eprintln!(
                    "[affected:{}] INFO: graph overflow, returning {} tests",
                    request_id,
                    test_files.len()
                );
                return AffectedResult {
                    test_files,
                    dirty_files: to_relative_strings(&dirty, &self.workspace_root),
                    is_full_run: true,
                };
            }
        }

        // Empty dirty set
        if dirty.is_empty() {
            eprintln!(
                "[affected:{}] INFO: dirty set empty, no tests affected",
                request_id
            );
            return AffectedResult {
                test_files: Vec::new(),
                dirty_files: Vec::new(),
                is_full_run: false,
            };
        }

        // Compute affected files
        let affected = {
            let graph = self.graph.read().unwrap();
            compute_affected(&dirty, &graph)
        };

        // Discover test files
        let test_paths = discover_tests(&affected, &self.workspace_root);
        let test_files = to_relative_strings_vec(&test_paths, &self.workspace_root);
        let dirty_files = to_relative_strings(&dirty, &self.workspace_root);

        eprintln!(
            "[affected:{}] INFO: dirty={}, affected={}, tests={}",
            request_id,
            dirty_count,
            affected.len(),
            test_files.len()
        );

        AffectedResult {
            test_files,
            dirty_files,
            is_full_run: false,
        }
    }

    /// Discover all test files in the workspace.
    fn discover_all_tests(&self) -> Vec<String> {
        let mut tests = Vec::new();
        let walker = WalkBuilder::new(&self.workspace_root)
            .hidden(false)
            .git_ignore(true)
            .build();

        for entry in walker.flatten() {
            let path = entry.path();
            if super::discovery::is_test_file(path) {
                if let Some(rel) = path_to_relative(path, &self.workspace_root) {
                    tests.push(rel);
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

#[cfg(test)]
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

        let result = state.get_affected_tests(true);
        assert!(result.is_full_run);
    }

    #[test]
    fn affected_result_graph_building() {
        let dir = tempdir().unwrap();
        let mut state = AffectedState::new(dir.path().to_path_buf());
        // graph_ready defaults to false

        let result = state.get_affected_tests(false);
        assert!(result.is_full_run);
    }

    #[test]
    fn affected_result_empty_dirty() {
        let dir = tempdir().unwrap();
        let mut state = AffectedState::new(dir.path().to_path_buf());
        state.graph_ready.store(true, Ordering::SeqCst);

        let result = state.get_affected_tests(false);
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
}

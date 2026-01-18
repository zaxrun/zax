//! File watcher and dirty tracker using notify-rs.
//!
//! Monitors the workspace for file changes and maintains a set of dirty files.
#![allow(clippy::print_stderr)]
#![allow(clippy::unwrap_used)]

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc;

/// Maximum dirty set size before triggering overflow.
const MAX_DIRTY_FILES: usize = 500;
/// Debounce interval in milliseconds.
const DEBOUNCE_MS: u64 = 100;

/// Dirty file tracker with overflow protection.
pub struct DirtyTracker {
    dirty: Mutex<HashSet<PathBuf>>,
    overflow: Mutex<bool>,
    config_changed: Mutex<bool>,
    config_hashes: Mutex<HashMap<PathBuf, String>>,
}

impl DirtyTracker {
    /// Create a new dirty tracker.
    pub fn new(_workspace_root: PathBuf) -> Self {
        Self {
            dirty: Mutex::new(HashSet::new()),
            overflow: Mutex::new(false),
            config_changed: Mutex::new(false),
            config_hashes: Mutex::new(HashMap::new()),
        }
    }

    /// Add a dirty file. Returns true if overflow triggered.
    pub fn add_dirty(&self, path: PathBuf) -> bool {
        let mut dirty = self.dirty.lock().unwrap();

        if dirty.len() >= MAX_DIRTY_FILES {
            if !*self.overflow.lock().unwrap() {
                eprintln!(
                    "[affected] WARN: dirty set exceeded {} files, triggering full run",
                    MAX_DIRTY_FILES
                );
                *self.overflow.lock().unwrap() = true;
            }
            return true;
        }

        dirty.insert(path);
        false
    }

    /// Drain and return all dirty files. Clears the set.
    /// Returns (files, overflow, `config_changed`).
    pub fn drain(&self) -> (HashSet<PathBuf>, bool, bool) {
        let mut dirty = self.dirty.lock().unwrap();
        let mut overflow = self.overflow.lock().unwrap();
        let mut config_changed = self.config_changed.lock().unwrap();

        let files = std::mem::take(&mut *dirty);
        let was_overflow = *overflow;
        let was_config_changed = *config_changed;
        *overflow = false;
        *config_changed = false;

        (files, was_overflow, was_config_changed)
    }

    /// Mark that a config file has changed, triggering full run.
    pub fn set_config_changed(&self) {
        *self.config_changed.lock().unwrap() = true;
    }

    /// Check if a config file changed by comparing hashes.
    pub fn check_config_change(&self, path: &Path) -> bool {
        let Ok(content) = std::fs::read(path) else {
            return false;
        };

        let hash = blake3::hash(&content).to_hex().to_string();
        let mut hashes = self.config_hashes.lock().unwrap();

        if let Some(old_hash) = hashes.get(path) {
            if *old_hash != hash {
                hashes.insert(path.to_path_buf(), hash);
                return true;
            }
            false
        } else {
            hashes.insert(path.to_path_buf(), hash);
            false // First time seeing this file, not a change
        }
    }
}

/// Configuration for the file watcher.
pub struct WatcherConfig {
    pub workspace_root: PathBuf,
    pub gitignore: Option<Gitignore>,
}

impl WatcherConfig {
    /// Create watcher config with gitignore from workspace root.
    pub fn new(workspace_root: PathBuf) -> Self {
        let gitignore = load_gitignore(&workspace_root);
        Self {
            workspace_root,
            gitignore,
        }
    }

    /// Check if a path should be ignored.
    pub fn should_ignore(&self, path: &Path) -> bool {
        // Always ignore node_modules
        if path
            .components()
            .any(|c| c.as_os_str() == "node_modules")
        {
            return true;
        }

        // Check gitignore
        if let Some(ref gi) = self.gitignore {
            let relative = path.strip_prefix(&self.workspace_root).unwrap_or(path);
            if gi.matched(relative, path.is_dir()).is_ignore() {
                return true;
            }
        }

        false
    }
}

fn load_gitignore(workspace_root: &Path) -> Option<Gitignore> {
    let gitignore_path = workspace_root.join(".gitignore");
    if !gitignore_path.exists() {
        return None;
    }

    let mut builder = GitignoreBuilder::new(workspace_root);
    if builder.add(&gitignore_path).is_some() {
        return None;
    }

    builder.build().ok()
}

/// Start the file watcher in a background task.
/// Returns a receiver for file events.
#[allow(clippy::unnecessary_wraps)]
pub fn start_watcher(
    config: WatcherConfig,
) -> Result<mpsc::Receiver<PathBuf>, notify::Error> {
    let (tx, rx) = mpsc::channel(1000);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            if let Err(e) = run_watcher(config, tx).await {
                eprintln!("[affected] ERROR: watcher error: {e}");
            }
        });
    });

    // Give watcher time to start
    std::thread::sleep(Duration::from_millis(50));

    Ok(rx)
}

async fn run_watcher(
    config: WatcherConfig,
    tx: mpsc::Sender<PathBuf>,
) -> Result<(), notify::Error> {
    let (notify_tx, mut notify_rx) = mpsc::channel(1000);

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                for path in event.paths {
                    let _ = notify_tx.blocking_send(path);
                }
            }
        },
        Config::default().with_poll_interval(Duration::from_millis(DEBOUNCE_MS)),
    )?;

    watcher.watch(&config.workspace_root, RecursiveMode::Recursive)?;

    // Keep watcher alive and forward events
    while let Some(path) = notify_rx.recv().await {
        // Canonicalize to resolve symlinks
        let canonical = match path.canonicalize() {
            Ok(p) => p,
            Err(_) => path,
        };

        // Check if should be ignored
        if config.should_ignore(&canonical) {
            continue;
        }

        let _ = tx.send(canonical).await;
    }

    Ok(())
}

/// Check if a path is a config file that should trigger full run.
pub fn is_config_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };

    matches!(
        name,
        "package.json"
            | "package-lock.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "bun.lockb"
            | "bun.lock"
            | "tsconfig.json"
    ) || name.starts_with("vitest.config.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn dirty_tracker_add_and_drain() {
        let dir = tempdir().unwrap();
        let tracker = DirtyTracker::new(dir.path().to_path_buf());

        tracker.add_dirty(PathBuf::from("/src/a.ts"));
        tracker.add_dirty(PathBuf::from("/src/b.ts"));

        let (files, overflow, config_changed) = tracker.drain();
        assert_eq!(files.len(), 2);
        assert!(!overflow);
        assert!(!config_changed);

        // After drain, set should be empty
        let (files2, _, _) = tracker.drain();
        assert!(files2.is_empty());
    }

    #[test]
    fn dirty_tracker_overflow() {
        let dir = tempdir().unwrap();
        let tracker = DirtyTracker::new(dir.path().to_path_buf());

        for i in 0..MAX_DIRTY_FILES {
            let overflow = tracker.add_dirty(PathBuf::from(format!("/src/file{i}.ts")));
            assert!(!overflow);
        }

        // One more should trigger overflow
        let overflow = tracker.add_dirty(PathBuf::from("/src/extra.ts"));
        assert!(overflow);

        let (_, was_overflow, _) = tracker.drain();
        assert!(was_overflow);
    }

    #[test]
    fn dirty_tracker_config_changed() {
        let dir = tempdir().unwrap();
        let tracker = DirtyTracker::new(dir.path().to_path_buf());

        tracker.set_config_changed();

        let (_, _, config_changed) = tracker.drain();
        assert!(config_changed);

        // After drain, config_changed should be cleared
        let (_, _, config_changed2) = tracker.drain();
        assert!(!config_changed2);
    }

    #[test]
    fn config_hash_detects_change() {
        let dir = tempdir().unwrap();
        let tracker = DirtyTracker::new(dir.path().to_path_buf());
        let config = dir.path().join("package.json");

        fs::write(&config, r#"{"name": "test"}"#).unwrap();

        // First check - stores hash, no change
        assert!(!tracker.check_config_change(&config));

        // Same content - no change
        assert!(!tracker.check_config_change(&config));

        // Different content - change detected
        fs::write(&config, r#"{"name": "test2"}"#).unwrap();
        assert!(tracker.check_config_change(&config));

        // Same content again - no change
        assert!(!tracker.check_config_change(&config));
    }

    #[test]
    fn watcher_config_ignores_node_modules() {
        let dir = tempdir().unwrap();
        let config = WatcherConfig::new(dir.path().to_path_buf());

        let nm_path = dir.path().join("node_modules/foo/index.js");
        assert!(config.should_ignore(&nm_path));

        let src_path = dir.path().join("src/index.ts");
        assert!(!config.should_ignore(&src_path));
    }

    #[test]
    fn watcher_config_respects_gitignore() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "*.log\n").unwrap();

        let config = WatcherConfig::new(dir.path().to_path_buf());

        assert!(config.should_ignore(&dir.path().join("debug.log")));
        assert!(config.should_ignore(&dir.path().join("src/app.log")));
        assert!(!config.should_ignore(&dir.path().join("src/main.ts")));
    }

    #[test]
    fn is_config_file_matches() {
        assert!(is_config_file(Path::new("package.json")));
        assert!(is_config_file(Path::new("package-lock.json")));
        assert!(is_config_file(Path::new("yarn.lock")));
        assert!(is_config_file(Path::new("pnpm-lock.yaml")));
        assert!(is_config_file(Path::new("bun.lockb")));
        assert!(is_config_file(Path::new("bun.lock")));
        assert!(is_config_file(Path::new("tsconfig.json")));
        assert!(is_config_file(Path::new("vitest.config.ts")));
        assert!(is_config_file(Path::new("vitest.config.js")));
        assert!(is_config_file(Path::new("vitest.config.mts")));

        assert!(!is_config_file(Path::new("main.ts")));
        assert!(!is_config_file(Path::new("index.js")));
    }
}

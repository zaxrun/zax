//! Import path resolver using `oxc_resolver`.
//!
//! Resolves import specifiers to absolute paths, handling tsconfig paths,
//! package.json exports, and various module resolution strategies.
#![allow(clippy::print_stderr)]

use oxc_resolver::{ResolveOptions, Resolver, TsconfigDiscovery, TsconfigOptions, TsconfigReferences};
use std::path::{Path, PathBuf};

/// Maximum path length for logging.
const MAX_PATH_LOG_LENGTH: usize = 256;

/// Path resolver for TypeScript/JavaScript imports.
pub struct PathResolver {
    resolver: Resolver,
    workspace_root: PathBuf,
}

impl PathResolver {
    /// Create a new resolver for the given workspace root.
    pub fn new(workspace_root: PathBuf) -> Self {
        let tsconfig_path = workspace_root.join("tsconfig.json");
        Self::with_tsconfig(workspace_root, tsconfig_path)
    }

    /// Create a resolver with a custom tsconfig path.
    pub fn with_tsconfig(workspace_root: PathBuf, tsconfig_path: PathBuf) -> Self {
        let options = build_resolve_options(tsconfig_path);
        Self {
            resolver: Resolver::new(options),
            workspace_root,
        }
    }

    /// Resolve an import specifier to an absolute path.
    ///
    /// Returns None if:
    /// - Resolution fails (logged as warning)
    /// - Resolved path is outside workspace (logged as warning)
    pub fn resolve(&self, from: &Path, specifier: &str) -> Option<PathBuf> {
        let from_dir = from.parent()?;

        let Ok(resolution) = self.resolver.resolve(from_dir, specifier) else {
            log_warn_unresolvable(from, specifier);
            return None;
        };
        let resolved = resolution.into_path_buf();

        // Canonicalize and check workspace boundary
        let Ok(canonical) = resolved.canonicalize() else {
            log_warn_unresolvable(from, specifier);
            return None;
        };

        let Ok(workspace_canonical) = self.workspace_root.canonicalize() else {
            return None;
        };

        if !canonical.starts_with(&workspace_canonical) {
            log_warn_outside_workspace(from, specifier, &canonical);
            return None;
        }

        Some(canonical)
    }
}

fn build_resolve_options(tsconfig_path: PathBuf) -> ResolveOptions {
    ResolveOptions {
        extensions: vec![
            ".ts".into(),
            ".tsx".into(),
            ".js".into(),
            ".jsx".into(),
            ".mts".into(),
            ".mjs".into(),
            ".cts".into(),
            ".cjs".into(),
        ],
        main_files: vec!["index".into()],
        condition_names: vec![
            "import".into(),
            "require".into(),
            "node".into(),
            "default".into(),
        ],
        tsconfig: Some(TsconfigDiscovery::Manual(TsconfigOptions {
            config_file: tsconfig_path,
            references: TsconfigReferences::Disabled,
        })),
        ..Default::default()
    }
}

fn truncate_path(path: &Path) -> String {
    let s = path.display().to_string();
    if s.len() > MAX_PATH_LOG_LENGTH {
        format!("...{}", &s[s.len() - MAX_PATH_LOG_LENGTH + 3..])
    } else {
        s
    }
}

fn truncate_str(s: &str) -> &str {
    if s.len() > MAX_PATH_LOG_LENGTH {
        &s[..MAX_PATH_LOG_LENGTH]
    } else {
        s
    }
}

fn log_warn_unresolvable(from: &Path, specifier: &str) {
    eprintln!(
        "[affected] WARN: cannot resolve '{}' from {}",
        truncate_str(specifier),
        truncate_path(from)
    );
}

fn log_warn_outside_workspace(from: &Path, specifier: &str, resolved: &Path) {
    eprintln!(
        "[affected] WARN: '{}' from {} resolves outside workspace to {}",
        truncate_str(specifier),
        truncate_path(from),
        truncate_path(resolved)
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn setup_workspace_no_tsconfig() -> (tempfile::TempDir, PathResolver) {
        let dir = tempdir().unwrap();
        // Create resolver without tsconfig (uses production-like options)
        let options = ResolveOptions {
            extensions: vec![
                ".ts".into(),
                ".tsx".into(),
                ".js".into(),
                ".jsx".into(),
            ],
            main_files: vec!["index".into()],
            condition_names: vec![
                "import".into(),
                "require".into(),
                "node".into(),
                "default".into(),
            ],
            ..Default::default()
        };
        let resolver = PathResolver {
            resolver: Resolver::new(options),
            workspace_root: dir.path().to_path_buf(),
        };
        (dir, resolver)
    }

    #[test]
    fn resolves_relative_import() {
        let (dir, resolver) = setup_workspace_no_tsconfig();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("foo.ts"), "export const x = 1;").unwrap();

        let result = resolver.resolve(&src.join("bar.ts"), "./foo");
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("foo.ts"));
    }

    #[test]
    fn resolves_with_extension() {
        let (dir, resolver) = setup_workspace_no_tsconfig();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("foo.tsx"), "export const x = 1;").unwrap();

        let result = resolver.resolve(&src.join("bar.ts"), "./foo");
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("foo.tsx"));
    }

    #[test]
    fn resolves_index_file() {
        let (dir, resolver) = setup_workspace_no_tsconfig();
        let src = dir.path().join("src");
        let lib = src.join("lib");
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join("index.ts"), "export const x = 1;").unwrap();

        let result = resolver.resolve(&src.join("main.ts"), "./lib");
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("index.ts"));
    }

    #[test]
    fn returns_none_for_unresolvable() {
        let (dir, resolver) = setup_workspace_no_tsconfig();
        fs::write(dir.path().join("main.ts"), "").unwrap();

        let result = resolver.resolve(&dir.path().join("main.ts"), "./nonexistent");
        assert!(result.is_none());
    }

    #[test]
    fn rejects_path_outside_workspace() {
        let (dir, resolver) = setup_workspace_no_tsconfig();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("main.ts"), "").unwrap();

        // Absolute paths outside workspace should be rejected
        let result = resolver.resolve(&src.join("main.ts"), "/etc/passwd");
        assert!(result.is_none());
    }

    #[test]
    fn truncate_path_short() {
        let path = PathBuf::from("/short.ts");
        assert_eq!(truncate_path(&path), "/short.ts");
    }

    #[test]
    fn truncate_path_long() {
        let long = "a".repeat(300);
        let path = PathBuf::from(&long);
        let result = truncate_path(&path);
        assert!(result.starts_with("..."));
        assert!(result.len() <= MAX_PATH_LOG_LENGTH);
    }
}

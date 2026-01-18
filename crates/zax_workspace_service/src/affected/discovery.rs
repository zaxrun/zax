//! Test file discovery.
//!
//! Maps source files to their corresponding test files by convention.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Test file patterns.
const TEST_EXTENSIONS: &[&str] = &[".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

/// Discover test files for affected source files.
///
/// For each affected file:
/// - If it's already a test file, include it directly
/// - Otherwise, try to find matching test files by convention
pub fn discover_tests(
    affected: &HashSet<PathBuf>,
    workspace_root: &Path,
) -> Vec<PathBuf> {
    let mut tests = HashSet::new();

    for path in affected {
        if is_test_file(path) {
            tests.insert(path.clone());
        } else if let Some(test_files) = find_test_files(path, workspace_root) {
            for test in test_files {
                tests.insert(test);
            }
        }
    }

    tests.into_iter().collect()
}

/// Check if a path is a test file.
pub fn is_test_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };

    // Check common test patterns
    for ext in TEST_EXTENSIONS {
        if name.ends_with(ext) {
            return true;
        }
    }

    // Check .js variants
    if name.ends_with(".test.js")
        || name.ends_with(".test.jsx")
        || name.ends_with(".spec.js")
        || name.ends_with(".spec.jsx")
        || name.ends_with(".test.mts")
        || name.ends_with(".test.mjs")
        || name.ends_with(".spec.mts")
        || name.ends_with(".spec.mjs")
    {
        return true;
    }

    // Check __tests__ directory
    if path
        .components()
        .any(|c| c.as_os_str() == "__tests__")
    {
        return true;
    }

    false
}

/// Find test files for a source file by convention.
fn find_test_files(source: &Path, workspace_root: &Path) -> Option<Vec<PathBuf>> {
    let stem = source.file_stem()?.to_str()?;
    let parent = source.parent()?;
    let mut candidates = Vec::new();

    // Co-located test files: src/foo.ts -> src/foo.test.ts
    find_colocated_tests(parent, stem, &mut candidates);
    // __tests__ directory: src/foo.ts -> src/__tests__/foo.test.ts
    find_tests_dir_tests(parent, stem, &mut candidates);
    // test/ sibling directory: src/lib/foo.ts -> test/lib/foo.test.ts
    find_sibling_test_dir(source, workspace_root, stem, &mut candidates);

    if candidates.is_empty() {
        None
    } else {
        Some(candidates)
    }
}

fn find_colocated_tests(parent: &Path, stem: &str, candidates: &mut Vec<PathBuf>) {
    for ext in TEST_EXTENSIONS {
        let test_path = parent.join(format!("{stem}{ext}"));
        if test_path.exists() {
            candidates.push(test_path);
        }
    }
}

fn find_tests_dir_tests(parent: &Path, stem: &str, candidates: &mut Vec<PathBuf>) {
    let tests_dir = parent.join("__tests__");
    if tests_dir.exists() {
        for ext in TEST_EXTENSIONS {
            let test_path = tests_dir.join(format!("{stem}{ext}"));
            if test_path.exists() {
                candidates.push(test_path);
            }
        }
    }
}

fn find_sibling_test_dir(source: &Path, workspace_root: &Path, stem: &str, out: &mut Vec<PathBuf>) {
    let Some(relative) = source.strip_prefix(workspace_root).ok() else { return };
    let Some(rel_parent) = relative.parent() else { return };
    let components: Vec<_> = rel_parent.components().collect();
    if components.is_empty() {
        return;
    }
    // Remove "src" prefix if present
    let test_rel = if components[0].as_os_str() == "src" {
        rel_parent.strip_prefix("src").unwrap_or(rel_parent)
    } else {
        rel_parent
    };
    let test_dir = workspace_root.join("test").join(test_rel);
    if !test_dir.exists() && !test_dir.parent().is_some_and(Path::exists) {
        return;
    }
    for ext in TEST_EXTENSIONS {
        let test_path = test_dir.join(format!("{stem}{ext}"));
        if test_path.exists() {
            out.push(test_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn is_test_file_detects_patterns() {
        assert!(is_test_file(Path::new("foo.test.ts")));
        assert!(is_test_file(Path::new("foo.test.tsx")));
        assert!(is_test_file(Path::new("foo.spec.ts")));
        assert!(is_test_file(Path::new("foo.spec.tsx")));
        assert!(is_test_file(Path::new("foo.test.js")));
        assert!(is_test_file(Path::new("foo.spec.js")));
        assert!(is_test_file(Path::new("foo.test.mts")));
        assert!(is_test_file(Path::new("foo.spec.mjs")));
        assert!(is_test_file(Path::new("__tests__/foo.ts")));

        assert!(!is_test_file(Path::new("foo.ts")));
        assert!(!is_test_file(Path::new("foo.tsx")));
    }

    #[test]
    fn discover_includes_test_files_directly() {
        let dir = tempdir().unwrap();
        let test_file = dir.path().join("src/foo.test.ts");
        fs::create_dir_all(test_file.parent().unwrap()).unwrap();
        fs::write(&test_file, "").unwrap();

        let mut affected = HashSet::new();
        affected.insert(test_file.clone());

        let tests = discover_tests(&affected, dir.path());
        assert_eq!(tests.len(), 1);
        assert!(tests.contains(&test_file));
    }

    #[test]
    fn discover_finds_colocated_test() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();

        let source = src.join("foo.ts");
        let test = src.join("foo.test.ts");
        fs::write(&source, "").unwrap();
        fs::write(&test, "").unwrap();

        let mut affected = HashSet::new();
        affected.insert(source);

        let tests = discover_tests(&affected, dir.path());
        assert_eq!(tests.len(), 1);
        assert!(tests.contains(&test));
    }

    #[test]
    fn discover_finds_tests_in_tests_dir() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        let tests_dir = src.join("__tests__");
        fs::create_dir_all(&tests_dir).unwrap();

        let source = src.join("foo.ts");
        let test = tests_dir.join("foo.test.ts");
        fs::write(&source, "").unwrap();
        fs::write(&test, "").unwrap();

        let mut affected = HashSet::new();
        affected.insert(source);

        let tests = discover_tests(&affected, dir.path());
        assert_eq!(tests.len(), 1);
        assert!(tests.contains(&test));
    }

    #[test]
    fn discover_finds_spec_files() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();

        let source = src.join("bar.ts");
        let test = src.join("bar.spec.ts");
        fs::write(&source, "").unwrap();
        fs::write(&test, "").unwrap();

        let mut affected = HashSet::new();
        affected.insert(source);

        let tests = discover_tests(&affected, dir.path());
        assert_eq!(tests.len(), 1);
        assert!(tests.contains(&test));
    }

    #[test]
    fn discover_no_test_returns_empty() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();

        let source = src.join("foo.ts");
        fs::write(&source, "").unwrap();

        let mut affected = HashSet::new();
        affected.insert(source);

        let tests = discover_tests(&affected, dir.path());
        assert!(tests.is_empty());
    }
}

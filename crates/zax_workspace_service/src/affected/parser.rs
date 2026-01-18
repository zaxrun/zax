//! TypeScript/JavaScript import parser using tree-sitter.
//!
//! Extracts static import statements from TS/JS files for dependency graph construction.
#![allow(clippy::print_stderr)]

use std::path::Path;
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

/// Maximum number of imports to extract per file.
const MAX_IMPORTS_PER_FILE: usize = 500;
/// Maximum path length for logging.
const MAX_PATH_LOG_LENGTH: usize = 256;

/// Kind of import statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
    /// `import { x } from './path'`
    Named,
    /// `import x from './path'`
    Default,
    /// `import * as x from './path'`
    Namespace,
    /// `export { x } from './path'`
    ReExportNamed,
    /// `export * from './path'`
    ReExportAll,
    /// `require('./path')`
    Require,
    /// `import type { x } from './path'`
    TypeOnly,
}

/// A parsed import statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportStatement {
    /// The import specifier (e.g., "./foo", "@/lib/bar", "lodash").
    pub specifier: String,
    /// The kind of import.
    pub kind: ImportKind,
}

/// Parse imports from a TypeScript/JavaScript file.
///
/// Returns empty Vec on parse errors (logged as warnings).
/// Truncates to first 500 imports if exceeded (logged as warning).
pub fn parse_imports(path: &Path) -> Vec<ImportStatement> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            log_warn_parse_error(path, &format!("read error: {e}"));
            return Vec::new();
        }
    };
    parse_imports_from_str(&content, path)
}

/// Parse imports from source string (for testing).
pub fn parse_imports_from_str(content: &str, path: &Path) -> Vec<ImportStatement> {
    let mut parser = Parser::new();
    let language = get_language_for_path(path);
    if parser.set_language(&language).is_err() {
        log_warn_parse_error(path, "failed to set language");
        return Vec::new();
    }

    let Some(tree) = parser.parse(content, None) else {
        log_warn_parse_error(path, "parse returned None");
        return Vec::new();
    };

    let root = tree.root_node();
    if root.has_error() {
        log_warn_parse_error(path, "syntax errors in file");
        return Vec::new();
    }

    let mut imports = extract_imports(content, &root);

    if imports.len() > MAX_IMPORTS_PER_FILE {
        log_warn_import_limit(path, imports.len());
        imports.truncate(MAX_IMPORTS_PER_FILE);
    }

    imports
}

fn get_language_for_path(path: &Path) -> tree_sitter::Language {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    match ext {
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        _ => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    }
}

fn extract_imports(content: &str, root: &tree_sitter::Node) -> Vec<ImportStatement> {
    let mut imports = Vec::new();

    // Query for import and export statements
    let query_str = r#"
        (import_statement source: (string) @source)
        (export_statement source: (string) @source)
        (call_expression
            function: (identifier) @func (#eq? @func "require")
            arguments: (arguments (string) @source))
    "#;

    let Ok(query) = Query::new(&get_language_for_path(Path::new("x.ts")), query_str) else {
        return imports;
    };

    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, *root, content.as_bytes());

    while let Some(m) = matches.next() {
        for capture in m.captures {
            let node = capture.node;
            if capture.index == query.capture_index_for_name("source").unwrap_or(999) {
                if let Some(import) = extract_import_from_node(content, &node, root) {
                    imports.push(import);
                }
            }
        }
    }

    imports
}

fn extract_import_from_node(
    content: &str,
    source_node: &tree_sitter::Node,
    root: &tree_sitter::Node,
) -> Option<ImportStatement> {
    let specifier = get_string_content(content, source_node)?;
    if specifier.is_empty() {
        return None;
    }

    let parent = source_node.parent()?;
    let kind = determine_import_kind(content, &parent, root);

    Some(ImportStatement { specifier, kind })
}

fn get_string_content(content: &str, node: &tree_sitter::Node) -> Option<String> {
    let text = node.utf8_text(content.as_bytes()).ok()?;
    // Remove quotes from string literal
    let trimmed = text.trim_matches(|c| c == '"' || c == '\'' || c == '`');
    Some(trimmed.to_string())
}

fn determine_import_kind(
    content: &str,
    parent: &tree_sitter::Node,
    _root: &tree_sitter::Node,
) -> ImportKind {
    match parent.kind() {
        "import_statement" => classify_import_statement(content, parent),
        "export_statement" => classify_export_statement(content, parent),
        "arguments" => ImportKind::Require,
        _ => ImportKind::Named,
    }
}

fn classify_import_statement(content: &str, node: &tree_sitter::Node) -> ImportKind {
    let text = node.utf8_text(content.as_bytes()).unwrap_or("");

    if text.contains("import type") {
        return ImportKind::TypeOnly;
    }

    // Check for namespace import: import * as x from
    if text.contains("* as") {
        return ImportKind::Namespace;
    }

    // Check for named imports: import { x } from
    if text.contains('{') {
        return ImportKind::Named;
    }

    // Default import: import x from
    ImportKind::Default
}

fn classify_export_statement(content: &str, node: &tree_sitter::Node) -> ImportKind {
    let text = node.utf8_text(content.as_bytes()).unwrap_or("");

    // export * from './path'
    if text.contains("export *") && !text.contains("as") {
        return ImportKind::ReExportAll;
    }

    // export { x } from './path'
    ImportKind::ReExportNamed
}

fn log_warn_parse_error(path: &Path, reason: &str) {
    let display = truncate_path(path);
    eprintln!("[affected] WARN: parse error in {display}: {reason}");
}

fn log_warn_import_limit(path: &Path, count: usize) {
    let display = truncate_path(path);
    eprintln!(
        "[affected] WARN: {display} has {count} imports, truncating to {MAX_IMPORTS_PER_FILE}"
    );
}

fn truncate_path(path: &Path) -> String {
    let s = path.display().to_string();
    if s.len() > MAX_PATH_LOG_LENGTH {
        format!("...{}", &s[s.len() - MAX_PATH_LOG_LENGTH + 3..])
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn parse(content: &str) -> Vec<ImportStatement> {
        parse_imports_from_str(content, Path::new("test.ts"))
    }

    #[test]
    fn extracts_named_import() {
        let imports = parse("import { foo } from './bar';");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./bar");
        assert_eq!(imports[0].kind, ImportKind::Named);
    }

    #[test]
    fn extracts_default_import() {
        let imports = parse("import foo from './bar';");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./bar");
        assert_eq!(imports[0].kind, ImportKind::Default);
    }

    #[test]
    fn extracts_namespace_import() {
        let imports = parse("import * as foo from './bar';");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./bar");
        assert_eq!(imports[0].kind, ImportKind::Namespace);
    }

    #[test]
    fn extracts_reexport_named() {
        let imports = parse("export { foo } from './bar';");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./bar");
        assert_eq!(imports[0].kind, ImportKind::ReExportNamed);
    }

    #[test]
    fn extracts_reexport_all() {
        let imports = parse("export * from './bar';");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./bar");
        assert_eq!(imports[0].kind, ImportKind::ReExportAll);
    }

    #[test]
    fn extracts_require() {
        let imports = parse("const foo = require('./bar');");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./bar");
        assert_eq!(imports[0].kind, ImportKind::Require);
    }

    #[test]
    fn extracts_type_only_import() {
        let imports = parse("import type { Foo } from './bar';");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./bar");
        assert_eq!(imports[0].kind, ImportKind::TypeOnly);
    }

    #[test]
    fn extracts_multiple_imports() {
        let content = r#"
            import { a } from './a';
            import b from './b';
            import * as c from './c';
            export { d } from './d';
            export * from './e';
            const f = require('./f');
            import type { G } from './g';
        "#;
        let imports = parse(content);
        assert_eq!(imports.len(), 7);
    }

    #[test]
    fn handles_syntax_errors_gracefully() {
        let imports = parse("import { from './bar'"); // missing closing brace
        assert!(imports.is_empty());
    }

    #[test]
    fn truncates_at_500_imports() {
        let mut content = String::new();
        for i in 0..501 {
            content.push_str(&format!("import {{ x{i} }} from './m{i}';\n"));
        }
        let imports = parse(&content);
        assert_eq!(imports.len(), MAX_IMPORTS_PER_FILE);
    }

    #[test]
    fn truncate_path_short_unchanged() {
        let path = PathBuf::from("/short/path.ts");
        assert_eq!(truncate_path(&path), "/short/path.ts");
    }

    #[test]
    fn truncate_path_long_truncated() {
        let long_path = "a".repeat(300);
        let path = PathBuf::from(&long_path);
        let result = truncate_path(&path);
        assert!(result.starts_with("..."));
        assert!(result.len() <= MAX_PATH_LOG_LENGTH);
    }
}

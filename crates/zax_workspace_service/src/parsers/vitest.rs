//! Vitest JSON output parser.
//!
//! Parses Vitest JSON reporter output and extracts test failures.

use super::ParseError;
use serde::Deserialize;

/// Maximum message length before truncation.
const MAX_MESSAGE_LENGTH: usize = 1000;

/// A parsed test failure from Vitest output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestFailure {
    pub test_id: String,
    pub file: String,
    pub message: String,
}

/// Vitest JSON output root structure.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VitestOutput {
    #[serde(default)]
    test_results: Vec<TestResult>,
}

/// A single test file result.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    /// Absolute path to test file
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    assertion_results: Vec<AssertionResult>,
}

/// A single assertion result within a test file.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssertionResult {
    #[serde(default)]
    ancestor_titles: Vec<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    failure_messages: Vec<String>,
}

/// Parses Vitest JSON output and extracts all test failures.
///
/// # Arguments
/// * `json_content` - Raw JSON content from Vitest reporter output
/// * `workspace_root` - Workspace root path for normalizing file paths
///
/// # Returns
/// List of test failures, or a `ParseError` if JSON is malformed
pub fn parse(json_content: &str, workspace_root: &str) -> Result<Vec<TestFailure>, ParseError> {
    let output: VitestOutput = serde_json::from_str(json_content)?;
    let mut failures = Vec::new();

    for test_result in output.test_results {
        let file = normalize_path(&test_result.name, workspace_root);
        process_test_result(&test_result, &file, &mut failures);
    }

    Ok(failures)
}

fn process_test_result(test_result: &TestResult, file: &str, failures: &mut Vec<TestFailure>) {
    // Handle file-level errors (status: failed, empty assertionResults, non-null message)
    if test_result.status == "failed"
        && test_result.assertion_results.is_empty()
        && test_result.message.is_some()
    {
        let message = truncate_message(test_result.message.as_deref().unwrap_or(""));
        failures.push(TestFailure {
            test_id: format!("{file}::file-error"),
            file: file.to_string(),
            message,
        });
        return;
    }

    // Process individual assertion failures
    for assertion in &test_result.assertion_results {
        if assertion.status == "failed" {
            let test_id = build_test_id(&assertion.ancestor_titles, &assertion.title);
            let message = extract_message(&assertion.failure_messages);
            failures.push(TestFailure {
                test_id,
                file: file.to_string(),
                message,
            });
        }
    }
}

fn normalize_path(absolute_path: &str, workspace_root: &str) -> String {
    // Strip workspace prefix if present
    if let Some(stripped) = absolute_path.strip_prefix(workspace_root) {
        stripped.strip_prefix('/').unwrap_or(stripped).to_string()
    } else {
        absolute_path.to_string()
    }
}

fn build_test_id(ancestor_titles: &[String], title: &str) -> String {
    if ancestor_titles.is_empty() {
        title.to_string()
    } else {
        format!("{} > {}", ancestor_titles.join(" > "), title)
    }
}

fn extract_message(failure_messages: &[String]) -> String {
    let raw = failure_messages.first().map(String::as_str).unwrap_or("");
    truncate_message(raw)
}

fn truncate_message(message: &str) -> String {
    if message.chars().count() > MAX_MESSAGE_LENGTH {
        format!(
            "{}...",
            message
                .chars()
                .take(MAX_MESSAGE_LENGTH - 3)
                .collect::<String>()
        )
    } else {
        message.to_string()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn make_json(name: &str, status: &str, msg: Option<&str>, assertions: &str) -> String {
        let msg_field = msg
            .map(|m| format!(r#""message": "{m}","#))
            .unwrap_or_default();
        format!(
            r#"{{"testResults":[{{"name":"{name}","status":"{status}",{msg_field}"assertionResults":[{assertions}]}}]}}"#
        )
    }

    fn assertion(ancestors: &[&str], title: &str, status: &str, msg: &str) -> String {
        let anc = ancestors
            .iter()
            .map(|a| format!(r#""{a}""#))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"ancestorTitles":[{anc}],"title":"{title}","status":"{status}","failureMessages":["{msg}"]}}"#
        )
    }

    #[test]
    fn parse_extracts_valid_failure() {
        let json = make_json(
            "/ws/src/t.ts",
            "failed",
            None,
            &assertion(&["A", "B"], "test", "failed", "err"),
        );
        let f = parse(&json, "/ws").unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].test_id, "A > B > test");
        assert_eq!(f[0].file, "src/t.ts");
    }

    #[test]
    fn parse_returns_empty_for_no_results() {
        assert!(parse(r#"{"testResults":[]}"#, "/ws").unwrap().is_empty());
    }

    #[test]
    fn parse_returns_error_for_malformed_json() {
        assert!(matches!(
            parse("bad", "/ws"),
            Err(ParseError::InvalidJson(_))
        ));
    }

    #[test]
    fn parse_ignores_passing_tests() {
        let pass = make_json(
            "/ws/t.ts",
            "passed",
            None,
            &assertion(&[], "ok", "passed", ""),
        );
        assert!(parse(&pass, "/ws").unwrap().is_empty());
    }

    #[test]
    fn parse_truncates_long_messages() {
        let long = "x".repeat(1500);
        let json = make_json(
            "/ws/t.ts",
            "failed",
            None,
            &assertion(&[], "t", "failed", &long),
        );
        let result = parse(&json, "/ws").unwrap();
        assert_eq!(result[0].message.len(), MAX_MESSAGE_LENGTH);
        assert!(result[0].message.ends_with("..."));
    }

    #[test]
    fn parse_preserves_short_messages() {
        let short = "short error";
        let json = make_json(
            "/ws/t.ts",
            "failed",
            None,
            &assertion(&[], "t", "failed", short),
        );
        let result = parse(&json, "/ws").unwrap();
        assert_eq!(result[0].message, short);
        assert!(!result[0].message.ends_with("..."));
    }

    #[test]
    fn parse_handles_empty_failure_messages() {
        let empty = r#"{"testResults":[{"name":"/ws/t.ts","status":"failed","assertionResults":[{"ancestorTitles":[],"title":"t","status":"failed","failureMessages":[]}]}]}"#;
        assert_eq!(parse(empty, "/ws").unwrap()[0].message, "");
    }

    #[test]
    fn parse_handles_file_level_error() {
        let json = make_json("/ws/src/b.ts", "failed", Some("SyntaxError"), "");
        let f = parse(&json, "/ws").unwrap();
        assert_eq!(f[0].test_id, "src/b.ts::file-error");
    }

    #[test]
    fn parse_constructs_test_id_from_nested_ancestors() {
        let nested = make_json(
            "/ws/t.ts",
            "failed",
            None,
            &assertion(&["A", "B", "C"], "d", "failed", "e"),
        );
        assert_eq!(parse(&nested, "/ws").unwrap()[0].test_id, "A > B > C > d");
    }
}

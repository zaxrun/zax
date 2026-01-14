//! `ESLint` JSON output parser.
//!
//! Parses `ESLint` JSON reporter output and extracts findings (errors only).

use super::ParseError;
use serde::Deserialize;

/// Maximum rule name length before truncation.
const MAX_RULE_LENGTH: usize = 256;
/// Maximum file path length before truncation.
const MAX_FILE_LENGTH: usize = 4096;
/// Maximum message length before truncation.
const MAX_MESSAGE_LENGTH: usize = 1000;

/// A parsed finding from `ESLint` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub stable_id: String,
    pub tool: String,
    pub rule: String,
    pub file: String,
    pub start_line: i32,
    pub start_column: i32,
    pub end_line: i32,
    pub end_column: i32,
    pub message: String,
}

/// `ESLint` JSON output is an array of file results.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EslintFileResult {
    file_path: Option<String>,
    #[serde(default)]
    messages: Vec<EslintMessage>,
}

/// A single lint message within a file result.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EslintMessage {
    rule_id: Option<String>,
    #[serde(default)]
    severity: i32,
    #[serde(default)]
    line: i32,
    #[serde(default)]
    column: i32,
    end_line: Option<i32>,
    end_column: Option<i32>,
    #[serde(default)]
    message: String,
}

/// Parses `ESLint` JSON output and extracts all error-level findings.
///
/// # Arguments
/// * `json_content` - Raw JSON content from `ESLint` reporter output
/// * `workspace_root` - Workspace root path for normalizing file paths
///
/// # Returns
/// List of findings (errors only, severity=2), or a `ParseError` if JSON is malformed
pub fn parse(json_content: &str, workspace_root: &str) -> Result<Vec<Finding>, ParseError> {
    let results: Vec<EslintFileResult> = serde_json::from_str(json_content)?;
    let mut findings = Vec::new();

    for result in results {
        let Some(file_path) = &result.file_path else {
            continue; // Skip entries with missing filePath
        };
        let file = normalize_path(file_path, workspace_root);
        for msg in &result.messages {
            if msg.severity != 2 {
                continue; // Only errors (severity=2), skip warnings
            }
            let finding = build_finding(&file, msg);
            findings.push(finding);
        }
    }

    Ok(findings)
}

fn normalize_path(absolute_path: &str, workspace_root: &str) -> String {
    let stripped = if let Some(s) = absolute_path.strip_prefix(workspace_root) {
        s.strip_prefix('/').unwrap_or(s)
    } else {
        absolute_path
    };
    truncate(stripped, MAX_FILE_LENGTH)
}

fn build_finding(file: &str, msg: &EslintMessage) -> Finding {
    let rule = truncate(msg.rule_id.as_deref().unwrap_or("unknown"), MAX_RULE_LENGTH);
    let message = truncate(&msg.message, MAX_MESSAGE_LENGTH);
    let line = normalize_line_col(msg.line);
    let column = normalize_line_col(msg.column);
    let end_line = msg.end_line.map(normalize_line_col).unwrap_or(line);
    let end_column = msg.end_column.map(normalize_line_col).unwrap_or(column);
    let stable_id = compute_stable_id(&rule, file, line, column);

    Finding {
        stable_id,
        tool: "eslint".to_string(),
        rule,
        file: file.to_string(),
        start_line: line,
        start_column: column,
        end_line,
        end_column,
        message,
    }
}

fn normalize_line_col(value: i32) -> i32 {
    if value < 1 { 1 } else { value }
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() > max_chars {
        format!("{}...", s.chars().take(max_chars - 3).collect::<String>())
    } else {
        s.to_string()
    }
}

/// Computes stable ID for a finding: BLAKE3 of `eslint:{rule}:{file}:{line}:{column}`.
fn compute_stable_id(rule: &str, file: &str, line: i32, column: i32) -> String {
    let input = format!("eslint:{rule}:{file}:{line}:{column}");
    let hash = blake3::hash(input.as_bytes());
    let hex = hash.to_hex();
    hex[..32].to_lowercase()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::too_many_arguments)]
mod tests {
    use super::*;

    fn make_eslint_json(file_path: Option<&str>, messages: &str) -> String {
        match file_path {
            Some(fp) => format!(r#"[{{"filePath":"{fp}","messages":[{messages}]}}]"#),
            None => format!(r#"[{{"messages":[{messages}]}}]"#),
        }
    }

    fn make_message(rule: Option<&str>, sev: i32, line: i32, col: i32, msg: &str) -> String {
        let rule_field = rule.map(|r| format!(r#""ruleId":"{r}","#)).unwrap_or_default();
        format!(r#"{{{rule_field}"severity":{sev},"line":{line},"column":{col},"message":"{msg}"}}"#)
    }

    #[test]
    fn parse_extracts_errors_only() {
        let err = make_message(Some("no-unused-vars"), 2, 10, 5, "x is unused");
        let warn = make_message(Some("no-console"), 1, 20, 1, "no console");
        let json = make_eslint_json(Some("/ws/src/a.js"), &format!("{err},{warn}"));
        let findings = parse(&json, "/ws").unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "no-unused-vars");
        assert_eq!(findings[0].file, "src/a.js");
        assert_eq!(findings[0].start_line, 10);
        assert_eq!(findings[0].start_column, 5);
        assert_eq!(findings[0].tool, "eslint");
    }

    #[test]
    fn parse_empty_array() {
        assert!(parse("[]", "/ws").unwrap().is_empty());
    }

    #[test]
    fn parse_missing_file_path_skipped() {
        let msg = make_message(Some("rule"), 2, 1, 1, "err");
        let json = make_eslint_json(None, &msg);
        assert!(parse(&json, "/ws").unwrap().is_empty());
    }

    #[test]
    fn parse_null_rule_id_defaults_to_unknown() {
        let json = r#"[{"filePath":"/ws/f.js","messages":[{"severity":2,"line":1,"column":1,"message":"err"}]}]"#;
        let findings = parse(json, "/ws").unwrap();
        assert_eq!(findings[0].rule, "unknown");
    }

    #[test]
    fn parse_invalid_line_column_defaults_to_1() {
        let msg = r#"{"ruleId":"r","severity":2,"line":-5,"column":0,"message":"err"}"#;
        let json = format!(r#"[{{"filePath":"/ws/f.js","messages":[{msg}]}}]"#);
        let findings = parse(&json, "/ws").unwrap();
        assert_eq!(findings[0].start_line, 1);
        assert_eq!(findings[0].start_column, 1);
    }

    #[test]
    fn parse_truncates_oversized_fields() {
        let long_rule = "x".repeat(300);
        let long_file = format!("/ws/{}", "y".repeat(4200));
        let long_msg = "z".repeat(1500);
        let msg = format!(
            r#"{{"ruleId":"{long_rule}","severity":2,"line":1,"column":1,"message":"{long_msg}"}}"#
        );
        let json = format!(r#"[{{"filePath":"{long_file}","messages":[{msg}]}}]"#);
        let findings = parse(&json, "/ws").unwrap();
        assert_eq!(findings[0].rule.len(), MAX_RULE_LENGTH);
        assert_eq!(findings[0].file.len(), MAX_FILE_LENGTH);
        assert_eq!(findings[0].message.len(), MAX_MESSAGE_LENGTH);
        // Verify truncated fields end with "..."
        assert!(findings[0].rule.ends_with("..."));
        assert!(findings[0].file.ends_with("..."));
        assert!(findings[0].message.ends_with("..."));
    }

    #[test]
    fn truncate_does_not_add_dots_when_not_needed() {
        let short_msg = "short message";
        let json = make_eslint_json(Some("/ws/f.js"), &make_message(Some("r"), 2, 1, 1, short_msg));
        let findings = parse(&json, "/ws").unwrap();
        assert_eq!(findings[0].message, short_msg);
        assert!(!findings[0].message.ends_with("..."));
    }

    #[test]
    fn truncate_handles_utf8_boundary_correctly() {
        // Multi-byte UTF-8 characters (emoji = 4 bytes each)
        // Using chars that exceed MAX_MESSAGE_LENGTH to verify we don't split mid-character
        let emoji_msg = "🔥".repeat(1500); // 1500 emoji > MAX_MESSAGE_LENGTH (1000)
        let json = make_eslint_json(Some("/ws/f.js"), &make_message(Some("r"), 2, 1, 1, &emoji_msg));
        let findings = parse(&json, "/ws").unwrap();
        // Result should be truncated to MAX_MESSAGE_LENGTH chars
        assert_eq!(findings[0].message.chars().count(), MAX_MESSAGE_LENGTH);
        assert!(findings[0].message.ends_with("..."));
        // Verify result is valid UTF-8 by iterating chars (would panic if invalid)
        let char_count = findings[0].message.chars().count();
        assert!(char_count > 0);
    }

    #[test]
    fn parse_malformed_json_returns_error() {
        assert!(matches!(parse("bad json", "/ws"), Err(ParseError::InvalidJson(_))));
    }

    #[test]
    fn stable_id_determinism() {
        let json = make_eslint_json(Some("/ws/f.js"), &make_message(Some("r"), 2, 1, 1, "m"));
        let f1 = parse(&json, "/ws").unwrap();
        let f2 = parse(&json, "/ws").unwrap();
        assert_eq!(f1[0].stable_id, f2[0].stable_id);
        assert_eq!(f1[0].stable_id.len(), 32);
    }

    #[test]
    fn stable_id_different_for_different_input() {
        let j1 = make_eslint_json(Some("/ws/f.js"), &make_message(Some("r"), 2, 1, 1, "m"));
        let j2 = make_eslint_json(Some("/ws/f.js"), &make_message(Some("r"), 2, 2, 1, "m"));
        let f1 = parse(&j1, "/ws").unwrap();
        let f2 = parse(&j2, "/ws").unwrap();
        assert_ne!(f1[0].stable_id, f2[0].stable_id);
    }

    #[test]
    fn end_line_column_defaults_to_start() {
        let msg = r#"{"ruleId":"r","severity":2,"line":10,"column":5,"message":"err"}"#;
        let json = format!(r#"[{{"filePath":"/ws/f.js","messages":[{msg}]}}]"#);
        let findings = parse(&json, "/ws").unwrap();
        assert_eq!(findings[0].end_line, 10);
        assert_eq!(findings[0].end_column, 5);
    }

    #[test]
    fn end_line_column_uses_provided_values() {
        let msg = r#"{"ruleId":"r","severity":2,"line":10,"column":5,"endLine":15,"endColumn":20,"message":"err"}"#;
        let json = format!(r#"[{{"filePath":"/ws/f.js","messages":[{msg}]}}]"#);
        let findings = parse(&json, "/ws").unwrap();
        assert_eq!(findings[0].end_line, 15);
        assert_eq!(findings[0].end_column, 20);
    }
}

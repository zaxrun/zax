//! Path normalization utilities for cross-platform consistency.
//!
//! Normalizes paths to forward slashes and validates package scope values.

use thiserror::Error;

/// Errors that can occur during path normalization.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PathError {
    #[error("path contains disallowed '..' component")]
    PathTraversal,
    #[error("path contains invalid characters")]
    InvalidChars,
    #[error("path exceeds maximum length of {0} characters")]
    TooLong(usize),
}

/// Maximum length for package scope paths (1024 characters).
const MAX_PACKAGE_SCOPE_LEN: usize = 1024;

/// Normalizes a path to use forward slashes only.
#[allow(dead_code)]
///
/// - Converts backslashes to forward slashes
/// - Collapses consecutive slashes
/// - Returns the normalized path as a String
pub fn normalize_slashes(path: &str) -> String {
    let mut result = String::with_capacity(path.len());
    let mut last_was_slash = false;

    for c in path.chars() {
        let is_slash = c == '/' || c == '\\';
        if is_slash {
            if !last_was_slash {
                result.push('/');
            }
            last_was_slash = true;
        } else {
            result.push(c);
            last_was_slash = false;
        }
    }
    result
}

/// Validates a package scope string for security and correctness.
///
/// A valid package scope:
/// - Contains only alphanumeric, hyphens, underscores, forward slashes, periods
/// - Has no `..` path components
/// - Is under 1024 characters
/// - Empty string is valid (means no scoping)
pub fn validate_package_scope(scope: &str) -> Result<(), PathError> {
    // Empty string is valid (no scoping)
    if scope.is_empty() {
        return Ok(());
    }

    // Check length
    if scope.len() > MAX_PACKAGE_SCOPE_LEN {
        return Err(PathError::TooLong(MAX_PACKAGE_SCOPE_LEN));
    }

    // Check for path traversal
    for component in scope.split('/') {
        if component == ".." {
            return Err(PathError::PathTraversal);
        }
    }

    // Check for invalid characters (allow alphanumeric, hyphen, underscore, slash, dot)
    for c in scope.chars() {
        if !c.is_ascii_alphanumeric()
            && c != '-'
            && c != '_'
            && c != '/'
            && c != '.'
            && c != '@'
        {
            return Err(PathError::InvalidChars);
        }
    }

    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn normalize_converts_backslashes() {
        assert_eq!(normalize_slashes("foo\\bar\\baz"), "foo/bar/baz");
    }

    #[test]
    fn normalize_collapses_consecutive_slashes() {
        assert_eq!(normalize_slashes("foo//bar///baz"), "foo/bar/baz");
    }

    #[test]
    fn normalize_handles_mixed_separators() {
        assert_eq!(normalize_slashes("foo\\\\bar//baz"), "foo/bar/baz");
    }

    #[test]
    fn normalize_preserves_single_slashes() {
        assert_eq!(normalize_slashes("foo/bar/baz"), "foo/bar/baz");
    }

    #[test]
    fn normalize_handles_empty_string() {
        assert_eq!(normalize_slashes(""), "");
    }

    #[test]
    fn validate_accepts_empty_string() {
        assert!(validate_package_scope("").is_ok());
    }

    #[test]
    fn validate_accepts_valid_scope() {
        assert!(validate_package_scope("packages/auth").is_ok());
        assert!(validate_package_scope("packages/auth-admin").is_ok());
        assert!(validate_package_scope("@scope/package").is_ok());
        assert!(validate_package_scope("packages/my_lib").is_ok());
        assert!(validate_package_scope("packages/v1.0.0").is_ok());
    }

    #[test]
    fn validate_rejects_path_traversal() {
        assert_eq!(
            validate_package_scope("packages/../secrets"),
            Err(PathError::PathTraversal)
        );
        assert_eq!(
            validate_package_scope(".."),
            Err(PathError::PathTraversal)
        );
        assert_eq!(
            validate_package_scope("../foo"),
            Err(PathError::PathTraversal)
        );
    }

    #[test]
    fn validate_rejects_invalid_chars() {
        assert_eq!(
            validate_package_scope("packages/foo bar"),
            Err(PathError::InvalidChars)
        );
        assert_eq!(
            validate_package_scope("packages/foo;bar"),
            Err(PathError::InvalidChars)
        );
        assert_eq!(
            validate_package_scope("packages/foo\nbar"),
            Err(PathError::InvalidChars)
        );
    }

    #[test]
    fn validate_rejects_too_long() {
        let long = "a".repeat(MAX_PACKAGE_SCOPE_LEN + 1);
        assert_eq!(
            validate_package_scope(&long),
            Err(PathError::TooLong(MAX_PACKAGE_SCOPE_LEN))
        );
    }

    #[test]
    fn validate_accepts_max_length() {
        let max = "a".repeat(MAX_PACKAGE_SCOPE_LEN);
        assert!(validate_package_scope(&max).is_ok());
    }
}

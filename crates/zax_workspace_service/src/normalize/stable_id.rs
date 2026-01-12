//! Stable ID computation using BLAKE3.
//!
//! Generates deterministic identifiers for test failures based on file path
//! and test ID. The same inputs always produce the same stable ID.

/// Computes a stable ID for a test failure.
///
/// The stable ID is computed as the BLAKE3 hash of `<file>:<test_id>`,
/// truncated to the first 32 hexadecimal characters (lowercase).
///
/// # Arguments
/// * `file` - Workspace-relative file path
/// * `test_id` - Canonical test identifier
///
/// # Returns
/// A 32-character lowercase hex string
pub fn compute(file: &str, test_id: &str) -> String {
    let input = format!("{file}:{test_id}");
    let hash = blake3::hash(input.as_bytes());
    let hex = hash.to_hex();
    hex[..32].to_lowercase()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn same_input_produces_same_stable_id() {
        let id1 = compute("src/math.test.ts", "Math > add > handles negatives");
        let id2 = compute("src/math.test.ts", "Math > add > handles negatives");
        assert_eq!(id1, id2);
    }

    #[test]
    fn different_input_produces_different_stable_id() {
        let id1 = compute("src/math.test.ts", "Math > add > handles negatives");
        let id2 = compute("src/math.test.ts", "Math > add > handles positives");
        assert_ne!(id1, id2);
    }

    #[test]
    fn output_is_exactly_32_lowercase_hex_chars() {
        let id = compute("src/test.ts", "some test");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(id, id.to_lowercase());
    }

    #[test]
    fn different_file_same_test_produces_different_id() {
        let id1 = compute("src/a.test.ts", "test");
        let id2 = compute("src/b.test.ts", "test");
        assert_ne!(id1, id2);
    }
}

//! Artifact parsers for extracting test failures and findings.

pub mod vitest;

use thiserror::Error;

/// Errors that can occur during artifact parsing.
#[derive(Debug, Error)]
pub enum ParseError {
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
}

impl From<serde_json::Error> for ParseError {
    fn from(e: serde_json::Error) -> Self {
        ParseError::InvalidJson(e.to_string())
    }
}

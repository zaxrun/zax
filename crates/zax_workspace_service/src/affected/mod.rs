//! Affected test selection module.
//!
//! Provides file watching, import parsing, dependency graph, and affected computation
//! to enable running only tests affected by changed files.

pub mod compute;
pub mod discovery;
pub mod graph;
pub mod parser;
pub mod resolver;
pub mod state;
pub mod watcher;

// Re-export key types used by main.rs
pub use graph::SharedDepGraph;
pub use parser::parse_imports;
pub use resolver::PathResolver;
pub use state::AffectedState;

//! Dependency graph using petgraph.
//!
//! Stores file dependencies as a directed graph where edge A→B means "A imports B".
#![allow(clippy::print_stderr)]

use petgraph::stable_graph::{NodeIndex, StableDiGraph};
use petgraph::visit::EdgeRef;
use petgraph::Direction;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Maximum number of nodes before triggering full run.
const MAX_GRAPH_NODES: usize = 10_000;

/// A node in the dependency graph.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum GraphNode {
    /// A module file.
    Module(PathBuf),
}

/// Dependency graph storing file import relationships.
pub struct DepGraph {
    graph: StableDiGraph<GraphNode, ()>,
    path_to_idx: HashMap<PathBuf, NodeIndex>,
    overflow: bool,
}

impl Default for DepGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl DepGraph {
    /// Create a new empty dependency graph.
    pub fn new() -> Self {
        Self {
            graph: StableDiGraph::new(),
            path_to_idx: HashMap::new(),
            overflow: false,
        }
    }

    /// Add a file to the graph. Returns the node index.
    /// If the graph exceeds `MAX_GRAPH_NODES`, sets overflow flag and returns None.
    pub fn add_file(&mut self, path: PathBuf) -> Option<NodeIndex> {
        if let Some(&idx) = self.path_to_idx.get(&path) {
            return Some(idx);
        }

        if self.graph.node_count() >= MAX_GRAPH_NODES {
            if !self.overflow {
                eprintln!(
                    "[affected] WARN: graph exceeded {} nodes, triggering full run",
                    MAX_GRAPH_NODES
                );
                self.overflow = true;
            }
            return None;
        }

        let idx = self.graph.add_node(GraphNode::Module(path.clone()));
        self.path_to_idx.insert(path, idx);
        Some(idx)
    }

    /// Update outgoing edges for a file atomically.
    /// Removes all existing outgoing edges and adds new ones.
    pub fn update_edges(&mut self, from: &Path, imports: &[PathBuf]) {
        let Some(&from_idx) = self.path_to_idx.get(from) else {
            return;
        };

        // Remove all existing outgoing edges
        let edges_to_remove: Vec<_> = self
            .graph
            .edges_directed(from_idx, Direction::Outgoing)
            .map(|e| e.id())
            .collect();

        for edge_id in edges_to_remove {
            self.graph.remove_edge(edge_id);
        }

        // Add new edges
        for import in imports {
            if let Some(&to_idx) = self.path_to_idx.get(import) {
                self.graph.add_edge(from_idx, to_idx, ());
            }
        }
    }

    /// Get all files that directly depend on (import) the given file.
    pub fn get_dependents(&self, path: &Path) -> Vec<PathBuf> {
        let Some(&idx) = self.path_to_idx.get(path) else {
            return Vec::new();
        };

        self.graph
            .edges_directed(idx, Direction::Incoming)
            .filter_map(|e| {
                let source = e.source();
                if let Some(GraphNode::Module(p)) = self.graph.node_weight(source) {
                    Some(p.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Remove a file and all its connected edges.
    pub fn remove_file(&mut self, path: &Path) {
        if let Some(idx) = self.path_to_idx.remove(path) {
            self.graph.remove_node(idx);
        }
    }

    /// Check if graph has overflowed.
    pub fn is_overflow(&self) -> bool {
        self.overflow
    }

    /// Get current node count.
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// Get current edge count.
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// Check if graph contains a file.
    pub fn contains(&self, path: &Path) -> bool {
        self.path_to_idx.contains_key(path)
    }

}

/// Thread-safe wrapper around `DepGraph`.
pub type SharedDepGraph = Arc<RwLock<DepGraph>>;

/// Create a new shared dependency graph.
pub fn new_shared_graph() -> SharedDepGraph {
    Arc::new(RwLock::new(DepGraph::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_file_creates_node() {
        let mut graph = DepGraph::new();
        let path = PathBuf::from("/src/foo.ts");
        let idx = graph.add_file(path.clone());
        assert!(idx.is_some());
        assert!(graph.contains(&path));
        assert_eq!(graph.node_count(), 1);
    }

    #[test]
    fn add_file_idempotent() {
        let mut graph = DepGraph::new();
        let path = PathBuf::from("/src/foo.ts");
        let idx1 = graph.add_file(path.clone());
        let idx2 = graph.add_file(path.clone());
        assert_eq!(idx1, idx2);
        assert_eq!(graph.node_count(), 1);
    }

    #[test]
    fn update_edges_creates_edges() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");
        let c = PathBuf::from("/src/c.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        graph.add_file(c.clone());

        // a imports b and c
        graph.update_edges(&a, &[b.clone(), c.clone()]);

        assert_eq!(graph.edge_count(), 2);
        assert_eq!(graph.get_dependents(&b), vec![a.clone()]);
        assert_eq!(graph.get_dependents(&c), vec![a.clone()]);
    }

    #[test]
    fn update_edges_removes_old_edges() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");
        let c = PathBuf::from("/src/c.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        graph.add_file(c.clone());

        // Initially a imports b
        graph.update_edges(&a, &[b.clone()]);
        assert_eq!(graph.edge_count(), 1);
        assert_eq!(graph.get_dependents(&b), vec![a.clone()]);

        // Now a imports only c
        graph.update_edges(&a, &[c.clone()]);
        assert_eq!(graph.edge_count(), 1);
        assert!(graph.get_dependents(&b).is_empty());
        assert_eq!(graph.get_dependents(&c), vec![a.clone()]);
    }

    #[test]
    fn remove_file_removes_node_and_edges() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        graph.update_edges(&a, &[b.clone()]);

        assert_eq!(graph.node_count(), 2);
        assert_eq!(graph.edge_count(), 1);

        graph.remove_file(&b);

        assert_eq!(graph.node_count(), 1);
        assert_eq!(graph.edge_count(), 0);
        assert!(!graph.contains(&b));
    }

    #[test]
    fn get_dependents_returns_importers() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");
        let c = PathBuf::from("/src/c.ts");
        let util = PathBuf::from("/src/util.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        graph.add_file(c.clone());
        graph.add_file(util.clone());

        // a, b, c all import util
        graph.update_edges(&a, &[util.clone()]);
        graph.update_edges(&b, &[util.clone()]);
        graph.update_edges(&c, &[util.clone()]);

        let dependents = graph.get_dependents(&util);
        assert_eq!(dependents.len(), 3);
        assert!(dependents.contains(&a));
        assert!(dependents.contains(&b));
        assert!(dependents.contains(&c));
    }

    #[test]
    fn overflow_at_max_nodes() {
        let mut graph = DepGraph::new();

        for i in 0..MAX_GRAPH_NODES {
            let path = PathBuf::from(format!("/src/file{i}.ts"));
            assert!(graph.add_file(path).is_some());
        }

        assert!(!graph.is_overflow());
        assert_eq!(graph.node_count(), MAX_GRAPH_NODES);

        // One more should trigger overflow
        let extra = PathBuf::from("/src/extra.ts");
        assert!(graph.add_file(extra).is_none());
        assert!(graph.is_overflow());
    }

    #[test]
    fn shared_graph_works() {
        let graph = new_shared_graph();

        {
            let mut g = graph.write().unwrap();
            g.add_file(PathBuf::from("/src/a.ts"));
        }

        {
            let g = graph.read().unwrap();
            assert_eq!(g.node_count(), 1);
        }
    }
}

//! Affected file computation using reverse BFS.
//!
//! Computes the transitive closure of files affected by dirty files.

use super::graph::DepGraph;
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;

/// Compute all files affected by the dirty set.
///
/// Returns the dirty files plus all files that transitively depend on them.
/// Uses reverse BFS to traverse the dependency graph.
pub fn compute_affected(dirty: &HashSet<PathBuf>, graph: &DepGraph) -> HashSet<PathBuf> {
    let mut affected = HashSet::new();
    let mut queue = VecDeque::new();

    // Initialize with dirty files
    for path in dirty {
        if graph.contains(path) {
            affected.insert(path.clone());
            queue.push_back(path.clone());
        }
    }

    // BFS: find all dependents
    while let Some(current) = queue.pop_front() {
        for dependent in graph.get_dependents(&current) {
            if !affected.contains(&dependent) {
                affected.insert(dependent.clone());
                queue.push_back(dependent);
            }
        }
    }

    affected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::affected::graph::DepGraph;

    #[test]
    fn empty_dirty_set_returns_empty() {
        let graph = DepGraph::new();
        let dirty = HashSet::new();
        let affected = compute_affected(&dirty, &graph);
        assert!(affected.is_empty());
    }

    #[test]
    fn dirty_file_included_in_affected() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        graph.add_file(a.clone());

        let mut dirty = HashSet::new();
        dirty.insert(a.clone());

        let affected = compute_affected(&dirty, &graph);
        assert!(affected.contains(&a));
    }

    #[test]
    fn direct_dependent_included() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        // a imports b
        graph.update_edges(&a, &[b.clone()]);

        let mut dirty = HashSet::new();
        dirty.insert(b.clone());

        let affected = compute_affected(&dirty, &graph);
        assert!(affected.contains(&a));
        assert!(affected.contains(&b));
    }

    #[test]
    fn transitive_4_hop_chain() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");
        let c = PathBuf::from("/src/c.ts");
        let d = PathBuf::from("/src/d.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        graph.add_file(c.clone());
        graph.add_file(d.clone());

        // a → b → c → d
        graph.update_edges(&a, &[b.clone()]);
        graph.update_edges(&b, &[c.clone()]);
        graph.update_edges(&c, &[d.clone()]);

        let mut dirty = HashSet::new();
        dirty.insert(d.clone());

        let affected = compute_affected(&dirty, &graph);
        assert_eq!(affected.len(), 4);
        assert!(affected.contains(&a));
        assert!(affected.contains(&b));
        assert!(affected.contains(&c));
        assert!(affected.contains(&d));
    }

    #[test]
    fn circular_dependency_terminates() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");
        let c = PathBuf::from("/src/c.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        graph.add_file(c.clone());

        // a → b → c → a (cycle)
        graph.update_edges(&a, &[b.clone()]);
        graph.update_edges(&b, &[c.clone()]);
        graph.update_edges(&c, &[a.clone()]);

        let mut dirty = HashSet::new();
        dirty.insert(a.clone());

        let affected = compute_affected(&dirty, &graph);
        assert_eq!(affected.len(), 3);
        assert!(affected.contains(&a));
        assert!(affected.contains(&b));
        assert!(affected.contains(&c));
    }

    #[test]
    fn diamond_dependency() {
        let mut graph = DepGraph::new();
        let a = PathBuf::from("/src/a.ts");
        let b = PathBuf::from("/src/b.ts");
        let c = PathBuf::from("/src/c.ts");
        let d = PathBuf::from("/src/d.ts");

        graph.add_file(a.clone());
        graph.add_file(b.clone());
        graph.add_file(c.clone());
        graph.add_file(d.clone());

        // a → b → d
        // a → c → d
        graph.update_edges(&a, &[b.clone(), c.clone()]);
        graph.update_edges(&b, &[d.clone()]);
        graph.update_edges(&c, &[d.clone()]);

        let mut dirty = HashSet::new();
        dirty.insert(d.clone());

        let affected = compute_affected(&dirty, &graph);
        assert_eq!(affected.len(), 4);
    }

    #[test]
    fn dirty_file_not_in_graph_ignored() {
        let graph = DepGraph::new();

        let mut dirty = HashSet::new();
        dirty.insert(PathBuf::from("/src/nonexistent.ts"));

        let affected = compute_affected(&dirty, &graph);
        assert!(affected.is_empty());
    }
}

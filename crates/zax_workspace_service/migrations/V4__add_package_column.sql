-- V4: Add package column for monorepo workspace scoping
-- Requires SQLite 3.37+ for O(1) ALTER TABLE ADD COLUMN with DEFAULT
-- This migration is additive and preserves all existing data.
-- Existing rows will have package = '' (empty string = no package scope).

ALTER TABLE test_failures ADD COLUMN package TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN package TEXT NOT NULL DEFAULT '';

-- Composite indices for scoped delta queries
-- These indices optimize queries that filter by both run_id and package
CREATE INDEX idx_test_failures_run_package ON test_failures(run_id, package);
CREATE INDEX idx_findings_run_package ON findings(run_id, package);

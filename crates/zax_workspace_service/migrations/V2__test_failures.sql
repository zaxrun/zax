-- V2: Add workspace_id to runs table and create test_failures table
-- This migration is additive and preserves all V1 data.

-- Add workspace_id column to runs table with default empty string
ALTER TABLE runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';

-- Create index for efficient workspace + time queries
CREATE INDEX idx_runs_workspace_started ON runs(workspace_id, started_at DESC);

-- Create test_failures table
CREATE TABLE test_failures (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    stable_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    file TEXT NOT NULL,
    message TEXT NOT NULL
);

-- Create index for efficient delta computation via SQL EXCEPT
CREATE INDEX idx_test_failures_run_stable ON test_failures(run_id, stable_id);

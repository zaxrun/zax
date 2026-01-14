-- V3: Create findings table for ESLint integration
-- This migration is additive and preserves all existing data.

CREATE TABLE findings (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    stable_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    rule TEXT NOT NULL,
    file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    message TEXT NOT NULL
);

-- Create index for efficient delta computation
CREATE INDEX idx_findings_run_stable ON findings(run_id, stable_id);

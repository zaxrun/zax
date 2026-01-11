CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    run_id TEXT UNIQUE NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER
);

pub const CREATE_DOWNLOADS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    filename TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    total_bytes INTEGER,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_message TEXT,
    supports_range INTEGER NOT NULL DEFAULT 0,
    segment_count INTEGER NOT NULL DEFAULT 8,
    segments_json TEXT NOT NULL DEFAULT '[]',
    etag TEXT,
    last_modified TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    cookies TEXT,
    referrer TEXT,
    user_agent TEXT
);
"#;

pub const CREATE_SETTINGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

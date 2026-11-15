use crate::db::schema::{CREATE_DOWNLOADS_TABLE, CREATE_SETTINGS_TABLE};
use crate::engine::task::{DownloadStatus, DownloadTask, SegmentProgress};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Result};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;

        // Enable Write-Ahead Logging and busy timeout for safe concurrent read/write across multiple processes
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")?;
        conn.execute_batch(CREATE_DOWNLOADS_TABLE)?;
        conn.execute_batch(CREATE_SETTINGS_TABLE)?;

        // Safe migrations for newly added columns
        let _ = conn.execute("ALTER TABLE downloads ADD COLUMN cookies TEXT;", []);
        let _ = conn.execute("ALTER TABLE downloads ADD COLUMN referrer TEXT;", []);
        let _ = conn.execute("ALTER TABLE downloads ADD COLUMN user_agent TEXT;", []);

        // One-time migration: upgrade legacy default_segments = 4 to 8
        let migrated: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'migrated_default_segments_8'",
                [],
                |row| row.get(0),
            )
            .ok();
        if migrated.is_none() {
            if let Ok(raw) = conn.query_row(
                "SELECT value FROM settings WHERE key = 'app_settings'",
                [],
                |row| row.get::<_, String>(0),
            ) {
                if let Ok(mut parsed) = serde_json::from_str::<crate::engine::task::AppSettings>(&raw) {
                    if parsed.default_segments == 4 {
                        parsed.default_segments = 8;
                        if let Ok(updated) = serde_json::to_string(&parsed) {
                            let _ = conn.execute(
                                "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_settings', ?1)",
                                params![updated],
                            );
                        }
                    }
                }
            }
            let _ = conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_default_segments_8', '1')",
                [],
            );
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Reconciles tasks upon application startup.
    /// Any task that was left in 'downloading' or 'probing' when the app closed is set to 'paused'.
    /// Segment progress and downloaded_bytes are reconciled with actual physical file sizes on disk.
    pub fn reconcile_on_startup(&self) -> Result<usize> {
        let tasks = self.list_tasks()?;
        let mut count = 0;

        for mut task in tasks {
            if task.status == DownloadStatus::Downloading || task.status == DownloadStatus::Probing {
                let dest = &task.destination_path;
                let is_multi = task.supports_range && task.segments.len() > 1;
                let mut total_on_disk = 0u64;

                if is_multi {
                    for seg in &mut task.segments {
                        let part_p = std::path::PathBuf::from(format!("{}.part{}", dest, seg.index));
                        let size = std::fs::metadata(&part_p).map(|m| m.len()).unwrap_or(0);
                        let expected = seg.end_byte.saturating_sub(seg.start_byte) + 1;
                        let valid_size = size.min(expected);
                        seg.downloaded_bytes = valid_size;
                        seg.completed = valid_size >= expected;
                        total_on_disk += valid_size;
                    }
                } else {
                    let single_p = std::path::PathBuf::from(format!("{}.mdmpart", dest));
                    let size = if task.supports_range {
                        std::fs::metadata(&single_p).map(|m| m.len()).unwrap_or(0)
                    } else {
                        0
                    };
                    total_on_disk = size;
                    if let Some(first_seg) = task.segments.first_mut() {
                        first_seg.downloaded_bytes = size;
                        if let Some(tot) = task.total_bytes {
                            first_seg.completed = size >= tot;
                        }
                    }
                }

                let final_downloaded = if let Some(tot) = task.total_bytes {
                    total_on_disk.min(tot)
                } else {
                    total_on_disk
                };

                task.downloaded_bytes = final_downloaded;
                task.status = DownloadStatus::Paused;

                self.update_task_progress(
                    &task.id,
                    final_downloaded,
                    &DownloadStatus::Paused,
                    None,
                    None,
                    Some(&task.segments),
                )?;
                count += 1;
            }
        }

        Ok(count)
    }

    pub fn insert_or_update_task(&self, task: &DownloadTask) -> Result<()> {
        let conn = self.conn();
        let segments_json = serde_json::to_string(&task.segments).unwrap_or_else(|_| "[]".to_string());
        let status_str = serde_json::to_string(&task.status)
            .unwrap_or_else(|_| "\"queued\"".to_string())
            .trim_matches('"')
            .to_string();

        conn.execute(
            r#"
            INSERT INTO downloads (
                id, url, filename, destination_path, total_bytes, downloaded_bytes,
                status, error_message, supports_range, segment_count, segments_json,
                etag, last_modified, created_at, completed_at, cookies, referrer, user_agent
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            ON CONFLICT(id) DO UPDATE SET
                filename = excluded.filename,
                destination_path = excluded.destination_path,
                total_bytes = COALESCE(excluded.total_bytes, downloads.total_bytes),
                downloaded_bytes = excluded.downloaded_bytes,
                status = excluded.status,
                error_message = excluded.error_message,
                supports_range = excluded.supports_range,
                segment_count = excluded.segment_count,
                segments_json = excluded.segments_json,
                etag = COALESCE(excluded.etag, downloads.etag),
                last_modified = COALESCE(excluded.last_modified, downloads.last_modified),
                completed_at = excluded.completed_at
            "#,
            params![
                task.id,
                task.url,
                task.filename,
                task.destination_path,
                task.total_bytes,
                task.downloaded_bytes,
                status_str,
                task.error_message,
                if task.supports_range { 1 } else { 0 },
                task.segment_count,
                segments_json,
                task.etag,
                task.last_modified,
                task.created_at.to_rfc3339(),
                task.completed_at.map(|dt| dt.to_rfc3339()),
                task.cookies,
                task.referrer,
                task.user_agent,
            ],
        )?;

        Ok(())
    }

    pub fn update_task_total_bytes(&self, id: &str, total_bytes: u64) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "UPDATE downloads SET total_bytes = ?1 WHERE id = ?2",
            params![total_bytes, id],
        )?;
        Ok(())
    }

    pub fn update_task_progress(
        &self,
        id: &str,
        downloaded_bytes: u64,
        status: &DownloadStatus,
        error_msg: Option<&str>,
        completed_at: Option<DateTime<Utc>>,
        segments: Option<&[SegmentProgress]>,
    ) -> Result<()> {
        let conn = self.conn();
        let status_str = serde_json::to_string(status)
            .unwrap_or_else(|_| "\"queued\"".to_string())
            .trim_matches('"')
            .to_string();

        if let Some(segs) = segments {
            let segments_json = serde_json::to_string(segs).unwrap_or_else(|_| "[]".to_string());
            conn.execute(
                "UPDATE downloads SET downloaded_bytes = ?1, status = ?2, error_message = ?3, completed_at = ?4, segments_json = ?5 WHERE id = ?6",
                params![
                    downloaded_bytes,
                    status_str,
                    error_msg,
                    completed_at.map(|dt| dt.to_rfc3339()),
                    segments_json,
                    id
                ],
            )?;
        } else {
            conn.execute(
                "UPDATE downloads SET downloaded_bytes = ?1, status = ?2, error_message = ?3, completed_at = ?4 WHERE id = ?5",
                params![
                    downloaded_bytes,
                    status_str,
                    error_msg,
                    completed_at.map(|dt| dt.to_rfc3339()),
                    id
                ],
            )?;
        }

        Ok(())
    }

    pub fn list_tasks(&self) -> Result<Vec<DownloadTask>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, url, filename, destination_path, total_bytes, downloaded_bytes,
                   status, error_message, supports_range, segment_count, segments_json,
                   etag, last_modified, created_at, completed_at, cookies, referrer, user_agent
            FROM downloads ORDER BY created_at DESC
            "#,
        )?;

        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(6)?;
            let status: DownloadStatus = serde_json::from_str(&format!("\"{}\"", status_str))
                .unwrap_or(DownloadStatus::Queued);

            let segments_json: String = row.get(10)?;
            let segments: Vec<SegmentProgress> = serde_json::from_str(&segments_json).unwrap_or_default();

            let created_at_str: String = row.get(13)?;
            let created_at = DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());

            let completed_at_str: Option<String> = row.get(14)?;
            let completed_at = completed_at_str.and_then(|s| {
                DateTime::parse_from_rfc3339(&s)
                    .map(|dt| dt.with_timezone(&Utc))
                    .ok()
            });

            let supports_range_int: i32 = row.get(8)?;

            Ok(DownloadTask {
                id: row.get(0)?,
                url: row.get(1)?,
                filename: row.get(2)?,
                destination_path: row.get(3)?,
                total_bytes: row.get(4)?,
                downloaded_bytes: row.get(5)?,
                speed_bytes_per_sec: 0,
                eta_seconds: None,
                status,
                error_message: row.get(7)?,
                supports_range: supports_range_int == 1,
                segment_count: row.get(9)?,
                segments,
                etag: row.get(11)?,
                last_modified: row.get(12)?,
                created_at,
                completed_at,
                cookies: row.get(15)?,
                referrer: row.get(16)?,
                user_agent: row.get(17)?,
            })
        })?;

        let mut tasks = Vec::new();
        for task_res in rows {
            if let Ok(task) = task_res {
                tasks.push(task);
            }
        }

        Ok(tasks)
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

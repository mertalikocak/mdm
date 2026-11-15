use mdm_lib::db::Database;
use mdm_lib::engine::planner::plan_segments;
use mdm_lib::engine::probe::{get_collision_free_path, probe_url, sanitize_filename};
use mdm_lib::engine::task::{DownloadStatus, DownloadTask, SegmentProgress};
use mdm_lib::engine::worker::{DownloadWorker, RateLimiter, WorkerError};
use mdm_lib::engine::DownloadManager;
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

/// Helper: compute sha256 of in-memory slice
fn hash_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

#[tokio::test]
async fn test_collision_free_path() {
    let temp_dir = std::env::temp_dir().join(format!("mdm_test_collision_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let p1 = get_collision_free_path(&temp_dir.to_string_lossy(), "test_file.iso");
    assert!(p1.ends_with("test_file.iso"));
    std::fs::write(&p1, b"first").unwrap();

    let p2 = get_collision_free_path(&temp_dir.to_string_lossy(), "test_file.iso");
    assert!(p2.ends_with("test_file_1.iso"));
    std::fs::write(&p2, b"second").unwrap();

    let p3 = get_collision_free_path(&temp_dir.to_string_lossy(), "test_file.iso");
    assert!(p3.ends_with("test_file_2.iso"));

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_sanitize_filename() {
    assert_eq!(sanitize_filename("valid_name.zip"), "valid_name.zip");
    assert_eq!(sanitize_filename("invalid:name*with?chars.exe"), "invalid_name_with_chars.exe");
    assert_eq!(sanitize_filename("../../dangerous/path.bin"), "______dangerous_path.bin");
}

#[tokio::test]
async fn test_sqlite_repository_consistency() {
    let temp_db = std::env::temp_dir().join(format!("mdm_test_db_{}.db", uuid::Uuid::new_v4()));
    let db = Database::new(&temp_db).unwrap();

    let task = DownloadTask {
        id: "task-123".to_string(),
        url: "https://example.com/file.bin".to_string(),
        filename: "file.bin".to_string(),
        destination_path: "C:\\Downloads\\file.bin".to_string(),
        total_bytes: Some(1024),
        downloaded_bytes: 256,
        speed_bytes_per_sec: 0,
        eta_seconds: None,
        status: DownloadStatus::Downloading,
        error_message: None,
        supports_range: true,
        segment_count: 2,
        segments: vec![
            SegmentProgress { index: 0, start_byte: 0, end_byte: 511, downloaded_bytes: 256, completed: false },
            SegmentProgress { index: 1, start_byte: 512, end_byte: 1023, downloaded_bytes: 0, completed: false },
        ],
        etag: Some("etag1".to_string()),
        last_modified: None,
        cookies: None,
        referrer: None,
        user_agent: None,
        created_at: chrono::Utc::now(),
        completed_at: None,
    };

    db.insert_or_update_task(&task).unwrap();

    let tasks = db.list_tasks().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-123");
    assert_eq!(tasks[0].downloaded_bytes, 256);
    assert_eq!(tasks[0].segments.len(), 2);
    assert_eq!(tasks[0].segments[0].downloaded_bytes, 256);

    // Update with new segment progress
    let updated_segs = vec![
        SegmentProgress { index: 0, start_byte: 0, end_byte: 511, downloaded_bytes: 512, completed: true },
        SegmentProgress { index: 1, start_byte: 512, end_byte: 1023, downloaded_bytes: 256, completed: false },
    ];
    db.update_task_progress("task-123", 768, &DownloadStatus::Downloading, None, None, Some(&updated_segs)).unwrap();

    let tasks2 = db.list_tasks().unwrap();
    assert_eq!(tasks2[0].downloaded_bytes, 768);
    assert_eq!(tasks2[0].segments[0].completed, true);
    assert_eq!(tasks2[0].segments[1].downloaded_bytes, 256);

    db.delete_task("task-123").unwrap();
    assert_eq!(db.list_tasks().unwrap().len(), 0);

    let _ = std::fs::remove_file(&temp_db);
}

#[tokio::test]
async fn test_server_ignoring_range_returns_200_is_rejected() {
    // Spin up local TCP server that ignores Range and always sends HTTP 200 OK
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                // Defiant server returns 200 OK despite Range header
                let resp = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nHELLO";
                let _ = socket.write_all(resp.as_bytes()).await;
            });
        }
    });

    let client = Client::new();
    let temp_part = std::env::temp_dir().join(format!("test_part_{}.part0", uuid::Uuid::new_v4()));
    let seg_counter = Arc::new(AtomicU64::new(0));
    let down_counter = Arc::new(AtomicU64::new(0));
    let (_tx, rx) = watch::channel(false);

    let res = DownloadWorker::download_segment(
        &client,
        &format!("http://{}/file.bin", addr),
        temp_part.clone(),
        0,
        100, // expecting bytes 0-100
        199,
        0,
        seg_counter,
        down_counter,
        None,
        rx,
        None,
        None,
        None,
    ).await;

    // Must be rejected with RangeIgnoredByServer!
    assert!(res.is_err());
    match res.unwrap_err() {
        WorkerError::RangeIgnoredByServer(code) => assert_eq!(code, 200),
        other => panic!("Expected RangeIgnoredByServer, got {:?}", other),
    }

    let _ = tokio::fs::remove_file(temp_part).await;
}

#[tokio::test]
async fn test_corrupt_part_file_rejected_in_finalization() {
    let temp_dir = std::env::temp_dir().join(format!("mdm_corrupt_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let dest_file = temp_dir.join("final.bin");
    let part0 = temp_dir.join("final.bin.part0");
    let part1 = temp_dir.join("final.bin.part1");

    // Part 0 is expected to be 50 bytes, but we write only 30 bytes
    std::fs::write(&part0, vec![1u8; 30]).unwrap();
    std::fs::write(&part1, vec![2u8; 50]).unwrap();

    let segs = vec![
        SegmentProgress { index: 0, start_byte: 0, end_byte: 49, downloaded_bytes: 50, completed: true },
        SegmentProgress { index: 1, start_byte: 50, end_byte: 99, downloaded_bytes: 50, completed: true },
    ];

    let res = DownloadWorker::finalize_segments(
        &dest_file.to_string_lossy(),
        vec![part0, part1],
        &segs,
        Some(100),
    ).await;

    // Must reject due to size corruption!
    assert!(res.is_err());
    match res.unwrap_err() {
        WorkerError::CorruptPartFile { index, expected, actual } => {
            assert_eq!(index, 0);
            assert_eq!(expected, 50);
            assert_eq!(actual, 30);
        }
        other => panic!("Expected CorruptPartFile, got {:?}", other),
    }

    // Target file must NOT exist
    assert!(!dest_file.exists());

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_end_to_end_parallel_download_and_sha256() {
    // 1. Create a 64 KB known binary payload with deterministic pattern
    let mut payload = Vec::with_capacity(65536);
    for i in 0..65536 {
        payload.push((i % 251) as u8);
    }
    let expected_hash = hash_bytes(&payload);
    let payload_arc = Arc::new(payload);

    // 2. Spin up local mock server supporting HEAD and Range GET 206
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv_payload = Arc::clone(&payload_arc);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = Arc::clone(&srv_payload);
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 2048];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                if req_str.starts_with("HEAD") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\n\r\n",
                        data.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.starts_with("GET") {
                    let req_lower = req_str.to_ascii_lowercase();
                    if let Some(pos) = req_lower.find("range: bytes=") {
                        let range_str = &req_str[pos + 13..];
                        let line_end = range_str.find("\r\n").unwrap_or(range_str.len());
                        let range_val = &range_str[..line_end];
                        let parts: Vec<&str> = range_val.split('-').collect();
                        let start: usize = parts[0].trim().parse().unwrap_or(0);
                        let end: usize = if parts.len() > 1 && !parts[1].trim().is_empty() {
                            parts[1].trim().parse().unwrap_or(data.len() - 1)
                        } else {
                            data.len() - 1
                        };

                        let slice = &data[start..=end];
                        let resp_hdr = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\n\r\n",
                            start, end, data.len(), slice.len()
                        );
                        let _ = socket.write_all(resp_hdr.as_bytes()).await;
                        let _ = socket.write_all(slice).await;
                    } else {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                            data.len()
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.write_all(&data).await;
                    }
                }
            });
        }
    });

    let client = Client::new();
    let test_url = format!("http://{}/payload.bin", addr);

    // 3. Test Probe
    let probe = probe_url(&client, &test_url).await.unwrap();
    assert_eq!(probe.total_bytes, Some(65536));
    assert!(probe.supports_range);

    // 4. Test Planner
    let segments = plan_segments(probe.total_bytes, 4, probe.supports_range);
    assert_eq!(segments.len(), 4);

    // 5. Download 4 segments in parallel
    let temp_dir = std::env::temp_dir().join(format!("mdm_e2e_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let dest_file = temp_dir.join("payload.bin");

    let total_counter = Arc::new(AtomicU64::new(0));
    let mut part_paths = Vec::new();
    let mut tasks = Vec::new();

    for seg in &segments {
        let part_file = temp_dir.join(format!("payload.bin.part{}", seg.index));
        part_paths.push(part_file.clone());

        let c = client.clone();
        let u = test_url.clone();
        let s_idx = seg.index;
        let s_start = seg.start_byte;
        let s_end = seg.end_byte;
        let seg_cnt = Arc::new(AtomicU64::new(0));
        let tot_cnt = Arc::clone(&total_counter);
        let (_tx, rx) = watch::channel(false);

        tasks.push(tokio::spawn(async move {
            DownloadWorker::download_segment(
                &c, &u, part_file, s_idx, s_start, s_end, 0, seg_cnt, tot_cnt, None, rx, None, None, None,
            ).await
        }));
    }

    for t in tasks {
        t.await.unwrap().unwrap();
    }

    assert_eq!(total_counter.load(std::sync::atomic::Ordering::SeqCst), 65536);

    // 6. Finalize segments
    DownloadWorker::finalize_segments(
        &dest_file.to_string_lossy(),
        part_paths,
        &segments,
        Some(65536),
    ).await.unwrap();

    assert!(dest_file.exists());
    assert_eq!(std::fs::metadata(&dest_file).unwrap().len(), 65536);

    // 7. Verify cryptographic SHA-256 integrity
    let downloaded_hash = DownloadWorker::compute_file_sha256(&dest_file).await.unwrap();
    assert_eq!(downloaded_hash, expected_hash, "SHA-256 byte-for-byte mismatch!");

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_probe_head_failure_falls_back_to_get_range() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 1024];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                if req_str.starts_with("HEAD") {
                    // HEAD deliberately blocked with 405 Method Not Allowed
                    let resp = "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nContent-Length: 0\r\n\r\n";
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.starts_with("GET") {
                    // GET with Range: bytes=0-0 returns 206 Partial Content
                    let resp = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/987654\r\nContent-Length: 1\r\nContent-Disposition: attachment; filename=\"fallback_probe.zip\"\r\n\r\nX";
                    let _ = socket.write_all(resp.as_bytes()).await;
                }
            });
        }
    });

    let client = Client::new();
    let test_url = format!("http://{}/resource", addr);

    let probe = probe_url(&client, &test_url).await.unwrap();
    assert_eq!(probe.total_bytes, Some(987654));
    assert!(probe.supports_range);
    assert_eq!(probe.filename, "fallback_probe.zip");
}

#[tokio::test]
async fn test_content_range_mismatch_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 1024];
                let _ = socket.read(&mut req_buf).await;
                // Server returns 206 but with start byte 0 instead of requested 200
                let resp = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-99/1000\r\nContent-Length: 100\r\n\r\n"
                    .to_string() + &"A".repeat(100);
                let _ = socket.write_all(resp.as_bytes()).await;
            });
        }
    });

    let client = Client::new();
    let temp_part = std::env::temp_dir().join(format!("test_mismatch_{}.part0", uuid::Uuid::new_v4()));
    let seg_counter = Arc::new(AtomicU64::new(0));
    let down_counter = Arc::new(AtomicU64::new(0));
    let (_tx, rx) = watch::channel(false);

    // Requesting bytes 200 to 299
    let res = DownloadWorker::download_segment(
        &client,
        &format!("http://{}/file.bin", addr),
        temp_part.clone(),
        0,
        200,
        299,
        0,
        seg_counter,
        down_counter,
        None,
        rx,
        None,
        None,
        None,
    ).await;

    assert!(res.is_err());
    match res.unwrap_err() {
        WorkerError::InvalidContentRange { expected, actual } => {
            assert_eq!(expected, 200);
            assert!(actual.unwrap().contains("bytes 0-99/1000"));
        }
        other => panic!("Expected InvalidContentRange, got {:?}", other),
    }

    let _ = tokio::fs::remove_file(temp_part).await;
}

#[tokio::test]
async fn test_incomplete_segment_early_eof_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 1024];
                let _ = socket.read(&mut req_buf).await;
                // Server claims 100 bytes but immediately closes socket after sending 30 bytes
                let header = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-99/1000\r\nContent-Length: 100\r\n\r\n";
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(&vec![7u8; 30]).await;
                // Socket closed here -> early EOF!
            });
        }
    });

    let client = Client::new();
    let temp_part = std::env::temp_dir().join(format!("test_early_eof_{}.part0", uuid::Uuid::new_v4()));
    let seg_counter = Arc::new(AtomicU64::new(0));
    let down_counter = Arc::new(AtomicU64::new(0));
    let (_tx, rx) = watch::channel(false);

    let res = DownloadWorker::download_segment(
        &client,
        &format!("http://{}/file.bin", addr),
        temp_part.clone(),
        0,
        0,
        99,
        0,
        seg_counter,
        down_counter,
        None,
        rx,
        None,
        None,
        None,
    ).await;

    assert!(res.is_err());
    match res.unwrap_err() {
        WorkerError::IncompleteSegment { index, expected, received } => {
            assert_eq!(index, 0);
            assert_eq!(expected, 100);
            assert_eq!(received, 30);
        }
        WorkerError::Network(e) => {
            assert!(e.to_string().to_lowercase().contains("body") || e.to_string().to_lowercase().contains("eof") || e.is_decode());
        }
        other => panic!("Expected IncompleteSegment or Network EOF error, got {:?}", other),
    }

    let _ = tokio::fs::remove_file(temp_part).await;
}

#[tokio::test]
async fn test_network_errors_and_invalid_schemes() {
    let client = Client::new();

    // 1. Invalid scheme
    let err_scheme = probe_url(&client, "ftp://files.example.com/test.iso").await;
    assert!(err_scheme.is_err());

    // 2. Non-existent domain (connection refused/DNS error)
    let err_dns = probe_url(&client, "http://127.0.0.1:54321/nonexistent.bin").await;
    assert!(err_dns.is_err());
}

#[tokio::test]
async fn test_pause_resume_consistent_parts_and_sha256() {
    let mut payload = Vec::with_capacity(65536);
    for i in 0..65536 {
        payload.push(((i * 7 + 13) % 256) as u8);
    }
    let expected_hash = hash_bytes(&payload);
    let payload_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv_payload = Arc::clone(&payload_arc);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = Arc::clone(&srv_payload);
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 2048];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                if req_str.starts_with("GET") {
                    let req_lower = req_str.to_ascii_lowercase();
                    if let Some(pos) = req_lower.find("range: bytes=") {
                        let range_str = &req_str[pos + 13..];
                        let line_end = range_str.find("\r\n").unwrap_or(range_str.len());
                        let range_val = &range_str[..line_end];
                        let parts: Vec<&str> = range_val.split('-').collect();
                        let start: usize = parts[0].trim().parse().unwrap_or(0);
                        let end: usize = if parts.len() > 1 && !parts[1].trim().is_empty() {
                            parts[1].trim().parse().unwrap_or(data.len() - 1)
                        } else {
                            data.len() - 1
                        };

                        let slice = &data[start..=end];
                        let resp_hdr = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\n\r\n",
                            start, end, data.len(), slice.len()
                        );
                        let _ = socket.write_all(resp_hdr.as_bytes()).await;
                        let _ = socket.write_all(slice).await;
                    }
                }
            });
        }
    });

    let client = Client::new();
    let test_url = format!("http://{}/resumable.bin", addr);
    let total_bytes = 65536u64;

    // 4 segments of 16384 bytes each
    let segments = plan_segments(Some(total_bytes), 4, true);
    assert_eq!(segments.len(), 4);

    let temp_dir = std::env::temp_dir().join(format!("mdm_resume_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let dest_file = temp_dir.join("resumable.bin");

    // SIMULATE PAUSED STATE:
    // Part 0 is already completely downloaded (16384 bytes)
    let part0 = temp_dir.join("resumable.bin.part0");
    std::fs::write(&part0, &payload_arc[0..16384]).unwrap();

    // Part 1 is half downloaded (8000 bytes)
    let part1 = temp_dir.join("resumable.bin.part1");
    std::fs::write(&part1, &payload_arc[16384..24384]).unwrap();

    // Part 2 and Part 3 are not started (0 bytes)
    let part2 = temp_dir.join("resumable.bin.part2");
    let part3 = temp_dir.join("resumable.bin.part3");

    let part_paths = vec![part0.clone(), part1.clone(), part2.clone(), part3.clone()];
    let initial_part_sizes = vec![16384u64, 8000u64, 0u64, 0u64];
    let initial_downloaded: u64 = initial_part_sizes.iter().sum();
    assert_eq!(initial_downloaded, 24384);

    let total_counter = Arc::new(AtomicU64::new(initial_downloaded));
    let mut tasks = Vec::new();

    for (idx, seg) in segments.iter().enumerate() {
        let p_file = part_paths[idx].clone();
        let c = client.clone();
        let u = test_url.clone();
        let s_idx = seg.index;
        let s_start = seg.start_byte;
        let s_end = seg.end_byte;
        let s_down = initial_part_sizes[idx];
        let seg_cnt = Arc::new(AtomicU64::new(s_down));
        let tot_cnt = Arc::clone(&total_counter);
        let (_tx, rx) = watch::channel(false);

        tasks.push(tokio::spawn(async move {
            DownloadWorker::download_segment(
                &c, &u, p_file, s_idx, s_start, s_end, s_down, seg_cnt, tot_cnt, None, rx, None, None, None,
            ).await
        }));
    }

    for t in tasks {
        t.await.unwrap().expect("Segment resume failed");
    }

    // Total counter must equal exactly 65536
    assert_eq!(total_counter.load(std::sync::atomic::Ordering::SeqCst), 65536);

    // Finalize merged file
    DownloadWorker::finalize_segments(
        &dest_file.to_string_lossy(),
        part_paths.clone(),
        &segments,
        Some(65536),
    ).await.expect("Finalize resumed segments failed");

    // Target file must exist and have exact size
    assert!(dest_file.exists());
    assert_eq!(std::fs::metadata(&dest_file).unwrap().len(), 65536);

    // Cryptographic hash check must match 100% byte-for-byte
    let resumed_hash = DownloadWorker::compute_file_sha256(&dest_file).await.unwrap();
    assert_eq!(resumed_hash, expected_hash, "Resumed file SHA-256 byte mismatch!");

    // Temp part files must all be cleaned up
    for p in part_paths {
        assert!(!p.exists(), "Temporary part file was not cleaned up!");
    }

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_safe_swap_file_and_rollback_protection() {
    let temp_dir = std::env::temp_dir().join(format!("mdm_swap_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let dest_file = temp_dir.join("user_file.txt");
    let temp_file = temp_dir.join("downloaded.tmp");

    // 1. Initial user file exists with original data
    std::fs::write(&dest_file, b"Original Important Content").unwrap();
    std::fs::write(&temp_file, b"New Downloaded Content").unwrap();

    // 2. Perform safe swap
    DownloadWorker::safe_swap_file(&temp_file, &dest_file).await.unwrap();

    // 3. User file must now have the new content and backup must be cleaned
    assert_eq!(std::fs::read(&dest_file).unwrap(), b"New Downloaded Content");
    let backup_path = temp_dir.join("user_file.txt.mdmbak");
    assert!(!backup_path.exists());

    // 4. Test Rollback Protection when source temp file is missing/fails
    let non_existent_temp = temp_dir.join("non_existent.tmp");
    let res = DownloadWorker::safe_swap_file(&non_existent_temp, &dest_file).await;

    // Must fail but ROLLBACK must preserve original content!
    assert!(res.is_err());
    assert!(dest_file.exists());
    assert_eq!(std::fs::read(&dest_file).unwrap(), b"New Downloaded Content");

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_speed_limiter_enforces_bandwidth() {
    // 64 KB payload
    let payload = vec![42u8; 65536];
    let payload_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv_payload = Arc::clone(&payload_arc);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = Arc::clone(&srv_payload);
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                    data.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.write_all(&data).await;
            });
        }
    });

    let client = Client::new();
    let test_url = format!("http://{}/throttled.bin", addr);
    let temp_dir = std::env::temp_dir().join(format!("mdm_limit_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let dest_file = temp_dir.join("throttled.bin");

    // Limit speed to 32 KB/sec. 64 KB total should take at least ~1.0 second.
    let limiter = RateLimiter::new(Some(32 * 1024));
    let counter = Arc::new(AtomicU64::new(0));
    let total_counter = Arc::new(AtomicU64::new(0));
    let (_tx, rx) = watch::channel(false);

    let start_time = std::time::Instant::now();
    DownloadWorker::download_single(
        &client,
        &test_url,
        &dest_file.to_string_lossy(),
        false,
        counter,
        total_counter,
        Some(limiter),
        rx,
        None,
        None,
        None,
    ).await.unwrap();
    let elapsed = start_time.elapsed();

    // Verify bandwidth throttle delay was actively applied (>= 900ms)
    assert!(
        elapsed >= std::time::Duration::from_millis(900),
        "Download completed too fast ({:?})! Speed limiter did not throttle.",
        elapsed
    );

    // Verify integrity
    assert_eq!(std::fs::metadata(&dest_file).unwrap().len(), 65536);

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_reconcile_on_startup_cleans_hanging_downloads() {
    let temp_db = std::env::temp_dir().join(format!("mdm_reconcile_{}.db", uuid::Uuid::new_v4()));
    let temp_dir = std::env::temp_dir().join(format!("mdm_reconcile_files_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let db = Database::new(&temp_db).unwrap();
    let dest_file = temp_dir.join("hanging.bin");
    let part0 = temp_dir.join("hanging.bin.part0");
    let part1 = temp_dir.join("hanging.bin.part1");

    // Write real partial files on disk (part0: 100 bytes, part1: 50 bytes)
    std::fs::write(&part0, vec![1u8; 100]).unwrap();
    std::fs::write(&part1, vec![2u8; 50]).unwrap();

    let task = DownloadTask {
        id: "hanging-task-1".to_string(),
        url: "http://example.com/hanging.bin".to_string(),
        filename: "hanging.bin".to_string(),
        destination_path: dest_file.to_string_lossy().to_string(),
        total_bytes: Some(400),
        downloaded_bytes: 350, // Stale DB counter: claims 350, but disk only has 150!
        speed_bytes_per_sec: 1000,
        eta_seconds: Some(10),
        status: DownloadStatus::Downloading, // Left in downloading state when app was closed
        error_message: None,
        supports_range: true,
        segment_count: 2,
        segments: vec![
            SegmentProgress { index: 0, start_byte: 0, end_byte: 199, downloaded_bytes: 200, completed: true },
            SegmentProgress { index: 1, start_byte: 200, end_byte: 399, downloaded_bytes: 150, completed: false },
        ],
        etag: Some("etag-v1".to_string()),
        last_modified: None,
        cookies: None,
        referrer: None,
        user_agent: None,
        created_at: chrono::Utc::now(),
        completed_at: None,
    };

    db.insert_or_update_task(&task).unwrap();

    // Call reconcile_on_startup
    let reconciled_count = db.reconcile_on_startup().unwrap();
    assert_eq!(reconciled_count, 1);

    // Verify task is now PAUSED and downloaded_bytes matches PHYSICAL DISK TRUTH (150 bytes)
    let tasks = db.list_tasks().unwrap();
    assert_eq!(tasks[0].status, DownloadStatus::Paused);
    assert_eq!(tasks[0].downloaded_bytes, 150);
    assert_eq!(tasks[0].segments[0].downloaded_bytes, 100);
    assert_eq!(tasks[0].segments[0].completed, false);
    assert_eq!(tasks[0].segments[1].downloaded_bytes, 50);

    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::remove_file(&temp_db);
}

#[tokio::test]
async fn test_parallel_segments_benchmark_and_integrity_comparison() {
    // 256 KB test file
    let file_size = 262144usize;
    let mut payload = Vec::with_capacity(file_size);
    for i in 0..file_size {
        payload.push(((i * 13 + 7) % 251) as u8);
    }
    let expected_hash = hash_bytes(&payload);
    let payload_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv_payload = Arc::clone(&payload_arc);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = Arc::clone(&srv_payload);
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 2048];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                if req_str.starts_with("HEAD") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                        data.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.starts_with("GET") {
                    let req_lower = req_str.to_ascii_lowercase();
                    if let Some(pos) = req_lower.find("range: bytes=") {
                        let range_str = &req_str[pos + 13..];
                        let line_end = range_str.find("\r\n").unwrap_or(range_str.len());
                        let range_val = &range_str[..line_end];
                        let parts: Vec<&str> = range_val.split('-').collect();
                        let start: usize = parts[0].trim().parse().unwrap_or(0);
                        let end: usize = if parts.len() > 1 && !parts[1].trim().is_empty() {
                            parts[1].trim().parse().unwrap_or(data.len() - 1)
                        } else {
                            data.len() - 1
                        };

                        let slice = &data[start..=end];
                        let resp_hdr = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\n\r\n",
                            start, end, data.len(), slice.len()
                        );
                        let _ = socket.write_all(resp_hdr.as_bytes()).await;
                        let _ = socket.write_all(slice).await;
                    }
                }
            });
        }
    });

    let client = Client::new();
    let test_url = format!("http://{}/benchmark.bin", addr);
    let temp_dir = std::env::temp_dir().join(format!("mdm_bench_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    // Benchmark 1, 2, 4, 8, 16 connections
    for seg_count in [1, 2, 4, 8, 16] {
        let segments = plan_segments(Some(file_size as u64), seg_count, true);
        assert_eq!(segments.len(), seg_count);

        let dest_file = temp_dir.join(format!("out_{}_segments.bin", seg_count));
        let mut part_paths = Vec::new();
        let mut tasks = Vec::new();
        let total_counter = Arc::new(AtomicU64::new(0));

        let start_time = std::time::Instant::now();

        for seg in &segments {
            let part_p = temp_dir.join(format!("out_{}_seg_{}.part", seg_count, seg.index));
            part_paths.push(part_p.clone());

            let c = client.clone();
            let u = test_url.clone();
            let s_idx = seg.index;
            let s_start = seg.start_byte;
            let s_end = seg.end_byte;
            let seg_cnt = Arc::new(AtomicU64::new(0));
            let tot_cnt = Arc::clone(&total_counter);
            let (_tx, rx) = watch::channel(false);

            tasks.push(tokio::spawn(async move {
                DownloadWorker::download_segment(
                    &c, &u, part_p, s_idx, s_start, s_end, 0, seg_cnt, tot_cnt, None, rx, None, None, None,
                ).await
            }));
        }

        for t in tasks {
            t.await.unwrap().expect("Segment failed");
        }

        DownloadWorker::finalize_segments(
            &dest_file.to_string_lossy(),
            part_paths,
            &segments,
            Some(file_size as u64),
        ).await.expect("Finalize failed");

        let duration = start_time.elapsed();
        let downloaded_hash = DownloadWorker::compute_file_sha256(&dest_file).await.unwrap();

        // 100% SHA-256 match regardless of segment count
        assert_eq!(downloaded_hash, expected_hash, "SHA-256 mismatch for {} segments", seg_count);
        assert_eq!(std::fs::metadata(&dest_file).unwrap().len(), file_size as u64);

        println!("Benchmark: {} segments downloaded and merged in {:?}", seg_count, duration);
    }

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_real_https_download_e2e_integrity() {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap();

    // Public test URL: Rust README on GitHub (stable HTTPS source)
    let https_url = "https://raw.githubusercontent.com/rust-lang/rust/master/README.md";

    let probe_res = probe_url(&client, https_url).await;
    match probe_res {
        Ok(probe) => {
            assert!(probe.total_bytes.is_some() && probe.total_bytes.unwrap() > 0);
            let temp_dir = std::env::temp_dir().join(format!("mdm_real_https_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&temp_dir).unwrap();
            let dest_file = temp_dir.join("README.md");

            let counter = Arc::new(AtomicU64::new(0));
            let total_counter = Arc::new(AtomicU64::new(0));
            let (_tx, rx) = watch::channel(false);

            let dl_res = DownloadWorker::download_single(
                &client,
                &probe.resolved_url,
                &dest_file.to_string_lossy(),
                probe.supports_range,
                counter,
                total_counter,
                None,
                rx,
                None,
                None,
                None,
            ).await;

            assert!(dl_res.is_ok(), "Real HTTPS download failed: {:?}", dl_res);
            assert!(dest_file.exists());
            assert_eq!(std::fs::metadata(&dest_file).unwrap().len(), probe.total_bytes.unwrap());

            let hash = DownloadWorker::compute_file_sha256(&dest_file).await.unwrap();
            assert!(!hash.is_empty());
            println!("Real HTTPS download succeeded! Size: {} bytes, SHA-256: {}", probe.total_bytes.unwrap(), hash);

            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        Err(e) => {
            eprintln!("External HTTPS probe could not connect (likely offline/ISP filter): {}", e);
        }
    }
}

#[tokio::test]
async fn test_locked_file_finalization_safe_rollback() {
    let temp_dir = std::env::temp_dir().join(format!("mdm_lock_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let dest_file = temp_dir.join("locked_dest.bin");
    let temp_file = temp_dir.join("locked_dest.bin.mdmmerge");

    // Existing user content
    std::fs::write(&dest_file, b"Original Uncorrupted Content").unwrap();
    std::fs::write(&temp_file, b"New Content").unwrap();

    // Create a scenario where renaming will fail because source file is removed or locked
    let _ = std::fs::remove_file(&temp_file); // Source temp disappeared

    let res = DownloadWorker::safe_swap_file(&temp_file, &dest_file).await;

    // Must return Io error
    assert!(res.is_err());
    // Original destination file must still exist with intact content
    assert!(dest_file.exists());
    assert_eq!(std::fs::read(&dest_file).unwrap(), b"Original Uncorrupted Content");

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_realistic_multisegment_performance_benchmark() {
    // 5 MB binary payload (5,242,880 bytes) for measurable multi-segment throughput
    let file_size = 5 * 1024 * 1024usize;
    let mut payload = Vec::with_capacity(file_size);
    for i in 0..file_size {
        payload.push(((i * 31 + 17) % 251) as u8);
    }
    let expected_hash = hash_bytes(&payload);
    let payload_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv_payload = Arc::clone(&payload_arc);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = Arc::clone(&srv_payload);
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 2048];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                if req_str.starts_with("HEAD") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                        data.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.starts_with("GET") {
                    let req_lower = req_str.to_ascii_lowercase();
                    if let Some(pos) = req_lower.find("range: bytes=") {
                        let range_str = &req_str[pos + 13..];
                        let line_end = range_str.find("\r\n").unwrap_or(range_str.len());
                        let range_val = &range_str[..line_end];
                        let parts: Vec<&str> = range_val.split('-').collect();
                        let start: usize = parts[0].trim().parse().unwrap_or(0);
                        let end: usize = if parts.len() > 1 && !parts[1].trim().is_empty() {
                            parts[1].trim().parse().unwrap_or(data.len() - 1)
                        } else {
                            data.len() - 1
                        };

                        let slice = &data[start..=end];
                        let resp_hdr = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\n\r\n",
                            start, end, data.len(), slice.len()
                        );
                        let _ = socket.write_all(resp_hdr.as_bytes()).await;
                        let _ = socket.write_all(slice).await;
                    }
                }
            });
        }
    });

    let client = Client::new();
    let test_url = format!("http://{}/big_benchmark.bin", addr);
    let temp_dir = std::env::temp_dir().join(format!("mdm_big_bench_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    println!("\n=== Realistic Multi-Segment Performance Benchmark (5 MB, 3 Runs Each) ===");

    for seg_count in [1, 2, 4, 8, 16] {
        let mut durations = Vec::new();

        // 3 repetitions per segment configuration
        for rep in 1..=3 {
            let segments = plan_segments(Some(file_size as u64), seg_count, true);
            let dest_file = temp_dir.join(format!("bench_{}seg_rep{}.bin", seg_count, rep));
            let mut part_paths = Vec::new();
            let mut tasks = Vec::new();
            let total_counter = Arc::new(AtomicU64::new(0));

            let start_time = std::time::Instant::now();

            for seg in &segments {
                let part_p = temp_dir.join(format!("part_{}_{}_{}.part", seg_count, rep, seg.index));
                part_paths.push(part_p.clone());

                let c = client.clone();
                let u = test_url.clone();
                let s_idx = seg.index;
                let s_start = seg.start_byte;
                let s_end = seg.end_byte;
                let seg_cnt = Arc::new(AtomicU64::new(0));
                let tot_cnt = Arc::clone(&total_counter);
                let (_tx, rx) = watch::channel(false);

                tasks.push(tokio::spawn(async move {
                    DownloadWorker::download_segment(
                        &c, &u, part_p, s_idx, s_start, s_end, 0, seg_cnt, tot_cnt, None, rx, None, None, None,
                    ).await
                }));
            }

            for t in tasks {
                t.await.unwrap().expect("Segment download failed");
            }

            DownloadWorker::finalize_segments(
                &dest_file.to_string_lossy(),
                part_paths,
                &segments,
                Some(file_size as u64),
            ).await.expect("Finalize failed");

            let elapsed = start_time.elapsed();
            durations.push(elapsed);

            // Verify integrity
            let downloaded_hash = DownloadWorker::compute_file_sha256(&dest_file).await.unwrap();
            assert_eq!(downloaded_hash, expected_hash, "Hash mismatch on {} segs rep {}", seg_count, rep);
            let _ = std::fs::remove_file(&dest_file);
        }

        let avg_millis: f64 = durations.iter().map(|d| d.as_secs_f64() * 1000.0).sum::<f64>() / 3.0;
        let avg_speed_mb_s = (file_size as f64 / (1024.0 * 1024.0)) / (avg_millis / 1000.0);

        println!(
            "-> {:2} Segments: Avg Duration = {:6.2} ms | Avg Speed = {:6.2} MB/s | Reps: [{:?}, {:?}, {:?}]",
            seg_count, avg_millis, avg_speed_mb_s, durations[0], durations[1], durations[2]
        );
    }

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_plan_segments_single_fallback() {
    let segs = plan_segments(Some(500), 4, false);
    assert_eq!(segs.len(), 1);
    assert_eq!(segs[0].start_byte, 0);
    assert_eq!(segs[0].end_byte, 500);
}

#[test]
fn test_plan_segments_partition() {
    let total = 1_000_000u64;
    let segs = plan_segments(Some(total), 4, true);
    assert_eq!(segs.len(), 4);
    assert_eq!(segs[0].start_byte, 0);
    assert_eq!(segs[3].end_byte, total - 1);

    for i in 0..segs.len() - 1 {
        assert_eq!(segs[i].end_byte + 1, segs[i + 1].start_byte);
    }
}

#[tokio::test]
async fn test_application_lifecycle_restart_and_resumption() {
    let file_size = 131072usize; // 128 KB
    let mut payload = Vec::with_capacity(file_size);
    for i in 0..file_size {
        payload.push(((i * 17 + 3) % 256) as u8);
    }
    let expected_hash = hash_bytes(&payload);
    let payload_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv_payload = Arc::clone(&payload_arc);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = Arc::clone(&srv_payload);
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 2048];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                if req_str.starts_with("HEAD") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"v1-stable\"\r\n\r\n",
                        data.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.starts_with("GET") {
                    let req_lower = req_str.to_ascii_lowercase();
                    if let Some(pos) = req_lower.find("range: bytes=") {
                        let range_str = &req_str[pos + 13..];
                        let line_end = range_str.find("\r\n").unwrap_or(range_str.len());
                        let range_val = &range_str[..line_end];
                        let parts: Vec<&str> = range_val.split('-').collect();
                        let start: usize = parts[0].trim().parse().unwrap_or(0);
                        let end: usize = if parts.len() > 1 && !parts[1].trim().is_empty() {
                            parts[1].trim().parse().unwrap_or(data.len() - 1)
                        } else {
                            data.len() - 1
                        };

                        let slice = &data[start..=end];
                        let resp_hdr = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"v1-stable\"\r\n\r\n",
                            start, end, data.len(), slice.len()
                        );
                        let _ = socket.write_all(resp_hdr.as_bytes()).await;
                        for chunk in slice.chunks(8192) {
                            if socket.write_all(chunk).await.is_err() {
                                break;
                            }
                            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
                        }
                    }
                }
            });
        }
    });

    let temp_db_path = std::env::temp_dir().join(format!("mdm_lifecycle_{}.db", uuid::Uuid::new_v4()));
    let temp_dir = std::env::temp_dir().join(format!("mdm_lifecycle_dest_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let test_url = format!("http://{}/lifecycle_file.bin", addr);

    // 1. LIFECYCLE INSTANCE 1: App starts, adds task
    let db1 = Arc::new(Database::new(&temp_db_path).unwrap());
    let engine1 = DownloadManager::new(Arc::clone(&db1), 3);
    let task = engine1.add_task(&test_url, &temp_dir.to_string_lossy(), 4).await.unwrap();
    let task_id = task.id.clone();
    let dest_path = task.destination_path.clone();

    // Let it download briefly then simulate app close
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    let _ = engine1.pause_task(&task_id).await;
    drop(engine1);
    drop(db1);

    // 2. SIMULATE APP RESTART: A fresh process opens the same SQLite database
    let db2 = Arc::new(Database::new(&temp_db_path).unwrap());
    let _ = db2.reconcile_on_startup().unwrap();
    let engine2 = DownloadManager::new(Arc::clone(&db2), 3);

    // Verify task state was cleanly restored to Paused without data corruption
    let tasks = db2.list_tasks().unwrap();
    let restored_task = tasks.into_iter().find(|t| t.id == task_id).expect("Task was lost after restart!");
    assert_eq!(restored_task.status, DownloadStatus::Paused);

    // 3. Resume the download from disk ground truth
    engine2.resume_task(&task_id).await.unwrap();

    // Poll until completed
    let start_wait = std::time::Instant::now();
    loop {
        let current_tasks = db2.list_tasks().unwrap();
        let t = current_tasks.into_iter().find(|t| t.id == task_id).unwrap();
        if t.status == DownloadStatus::Completed {
            break;
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Resumed download did not complete in time! Status: {:?}", t.status);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    // 4. Verify final on-disk file size and 100% cryptographic SHA-256 integrity
    assert!(std::path::Path::new(&dest_path).exists());
    assert_eq!(std::fs::metadata(&dest_path).unwrap().len(), file_size as u64);
    let final_hash = DownloadWorker::compute_file_sha256(&dest_path).await.unwrap();
    assert_eq!(final_hash, expected_hash, "Restored download SHA-256 mismatch!");

    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::remove_file(&temp_db_path);
}

#[tokio::test]
async fn test_download_queue_fifo_and_auto_slot_advance() {
    let payload = vec![99u8; 16384];
    let payload_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv_payload = Arc::clone(&payload_arc);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = Arc::clone(&srv_payload);
            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 1024];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                if req_str.starts_with("HEAD") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                        data.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                        data.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
                    let _ = socket.write_all(&data).await;
                }
            });
        }
    });

    let temp_db_path = std::env::temp_dir().join(format!("mdm_queue_{}.db", uuid::Uuid::new_v4()));
    let temp_dir = std::env::temp_dir().join(format!("mdm_queue_dest_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    let db = Arc::new(Database::new(&temp_db_path).unwrap());
    // Concurrency limit = 2
    let engine = DownloadManager::new(Arc::clone(&db), 2);

    let u1 = format!("http://{}/file1.bin", addr);
    let u2 = format!("http://{}/file2.bin", addr);
    let u3 = format!("http://{}/file3.bin", addr);

    // Add 3 tasks
    let t1 = engine.add_task(&u1, &temp_dir.to_string_lossy(), 1).await.unwrap();
    let t2 = engine.add_task(&u2, &temp_dir.to_string_lossy(), 1).await.unwrap();
    let t3 = engine.add_task(&u3, &temp_dir.to_string_lossy(), 1).await.unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Check states: t1 and t2 should be Downloading, t3 should be Queued!
    let tasks_now = db.list_tasks().unwrap();
    let st1 = tasks_now.iter().find(|t| t.id == t1.id).unwrap().status.clone();
    let st2 = tasks_now.iter().find(|t| t.id == t2.id).unwrap().status.clone();
    let st3 = tasks_now.iter().find(|t| t.id == t3.id).unwrap().status.clone();

    assert_eq!(st1, DownloadStatus::Downloading);
    assert_eq!(st2, DownloadStatus::Downloading);
    assert_eq!(st3, DownloadStatus::Queued);

    // Pausing t1 must NOT stop t2, and should auto-advance the queue so t3 starts!
    engine.pause_task(&t1.id).await.unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let tasks_after_pause = db.list_tasks().unwrap();
    let st1_p = tasks_after_pause.iter().find(|t| t.id == t1.id).unwrap().status.clone();
    let st2_p = tasks_after_pause.iter().find(|t| t.id == t2.id).unwrap().status.clone();
    let st3_p = tasks_after_pause.iter().find(|t| t.id == t3.id).unwrap().status.clone();

    assert_eq!(st1_p, DownloadStatus::Paused);
    assert_eq!(st2_p, DownloadStatus::Downloading, "Pausing t1 must not stop t2!");
    assert_eq!(st3_p, DownloadStatus::Downloading, "t3 should have automatically started from queue!");

    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::remove_file(&temp_db_path);
}

#[tokio::test]
async fn test_resumption_discards_stale_parts_when_etag_changes() {
    use std::sync::atomic::AtomicBool;

    let initial_data = vec![11u8; 65536]; // Version 1
    let updated_data = vec![22u8; 65536]; // Version 2
    let updated_hash = hash_bytes(&updated_data);

    let is_updated = Arc::new(AtomicBool::new(false));
    let is_updated_srv = Arc::clone(&is_updated);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let init_arc = Arc::new(initial_data);
    let upd_arc = Arc::new(updated_data);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let init_ref = Arc::clone(&init_arc);
            let upd_ref = Arc::clone(&upd_arc);
            let updated_flag = Arc::clone(&is_updated_srv);

            tokio::spawn(async move {
                let mut req_buf = vec![0u8; 2048];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);

                let changed = updated_flag.load(std::sync::atomic::Ordering::SeqCst);
                let (active_payload, etag) = if changed {
                    (upd_ref, "\"version-2-modified\"")
                } else {
                    (init_ref, "\"version-1-original\"")
                };

                if req_str.starts_with("HEAD") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: {}\r\n\r\n",
                        active_payload.len(), etag
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.starts_with("GET") {
                    let req_lower = req_str.to_ascii_lowercase();
                    if let Some(pos) = req_lower.find("range: bytes=") {
                        let range_str = &req_str[pos + 13..];
                        let line_end = range_str.find("\r\n").unwrap_or(range_str.len());
                        let range_val = &range_str[..line_end];
                        let parts: Vec<&str> = range_val.split('-').collect();
                        let start: usize = parts[0].trim().parse().unwrap_or(0);
                        let end: usize = if parts.len() > 1 && !parts[1].trim().is_empty() {
                            parts[1].trim().parse().unwrap_or(active_payload.len() - 1)
                        } else {
                            active_payload.len() - 1
                        };

                        let slice = &active_payload[start..=end];
                        let resp_hdr = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: {}\r\n\r\n",
                            start, end, active_payload.len(), slice.len(), etag
                        );
                        let _ = socket.write_all(resp_hdr.as_bytes()).await;
                        let _ = socket.write_all(slice).await;
                    }
                }
            });
        }
    });

    let temp_db_path = std::env::temp_dir().join(format!("mdm_etag_test_{}.db", uuid::Uuid::new_v4()));
    let temp_dir = std::env::temp_dir().join(format!("mdm_etag_dest_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let test_url = format!("http://{}/etag_change.bin", addr);

    let db = Arc::new(Database::new(&temp_db_path).unwrap());
    let engine = DownloadManager::new(Arc::clone(&db), 2);

    let task = engine.add_task(&test_url, &temp_dir.to_string_lossy(), 2).await.unwrap();
    let task_id = task.id.clone();
    let dest_path = task.destination_path.clone();

    // Pause while still downloading version 1
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    let _ = engine.pause_task(&task_id).await;

    // Now change the server resource (simulating remote file modification with new ETag)
    is_updated.store(true, std::sync::atomic::Ordering::SeqCst);

    // Resume the task. Engine must detect ETag mismatch, discard old partial chunks, and re-download version 2
    engine.resume_task(&task_id).await.unwrap();

    let start_wait = std::time::Instant::now();
    loop {
        let current_tasks = db.list_tasks().unwrap();
        let t = current_tasks.into_iter().find(|t| t.id == task_id).unwrap();
        if t.status == DownloadStatus::Completed {
            break;
        }
        if start_wait.elapsed() > std::time::Duration::from_secs(5) {
            panic!("Resumed download with changed ETag did not complete! Status: {:?}", t.status);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    // Verify the finalized file has Version 2's SHA-256 hash (not a corrupt mix of v1 and v2)
    let final_hash = DownloadWorker::compute_file_sha256(&dest_path).await.unwrap();
    assert_eq!(final_hash, updated_hash, "File contains stale version parts after ETag change!");

    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::remove_file(&temp_db_path);
}

#[tokio::test]
async fn test_video_tools_missing_detection_and_clear_error() {
    let empty_dir = std::env::temp_dir().join(format!("mdm_empty_tools_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&empty_dir).unwrap();

    // 1. Tool status should report not installed
    let status = mdm_lib::video::binaries::get_tool_status(&empty_dir).await;
    // (If not in PATH, both should be false; if user has them in PATH, it's ok, but local is not found)
    assert!(status.ytdlp_path.as_deref().map(|p| !p.starts_with(empty_dir.to_str().unwrap())).unwrap_or(true));

    // 2. Probing with non-existent yt-dlp path must return clear error message
    let dummy_nonexistent_dir = empty_dir.join("nonexistent_sub");
    // Explicitly test analyzer with empty dir
    let err = mdm_lib::video::analyzer::analyze_video_url(&dummy_nonexistent_dir, "https://www.youtube.com/watch?v=dummy").await;
    // If yt-dlp is not in PATH, it should be an Err
    if status.ytdlp_path.is_none() {
        assert!(err.is_err());
        let err_msg = err.unwrap_err();
        assert!(err_msg.contains("yt-dlp bulunamadı") || err_msg.contains("Geçersiz"));
    }

    let _ = std::fs::remove_dir_all(&empty_dir);
}

#[tokio::test]
async fn test_video_url_validation_and_unsupported_schemes() {
    let temp_dir = std::env::temp_dir().join(format!("mdm_url_val_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();

    // Invalid URL string
    let res1 = mdm_lib::video::analyzer::analyze_video_url(&temp_dir, "not-a-valid-url").await;
    assert!(res1.is_err());
    assert_eq!(res1.unwrap_err(), "Geçersiz web adresi.");

    // Unsupported scheme (ftp)
    let res2 = mdm_lib::video::analyzer::analyze_video_url(&temp_dir, "ftp://example.com/video.mp4").await;
    assert!(res2.is_err());
    assert_eq!(res2.unwrap_err(), "Yalnızca HTTP ve HTTPS video bağlantıları desteklenir.");

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_video_manager_cancellation_and_cleanup() {
    let temp_db_path = std::env::temp_dir().join(format!("mdm_video_mgr_{}.db", uuid::Uuid::new_v4()));
    let temp_dir = std::env::temp_dir().join(format!("mdm_video_dest_{}", uuid::Uuid::new_v4()));
    let bin_dir = std::env::temp_dir().join(format!("mdm_video_bin_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();

    let db = Arc::new(Database::new(&temp_db_path).unwrap());
    let video_manager = mdm_lib::video::VideoManager::new(Arc::clone(&db), bin_dir.clone());

    // Test canceling a non-existent task is safe (does not panic)
    let res = video_manager.cancel_video_task("nonexistent-id").await;
    assert!(res.is_ok());

    // Test pausing a non-existent task is safe (does not panic)
    let res_pause = video_manager.pause_video_task("nonexistent-id").await;
    assert!(res_pause.is_ok());

    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::remove_dir_all(&bin_dir);
    let _ = std::fs::remove_file(&temp_db_path);
}

#[test]
fn test_native_messaging_framing_read_write() {
    let payload = serde_json::json!({
        "type": "ping"
    });

    let mut buffer = Vec::new();
    mdm_lib::native_messaging::write_native_packet(&mut buffer, &payload).expect("Write failed");

    // Length prefix should be 4 bytes
    assert!(buffer.len() > 4);
    let length_prefix = u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
    assert_eq!(length_prefix, buffer.len() - 4);

    let mut cursor = std::io::Cursor::new(buffer);
    let read_back = mdm_lib::native_messaging::read_native_packet(&mut cursor).expect("Read failed");
    assert_eq!(read_back["type"], "ping");
}

#[test]
fn test_native_messaging_oversized_packet_rejected() {
    // Fabricate a packet with length prefix exceeding 1 MB (e.g. 2 MB)
    let bad_len = (2 * 1024 * 1024u32).to_le_bytes();
    let mut cursor = std::io::Cursor::new(bad_len);
    let res = mdm_lib::native_messaging::read_native_packet(&mut cursor);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("exceeds max allowed size"));
}

#[tokio::test]
async fn test_native_messaging_handle_requests_and_duplicate_detection() {
    use mdm_lib::native_messaging::{handle_extension_request, ExtensionRequest, ExtensionResponse};

    let temp_db_path = std::env::temp_dir().join(format!("mdm_native_msg_{}.db", uuid::Uuid::new_v4()));
    let temp_dest = std::env::temp_dir().join(format!("mdm_native_dest_{}", uuid::Uuid::new_v4()));
    let bin_dir = std::env::temp_dir().join(format!("mdm_native_bin_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dest).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();

    let db = Arc::new(Database::new(&temp_db_path).unwrap());

    // 1. Test Ping
    let pong = handle_extension_request(
        Arc::clone(&db),
        &bin_dir,
        &temp_dest.to_string_lossy(),
        ExtensionRequest::Ping,
    ).await;
    match pong {
        ExtensionResponse::Pong { version, .. } => {
            assert_eq!(version, mdm_lib::native_messaging::PROTOCOL_VERSION);
        }
        _ => panic!("Expected Pong response!"),
    }

    // 2. Test Invalid URL
    let bad_url_resp = handle_extension_request(
        Arc::clone(&db),
        &bin_dir,
        &temp_dest.to_string_lossy(),
        ExtensionRequest::AddDownload {
            url: "not-a-valid-url".to_string(),
            filename: None,
            destination_dir: None,
            referrer: None,
            cookies: None,
            user_agent: None,
        },
    ).await;
    match bad_url_resp {
        ExtensionResponse::Error { code, .. } => {
            assert_eq!(code, "INVALID_URL");
        }
        _ => panic!("Expected INVALID_URL error!"),
    }

    // 3. Test Unsupported Scheme (ftp)
    let ftp_resp = handle_extension_request(
        Arc::clone(&db),
        &bin_dir,
        &temp_dest.to_string_lossy(),
        ExtensionRequest::AddDownload {
            url: "ftp://files.example.com/archive.zip".to_string(),
            filename: None,
            destination_dir: None,
            referrer: None,
            cookies: None,
            user_agent: None,
        },
    ).await;
    match ftp_resp {
        ExtensionResponse::Error { code, .. } => {
            assert_eq!(code, "UNSUPPORTED_SCHEME");
        }
        _ => panic!("Expected UNSUPPORTED_SCHEME error!"),
    }

    // 4. Test Add Download
    let add_resp = handle_extension_request(
        Arc::clone(&db),
        &bin_dir,
        &temp_dest.to_string_lossy(),
        ExtensionRequest::AddDownload {
            url: "https://example.com/test_file.iso".to_string(),
            filename: Some("test_file.iso".to_string()),
            destination_dir: Some(temp_dest.to_string_lossy().to_string()),
            referrer: None,
            cookies: None,
            user_agent: None,
        },
    ).await;

    let created_task_id = match add_resp {
        ExtensionResponse::DownloadAdded { task_id, filename, status } => {
            assert_eq!(filename, "test_file.iso");
            assert!(status == "queued" || status == "dialog_opened");
            task_id
        }
        _ => panic!("Expected DownloadAdded response!"),
    };

    // Verify task exists in SQLite
    let tasks = db.list_tasks().unwrap();
    assert!(tasks.iter().any(|t| t.id == created_task_id));

    // 5. Test Duplicate URL Detection
    let dup_resp = handle_extension_request(
        Arc::clone(&db),
        &bin_dir,
        &temp_dest.to_string_lossy(),
        ExtensionRequest::AddDownload {
            url: "https://example.com/test_file.iso".to_string(),
            filename: Some("test_file.iso".to_string()),
            destination_dir: Some(temp_dest.to_string_lossy().to_string()),
            referrer: None,
            cookies: None,
            user_agent: None,
        },
    ).await;

    match dup_resp {
        ExtensionResponse::DuplicateIgnored { task_id, .. } => {
            assert_eq!(task_id, created_task_id);
        }
        _ => panic!("Expected DuplicateIgnored response!"),
    }

    let _ = std::fs::remove_dir_all(&temp_dest);
    let _ = std::fs::remove_dir_all(&bin_dir);
    let _ = std::fs::remove_file(&temp_db_path);
}

#[tokio::test]
async fn test_native_messaging_queue_integration_and_security() {
    let temp_db_path = std::env::temp_dir().join(format!("mdm_test_nm_queue_{}.db", uuid::Uuid::new_v4()));
    let db = Arc::new(Database::new(&temp_db_path).unwrap());
    let bin_dir = std::env::temp_dir().join(format!("mdm_test_nm_bin_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&bin_dir).unwrap();
    let temp_dest = std::env::temp_dir().join(format!("mdm_test_nm_dest_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dest).unwrap();

    // Setup local HTTP server for probe
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let test_url = format!("http://127.0.0.1:{}/sample.bin", port);

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let body = b"HELLO_MDM_NATIVE_MESSAGING";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.write_all(body).await;
            });
        }
    });

    // Initialize DownloadManager with 2 slots
    let engine = Arc::new(DownloadManager::new(Arc::clone(&db), 2));

    // 1. Add download via native messaging handler with non-existent destination (should fallback safely)
    let bad_dest = "Z:\\NonExistentDrive\\SecretPath";
    let resp = mdm_lib::native_messaging::handle_extension_request(
        Arc::clone(&db),
        &bin_dir,
        &temp_dest.to_string_lossy(),
        mdm_lib::native_messaging::ExtensionRequest::AddDownload {
            url: test_url.clone(),
            filename: Some("sample.bin".to_string()),
            destination_dir: Some(bad_dest.to_string()),
            referrer: None,
            cookies: None,
            user_agent: None,
        },
    ).await;

    let task_id = match resp {
        mdm_lib::native_messaging::ExtensionResponse::DownloadAdded { task_id, filename, status } => {
            assert_eq!(filename, "sample.bin");
            assert!(status == "queued" || status == "dialog_opened");
            task_id
        }
        _ => panic!("Expected DownloadAdded!"),
    };

    // Verify task path fell back to valid temp_dest instead of bad_dest
    let tasks = db.list_tasks().unwrap();
    let task = tasks.iter().find(|t| t.id == task_id).unwrap();
    assert!(task.destination_path.starts_with(&temp_dest.to_string_lossy().to_string()));

    // 2. Verify duplicate prevention
    let dup_resp = mdm_lib::native_messaging::handle_extension_request(
        Arc::clone(&db),
        &bin_dir,
        &temp_dest.to_string_lossy(),
        mdm_lib::native_messaging::ExtensionRequest::AddDownload {
            url: test_url.clone(),
            filename: Some("sample.bin".to_string()),
            destination_dir: None,
            referrer: None,
            cookies: None,
            user_agent: None,
        },
    ).await;

    match dup_resp {
        mdm_lib::native_messaging::ExtensionResponse::DuplicateIgnored { task_id: dup_id, .. } => {
            assert_eq!(dup_id, task_id);
        }
        _ => panic!("Expected DuplicateIgnored!"),
    }

    // 3. Process queue in DownloadManager and verify it executes the queued task from DB
    engine.process_queue().await;
    tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;

    // Verify completion
    let updated_tasks = db.list_tasks().unwrap();
    let updated_task = updated_tasks.iter().find(|t| t.id == task_id).unwrap();
    assert_eq!(updated_task.status, DownloadStatus::Completed);
    assert_eq!(updated_task.downloaded_bytes, 26);

    let _ = std::fs::remove_dir_all(&temp_dest);
    let _ = std::fs::remove_dir_all(&bin_dir);
    let _ = std::fs::remove_file(&temp_db_path);
}







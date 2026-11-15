use crate::engine::task::SegmentProgress;

pub fn plan_segments(total_bytes: Option<u64>, requested_segments: usize, supports_range: bool) -> Vec<SegmentProgress> {
    let count = requested_segments.clamp(1, 16);

    let total = match total_bytes {
        Some(t) if supports_range && t >= 1024 * 64 => t,
        _ => {
            // Single stream fallback if range is unsupported or size unknown
            return vec![SegmentProgress {
                index: 0,
                start_byte: 0,
                end_byte: total_bytes.unwrap_or(0),
                downloaded_bytes: 0,
                completed: false,
            }];
        }
    };

    let part_size = total / (count as u64);
    let mut segments = Vec::with_capacity(count);

    for i in 0..count {
        let start = (i as u64) * part_size;
        let end = if i == count - 1 {
            total - 1 // Last segment takes the remainder
        } else {
            start + part_size - 1
        };

        segments.push(SegmentProgress {
            index: i,
            start_byte: start,
            end_byte: end,
            downloaded_bytes: 0,
            completed: false,
        });
    }

    segments
}

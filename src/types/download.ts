export type DownloadStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SegmentProgress {
  index: number;
  start_byte: number;
  end_byte: number;
  downloaded_bytes: number;
  completed: boolean;
}

export interface DownloadTask {
  id: string;
  url: string;
  filename: string;
  destination_path: string;
  total_bytes: number | null;
  downloaded_bytes: number;
  speed_bytes_per_sec: number;
  eta_seconds: number | null;
  status: DownloadStatus;
  error_message: string | null;
  supports_range: boolean;
  segment_count: number;
  segments: SegmentProgress[];
  etag: string | null;
  last_modified: string | null;
  created_at: string;
  completed_at: string | null;
  cookies?: string | null;
  referrer?: string | null;
  user_agent?: string | null;
  merging?: boolean;
  merge_progress?: number;
}

export interface EngineStats {
  total_download_speed: number;
  active_downloads: number;
  queued_downloads: number;
  completed_downloads: number;
}

export interface AppSettings {
  default_download_dir: string;
  max_concurrent_downloads: number;
  default_segments: number;
  global_speed_limit_bytes: number | null;
  theme: 'dark' | 'light';
}

export type FilterCategory =
  | 'all'
  | 'downloading'
  | 'completed'
  | 'queued'
  | 'failed'
  | 'video';

export interface VideoQualityOption {
  id: string;
  label: string;
  format_spec: string;
  extension: string;
  height: number | null;
  is_audio_only: boolean;
  filesize_approx: number | null;
}

export interface VideoAnalysisResult {
  url: string;
  title: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  qualities: VideoQualityOption[];
}

export interface ToolStatus {
  ytdlp_installed: boolean;
  ytdlp_version: string | null;
  ytdlp_path: string | null;
  ffmpeg_installed: boolean;
  ffmpeg_version: string | null;
  ffmpeg_path: string | null;
}

export interface DownloadProbeInfo {
  url: string;
  filename: string;
  total_bytes: number | null;
  formatted_size: string;
  supports_range: boolean;
  suggested_path: string;
  category: string;
}

export interface AppUpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_notes: string;
  download_url: string | null;
  sha256: string | null;
  published_at: string | null;
}



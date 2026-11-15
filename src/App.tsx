import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { Navbar } from './components/Navbar';
import { DownloadTable } from './components/DownloadTable';
import { AddDownloadModal } from './components/AddDownloadModal';
import { SettingsModal } from './components/SettingsModal';
import { DownloadProgressModal } from './components/DownloadProgressModal';
import {
  DownloadTask,
  FilterCategory,
  AppSettings,
  DownloadProbeInfo,
  AppUpdateInfo,
} from './types/download';
import {
  INITIAL_MOCK_TASKS,
  INITIAL_MOCK_SETTINGS,
} from './mock/mockData';

// Tauri API dynamic loader
const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

async function invokeTauri<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  throw new Error('Not running in Tauri');
}

async function openCompactWindow(title = 'Dosya İndirme Bilgisi', width = 520, height = 340) {
  if (!isTauri) return;
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    const win = getCurrentWebviewWindow();
    await win.setTitle(title);
    await win.show();
    await win.unminimize();
    await win.setSize(new LogicalSize(width, height));
    await win.center();
    await win.setAlwaysOnTop(true);
    await win.setFocus();
  } catch (e) {
    console.error(e);
  }
}

async function restoreDashboardWindow() {
  if (!isTauri) return;
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    const win = getCurrentWebviewWindow();
    await win.setTitle('Mak Download Manager (MDM)');
    await win.setAlwaysOnTop(false);
    await win.show();
    await win.unminimize();
    await win.setSize(new LogicalSize(1150, 740));
    await win.center();
    await win.setFocus();
  } catch (e) {
    console.error(e);
  }
}

async function hideCompactWindow() {
  if (!isTauri) return;
  try {
    await invokeTauri('close_compact_dialog');
  } catch (e) {
    console.error(e);
  }
}

export const App: React.FC = () => {
  const shotParams = useMemo(() => {
    if (isTauri || typeof window === 'undefined') {
      return { shot: null as string | null, theme: null as 'dark' | 'light' | null };
    }
    const params = new URLSearchParams(window.location.search);
    const shot = params.get('shot');
    const t = params.get('theme');
    return {
      shot,
      theme: (t === 'light' || t === 'dark' ? t : null) as 'dark' | 'light' | null,
    };
  }, []);

  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [activeCategory, setActiveCategory] = useState<FilterCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(
    shotParams.shot === 'confirm-video' || shotParams.shot === 'confirm-file'
  );
  const [pendingDownload, setPendingDownload] = useState<{
    url?: string;
    filename?: string;
    destinationDir?: string;
    segments?: number;
    mode?: 'file' | 'video';
    videoData?: any;
    cookies?: string;
    referrer?: string;
    userAgent?: string;
    error?: string;
  } | null>(() => {
    if (shotParams.shot === 'confirm-video') {
      return {
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        filename: 'Big Buck Bunny 60fps 4K - Blender Open Movie.mp4',
        destinationDir: 'C:\\Users\\MertAli\\Downloads',
        mode: 'video',
        videoData: {
          url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
          title: 'Big Buck Bunny 60fps 4K - Blender Open Movie',
          duration_seconds: 634,
          thumbnail_url: null,
          qualities: [
            {
              id: '1080p',
              label: '1080p Full HD',
              format_spec: 'bestvideo[height<=1080]+bestaudio/best',
              extension: 'mp4',
              height: 1080,
              is_audio_only: false,
              filesize_approx: 153931776,
            },
            {
              id: '720p',
              label: '720p HD',
              format_spec: 'bestvideo[height<=720]+bestaudio/best',
              extension: 'mp4',
              height: 720,
              is_audio_only: false,
              filesize_approx: 89128960,
            },
            {
              id: '480p',
              label: '480p SD',
              format_spec: 'bestvideo[height<=480]+bestaudio/best',
              extension: 'mp4',
              height: 480,
              is_audio_only: false,
              filesize_approx: 47185920,
            },
            {
              id: 'audio_only',
              label: 'Yalnızca Ses (En Yüksek - M4A)',
              format_spec: 'bestaudio/best',
              extension: 'm4a',
              height: null,
              is_audio_only: true,
              filesize_approx: 12582912,
            },
          ],
        },
      };
    }
    if (shotParams.shot === 'confirm-file') {
      return {
        url: 'https://releases.ubuntu.com/24.04.1/ubuntu-24.04.1-desktop-amd64.iso',
        filename: 'ubuntu-24.04.1-desktop-amd64.iso',
        destinationDir: 'C:\\Users\\MertAli\\Downloads',
        segments: 8,
        mode: 'file',
      };
    }
    return null;
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(shotParams.shot === 'settings');
  const [settings, setSettings] = useState<AppSettings>(INITIAL_MOCK_SETTINGS);
  const [theme, setTheme] = useState<'dark' | 'light'>(shotParams.theme || 'dark');
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [dismissedUpdateBanner, setDismissedUpdateBanner] = useState(false);
  const [isCompactDialogMode, setIsCompactDialogMode] = useState(
    shotParams.shot === 'confirm-video' ||
    shotParams.shot === 'confirm-file' ||
    shotParams.shot === 'progress'
  );
  const [activeProcessTaskId, setActiveProcessTaskId] = useState<string | null>(
    shotParams.shot === 'progress' ? 'mock-1' : null
  );

  // Sync theme with DOM
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // Check if there was a pending download from external extension invocation
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      try {
        const pending = await invokeTauri<any>('check_pending_confirm');
        if (pending && pending.url) {
          const isVideoMode =
            pending.mode === 'video' ||
            /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitter\.com|x\.com)/i.test(pending.url);
          setPendingDownload({
            url: pending.url,
            filename: pending.filename || undefined,
            destinationDir: pending.destination_dir || undefined,
            segments: pending.segments || undefined,
            mode: isVideoMode ? 'video' : 'file',
            videoData: pending.video_data || undefined,
            cookies: pending.cookies || undefined,
            referrer: pending.referrer || undefined,
            userAgent: pending.user_agent || undefined,
            error: pending.error || undefined,
          });
          setIsAddModalOpen(true);
          setIsCompactDialogMode(true);
          await openCompactWindow('Dosya İndirme Bilgisi', 520, 340);
        }
      } catch (err) {
        console.warn('check_pending_confirm check error:', err);
      }
    })();
  }, []);

  // Load initial tasks & settings
  const refreshTasks = useCallback(async () => {
    if (isTauri) {
      try {
        const loadedTasks = await invokeTauri<DownloadTask[]>('get_downloads');
        setTasks((prev) =>
          loadedTasks.map((loaded) => {
            const existing = prev.find((p) => p.id === loaded.id);
            if (existing && loaded.status === 'downloading') {
              const maxDownloaded = Math.max(loaded.downloaded_bytes || 0, existing.downloaded_bytes || 0);
              const total = loaded.total_bytes || existing.total_bytes || null;
              return {
                ...loaded,
                downloaded_bytes: maxDownloaded,
                total_bytes: total,
                speed_bytes_per_sec: existing.speed_bytes_per_sec || loaded.speed_bytes_per_sec,
                eta_seconds: existing.eta_seconds ?? loaded.eta_seconds,
                merging: existing.merging,
                merge_progress: existing.merge_progress,
              };
            }
            return loaded;
          })
        );
        const loadedSettings = await invokeTauri<AppSettings>('get_settings');
        setSettings(loadedSettings);
        setTheme(loadedSettings.theme);
      } catch (err) {
        console.error('Failed to load tasks from Tauri engine:', err);
      }
    } else {
      // Running in browser dev mode: load mock tasks
      setTasks(INITIAL_MOCK_TASKS);
    }
  }, []);

  useEffect(() => {
    refreshTasks();
  }, [refreshTasks]);

  // Setup Tauri event listeners for live progress & external download confirmation
  useEffect(() => {
    if (!isTauri) return;

    let unlistenProgress: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenConfirm: (() => void) | undefined;
    let unlistenDashboard: (() => void) | undefined;
    let unlistenCloseRequested: (() => void) | undefined;
    let unlistenUpdateAvailable: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenProgress = await listen<any>('download-progress', (event) => {
          const payload = event.payload;
          setTasks((prev) =>
            prev.map((t) =>
              t.id === payload.id
                ? {
                  ...t,
                  downloaded_bytes: payload.downloaded_bytes,
                  total_bytes: payload.total_bytes ?? t.total_bytes,
                  speed_bytes_per_sec: payload.speed_bytes_per_sec,
                  eta_seconds: payload.eta_seconds,
                  segments: payload.segments && payload.segments.length > 0 ? payload.segments : t.segments,
                  merging: Boolean(payload.merging),
                  merge_progress:
                    typeof payload.merge_progress === 'number'
                      ? payload.merge_progress
                      : payload.merging
                        ? t.merge_progress
                        : undefined,
                }
                : t
            )
          );
        });

        unlistenStatus = await listen<string>('download-status-changed', () => {
          refreshTasks();
        });

        unlistenCloseRequested = await listen('window-close-requested', () => {
          setIsCompactDialogMode(false);
          setIsAddModalOpen(false);
          setPendingDownload(null);
          setActiveProcessTaskId(null);
        });

        // Listen for IDM-style external download confirmation requests (e.g. from Chrome extension)
        unlistenConfirm = await listen<any>('open-download-confirm', async (event) => {
          const payload = event.payload;
          if (payload && payload.url) {
            const isVideoMode =
              payload.mode === 'video' ||
              /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitter\.com|x\.com)/i.test(payload.url);

            setPendingDownload({
              url: payload.url,
              filename: payload.filename || undefined,
              destinationDir: payload.destination_dir || undefined,
              segments: payload.segments || undefined,
              mode: isVideoMode ? 'video' : 'file',
              videoData: payload.video_data || undefined,
              cookies: payload.cookies || undefined,
              referrer: payload.referrer || undefined,
              userAgent: payload.user_agent || undefined,
              error: payload.error || undefined,
            });
            setIsAddModalOpen(true);
            setIsCompactDialogMode(true);

            await openCompactWindow('Dosya İndirme Bilgisi', 520, 340);
          }
        });

        // Restore full dashboard size when clicking tray icon
        unlistenDashboard = await listen('open-dashboard', async () => {
          setIsCompactDialogMode(false);
          setIsAddModalOpen(false);
          setPendingDownload(null);
          setActiveProcessTaskId(null);
          await restoreDashboardWindow();
        });

        // Listen for background GitHub update notifications
        unlistenUpdateAvailable = await listen<AppUpdateInfo>('app-update-available', (event) => {
          if (event.payload?.update_available) {
            setAvailableUpdate(event.payload);
            setDismissedUpdateBanner(false);
          }
        });
      } catch (err) {
        console.error('Error setting up Tauri event listeners:', err);
      }
    })();

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenStatus) unlistenStatus();
      if (unlistenConfirm) unlistenConfirm();
      if (unlistenDashboard) unlistenDashboard();
      if (unlistenCloseRequested) unlistenCloseRequested();
      if (unlistenUpdateAvailable) unlistenUpdateAvailable();
    };
  }, [refreshTasks]);

  // Probe file information (IDM style: file size, range support, filename, category)
  const handleProbeDownload = async (
    url: string,
    cookies?: string,
    referrer?: string,
    userAgent?: string
  ): Promise<DownloadProbeInfo> => {
    if (isTauri) {
      return invokeTauri<DownloadProbeInfo>('probe_download_info', {
        url,
        cookies: cookies || null,
        referrer: referrer || null,
        userAgent: userAgent || null,
      });
    }
    // Mock probe for browser dev mode
    const cleanFn = url.split('/').pop()?.split('?')[0] || 'indirilen_dosya.zip';
    const ext = cleanFn.split('.').pop()?.toLowerCase() || '';
    let category = 'general';
    if (['mp4', 'mkv', 'avi'].includes(ext)) category = 'video';
    else if (['zip', 'rar', '7z', 'iso'].includes(ext)) category = 'compressed';
    else if (['exe', 'msi'].includes(ext)) category = 'program';
    else if (['pdf', 'docx'].includes(ext)) category = 'document';

    const isUbuntuIso = cleanFn.toLowerCase().includes('ubuntu-24.04.1');
    return {
      url,
      filename: cleanFn,
      total_bytes: isUbuntuIso ? 6023307264 : 425984000,
      formatted_size: isUbuntuIso ? '5.61 GB' : '406.25 MB',
      supports_range: true,
      suggested_path: `${settings.default_download_dir}\\${cleanFn}`,
      category,
    };
  };

  // Add download with start options (Start Now vs Download Later)
  const handleAddDownloadWithOptions = async (
    url: string,
    filename?: string,
    destinationDir?: string,
    segments?: number,
    startImmediately = true,
    cookies?: string,
    referrer?: string,
    userAgent?: string
  ): Promise<DownloadTask> => {
    if (isTauri) {
      const task = await invokeTauri<DownloadTask>('add_download_with_options', {
        url,
        filename: filename || null,
        destinationDir: destinationDir || null,
        segments: segments || null,
        startImmediately,
        cookies: cookies || null,
        referrer: referrer || null,
        userAgent: userAgent || null,
      });
      await refreshTasks();
      return task;
    } else {
      // Mock add
      const fn = filename || url.split('/').pop()?.split('?')[0] || 'download.zip';
      const newTask: DownloadTask = {
        id: `mock-${Date.now()}`,
        url,
        filename: fn,
        destination_path: `${destinationDir || settings.default_download_dir}\\${fn}`,
        total_bytes: 104857600,
        downloaded_bytes: 0,
        speed_bytes_per_sec: startImmediately ? 12500000 : 0,
        eta_seconds: startImmediately ? 8 : null,
        status: startImmediately ? 'downloading' : 'paused',
        error_message: null,
        supports_range: true,
        segment_count: segments || settings.default_segments || 8,
        segments: [],
        etag: null,
        last_modified: null,
        created_at: new Date().toISOString(),
        completed_at: null,
      };
      setTasks((prev) => [newTask, ...prev]);
      return newTask;
    }
  };

  // Legacy task add action
  const handleAddDownload = async (url: string, destinationDir?: string, segments?: number): Promise<DownloadTask> => {
    return await handleAddDownloadWithOptions(url, undefined, destinationDir, segments, true);
  };

  const handlePause = async (id: string) => {
    if (isTauri) {
      await invokeTauri('pause_download', { id });
      await refreshTasks();
    } else {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: 'paused', speed_bytes_per_sec: 0 } : t))
      );
    }
  };

  const handleResume = async (id: string) => {
    if (isTauri) {
      await invokeTauri('resume_download', { id });
      await refreshTasks();
    } else {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, status: 'downloading', speed_bytes_per_sec: 18000000 } : t
        )
      );
    }
  };

  const handleRetry = async (id: string) => {
    if (isTauri) {
      await invokeTauri('retry_download', { id });
      await refreshTasks();
    } else {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status: 'downloading', error_message: null, speed_bytes_per_sec: 15000000 }
            : t
        )
      );
    }
  };

  const handleRemove = async (id: string) => {
    if (isTauri) {
      await invokeTauri('remove_download', { id, deleteFile: false });
      await refreshTasks();
    } else {
      setTasks((prev) => prev.filter((t) => t.id !== id));
    }
  };

  const handleCancel = async (id: string) => {
    if (isTauri) {
      await invokeTauri('cancel_download', { id });
      await refreshTasks();
    } else {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: 'cancelled', speed_bytes_per_sec: 0 } : t))
      );
    }
  };

  const handleOpenFolder = async (path: string) => {
    if (isTauri) {
      try {
        await invokeTauri('open_file_location', { path });
      } catch (err) {
        alert(String(err));
      }
    } else {
      alert(`[Dev Mock] Opening file folder: ${path}`);
    }
  };

  const handleOpenFile = async (path: string) => {
    if (isTauri) {
      try {
        await invokeTauri('open_file', { path });
      } catch (err) {
        alert(String(err));
      }
    } else {
      alert(`[Dev Mock] Opening file: ${path}`);
    }
  };

  const handlePauseAll = async () => {
    for (const t of tasks.filter((t) => t.status === 'downloading')) {
      await handlePause(t.id);
    }
  };

  const handleResumeAll = async () => {
    for (const t of tasks.filter((t) => t.status === 'paused' || t.status === 'queued')) {
      await handleResume(t.id);
    }
  };

  const handleClearCompleted = async () => {
    const completed = tasks.filter((t) => t.status === 'completed');
    for (const t of completed) {
      await handleRemove(t.id);
    }
  };

  const handleSaveSettings = async (newSettings: AppSettings) => {
    setSettings(newSettings);
    setTheme(newSettings.theme);
    if (isTauri) {
      await invokeTauri('update_settings', { settings: newSettings });
    }
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    handleSaveSettings({ ...settings, theme: next });
  };

  const handleProbeVideo = async (
    url: string,
    cookies?: string,
    referrer?: string,
    userAgent?: string,
    fallbackTitle?: string
  ) => {
    if (isTauri) {
      return await invokeTauri<import('./types/download').VideoAnalysisResult>('probe_video_info', {
        url,
        cookies: cookies || null,
        referrer: referrer || null,
        userAgent: userAgent || null,
        fallbackTitle: fallbackTitle || null,
      });
    }
    return {
      url,
      title: 'Örnek 4K Video Akışı (Sample)',
      duration_seconds: 345,
      thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600&auto=format&fit=crop&q=80',
      qualities: [
        { id: '1080p', label: '1080p Full HD', format_spec: 'bestvideo[height<=1080]+bestaudio/best', extension: 'mp4', height: 1080, is_audio_only: false, filesize_approx: 154000000 },
        { id: '720p', label: '720p HD', format_spec: 'bestvideo[height<=720]+bestaudio/best', extension: 'mp4', height: 720, is_audio_only: false, filesize_approx: 85000000 },
        { id: '480p', label: '480p SD', format_spec: 'bestvideo[height<=480]+bestaudio/best', extension: 'mp4', height: 480, is_audio_only: false, filesize_approx: 45000000 },
        { id: 'audio_only', label: 'Yalnızca Ses (En Yüksek - M4A)', format_spec: 'bestaudio/best', extension: 'm4a', height: null, is_audio_only: true, filesize_approx: 12000000 },
      ],
    };
  };

  const handleAddVideoDownload = async (
    url: string,
    title: string,
    formatSpec: string,
    extension: string,
    isAudioOnly: boolean,
    destinationDir?: string,
    totalBytes?: number,
    cookies?: string,
    referrer?: string,
    userAgent?: string
  ): Promise<DownloadTask> => {
    if (isTauri) {
      const task = await invokeTauri<DownloadTask>('add_video_download', {
        url,
        title,
        formatSpec,
        extension,
        isAudioOnly,
        destinationDir,
        totalBytes: totalBytes || null,
        cookies: cookies || null,
        referrer: referrer || null,
        userAgent: userAgent || null,
      });
      await refreshTasks();
      return task;
    } else {
      const filename = `${title.replace(/[^a-zA-Z0-9_\-]/g, '_')}.${extension}`;
      const newTask: DownloadTask = {
        id: `video-${Date.now()}`,
        url,
        filename,
        destination_path: `${settings.default_download_dir}\\${filename}`,
        total_bytes: totalBytes || 85000000,
        downloaded_bytes: 0,
        speed_bytes_per_sec: 14000000,
        eta_seconds: 6,
        status: 'downloading',
        error_message: null,
        supports_range: false,
        segment_count: 1,
        segments: [],
        etag: `video:${isAudioOnly ? 'audio' : 'video'}:${formatSpec}`,
        last_modified: null,
        created_at: new Date().toISOString(),
        completed_at: null,
      };
      setTasks((prev) => [newTask, ...prev]);
      return newTask;
    }
  };

  const handleGetToolStatus = async () => {
    if (isTauri) {
      return await invokeTauri<import('./types/download').ToolStatus>('get_tool_status');
    }
    if (shotParams.shot === 'settings') {
      return {
        ytdlp_installed: true,
        ytdlp_version: '2025.02.19',
        ytdlp_path: 'C:\\Users\\MertAli\\AppData\\Local\\mdm\\bin\\yt-dlp.exe',
        ffmpeg_installed: true,
        ffmpeg_version: '7.1-essentials',
        ffmpeg_path: 'C:\\Users\\MertAli\\AppData\\Local\\mdm\\bin\\ffmpeg.exe',
      };
    }
    return {
      ytdlp_installed: false,
      ytdlp_version: null,
      ytdlp_path: null,
      ffmpeg_installed: false,
      ffmpeg_version: null,
      ffmpeg_path: null,
    };
  };

  const handleInstallYtdlp = async () => {
    if (isTauri) {
      return await invokeTauri<string>('install_or_update_ytdlp');
    }
    return '2024.12.23 (Simulated)';
  };

  const handleCloseAddModal = async (createdTask?: DownloadTask) => {
    setIsAddModalOpen(false);
    setPendingDownload(null);

    if (createdTask && createdTask.id) {
      setActiveProcessTaskId(createdTask.id);
      return;
    }

    if (isCompactDialogMode) {
      await hideCompactWindow();
      setIsCompactDialogMode(false);
    }
  };

  // Filter tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // Category filter
      if (activeCategory === 'downloading' && task.status !== 'downloading') return false;
      if (activeCategory === 'completed' && task.status !== 'completed') return false;
      if (activeCategory === 'queued' && task.status !== 'queued') return false;
      if (activeCategory === 'failed' && task.status !== 'failed' && task.status !== 'cancelled') return false;
      if (activeCategory === 'video') {
        const isVideo =
          /\.(mp4|mkv|webm|avi|mov|flv|m4a)$/i.test(task.filename) ||
          Boolean(task.etag && task.etag.startsWith('video:'));
        if (!isVideo) return false;
      }

      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return task.filename.toLowerCase().includes(q) || task.url.toLowerCase().includes(q);
      }

      return true;
    });
  }, [tasks, activeCategory, searchQuery]);

  // Aggregate stats
  const counts = useMemo(() => {
    return {
      all: tasks.length,
      downloading: tasks.filter((t) => t.status === 'downloading').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      queued: tasks.filter((t) => t.status === 'queued').length,
      failed: tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled').length,
      video: tasks.filter(
        (t) =>
          /\.(mp4|mkv|webm|avi|mov|flv|m4a)$/i.test(t.filename) ||
          Boolean(t.etag && t.etag.startsWith('video:'))
      ).length,
    };
  }, [tasks]);

  const totalSpeed = useMemo(() => {
    return tasks
      .filter((t) => t.status === 'downloading')
      .reduce((acc, t) => acc + (t.speed_bytes_per_sec || 0), 0);
  }, [tasks]);

  const activeProcessTask = useMemo(() => {
    return tasks.find((t) => t.id === activeProcessTaskId) || null;
  }, [tasks, activeProcessTaskId]);

  // IDM Standalone Compact Dialog Mode (when launched directly from browser button)
  if (isCompactDialogMode) {
    if (isAddModalOpen) {
      return (
        <div className="h-screen w-screen bg-[#f0f0f0] dark:bg-[#1f242b] text-slate-900 dark:text-slate-100 font-sans overflow-hidden select-none">
          <AddDownloadModal
            isOpen={true}
            isStandalone={true}
            onClose={handleCloseAddModal}
            onSubmit={handleAddDownload}
            onSubmitWithOptions={handleAddDownloadWithOptions}
            onProbeDownload={handleProbeDownload}
            onProbeVideo={handleProbeVideo}
            onSubmitVideo={handleAddVideoDownload}
            defaultDir={pendingDownload?.destinationDir || settings.default_download_dir}
            defaultSegments={settings.default_segments || 8}
            initialUrl={pendingDownload?.url}
            initialFilename={pendingDownload?.filename}
            initialMode={pendingDownload?.mode}
            initialVideoData={pendingDownload?.videoData}
            initialCookies={pendingDownload?.cookies}
            initialReferrer={pendingDownload?.referrer}
            initialUserAgent={pendingDownload?.userAgent}
            initialError={pendingDownload?.error}
          />
        </div>
      );
    }

    if (activeProcessTask) {
      return (
        <div className="h-screen w-screen bg-[#f0f0f0] dark:bg-[#1f242b] text-slate-900 dark:text-slate-100 font-sans overflow-hidden select-none">
          <DownloadProgressModal
            isOpen={true}
            isStandalone={true}
            task={activeProcessTask}
            onClose={async () => {
              setActiveProcessTaskId(null);
              setIsCompactDialogMode(false);
              await hideCompactWindow();
            }}
            onPause={handlePause}
            onResume={handleResume}
            onCancel={handleCancel}
            onOpenFile={handleOpenFile}
            onOpenFolder={handleOpenFolder}
          />
        </div>
      );
    }

    return <div className="h-screen w-screen bg-[#f0f0f0] dark:bg-[#1f242b]" />;
  }

  return (
    <div className="flex h-screen w-screen bg-[#f5f6f8] dark:bg-[#181b20] text-slate-900 dark:text-slate-100 font-sans overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        activeCategory={activeCategory}
        onSelectCategory={setActiveCategory}
        counts={counts}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-[#181b20]">
        {/* Top Navbar */}
        <Navbar
          onOpenAddModal={() => setIsAddModalOpen(true)}
          onPauseAll={handlePauseAll}
          onResumeAll={handleResumeAll}
          onClearCompleted={handleClearCompleted}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          totalSpeed={totalSpeed}
          activeCount={counts.downloading}
        />

        {/* Development mode banner if running outside Tauri */}
        {!isTauri && !shotParams.shot && (
          <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 px-4 py-1 flex items-center justify-between text-[11px] text-amber-800 dark:text-amber-300">
            <span>
              Tarayıcı Önizleme Modu: Örnek veriler gösteriliyor. Gerçek indirme motoru masaüstü uygulamasında çalışır.
            </span>
          </div>
        )}

        {/* App Update Notification Banner */}
        {availableUpdate && availableUpdate.update_available && !dismissedUpdateBanner && (
          <div className="bg-emerald-50 dark:bg-emerald-950/40 border-b border-emerald-200 dark:border-emerald-800 px-4 py-1.5 flex items-center justify-between text-xs text-emerald-900 dark:text-emerald-200">
            <span className="font-medium">
              Yeni MDM sürümü mevcut: <strong className="font-mono">v{availableUpdate.latest_version}</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-medium"
              >
                Güncelle
              </button>
              <button
                type="button"
                onClick={() => setDismissedUpdateBanner(true)}
                className="px-1.5 py-0.5 rounded hover:bg-emerald-200/60 dark:hover:bg-emerald-900 text-emerald-700 dark:text-emerald-300 font-bold"
                title="Kapat"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* Download Table */}
        <DownloadTable
          tasks={filteredTasks}
          onPause={handlePause}
          onResume={handleResume}
          onRetry={handleRetry}
          onCancel={handleCancel}
          onRemove={handleRemove}
          onOpenFolder={handleOpenFolder}
          onOpenFile={handleOpenFile}
          onSelectTask={(task) => setActiveProcessTaskId(task.id)}
        />
      </div>

      {/* Modals */}
      <AddDownloadModal
        isOpen={isAddModalOpen}
        onClose={handleCloseAddModal}
        onSubmit={handleAddDownload}
        onSubmitWithOptions={handleAddDownloadWithOptions}
        onProbeDownload={handleProbeDownload}
        onProbeVideo={handleProbeVideo}
        onSubmitVideo={handleAddVideoDownload}
        defaultDir={settings.default_download_dir}
        defaultSegments={settings.default_segments || 8}
        initialUrl={pendingDownload?.url}
        initialFilename={pendingDownload?.filename}
        initialMode={pendingDownload?.mode}
        initialVideoData={pendingDownload?.videoData}
        initialCookies={pendingDownload?.cookies}
        initialReferrer={pendingDownload?.referrer}
        initialUserAgent={pendingDownload?.userAgent}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
        onGetToolStatus={handleGetToolStatus}
        onInstallYtdlp={handleInstallYtdlp}
        initialUpdateInfo={availableUpdate}
      />

      {/* IDM Download Progress / Completion Modal (when viewed from dashboard) */}
      {activeProcessTask && !isCompactDialogMode && (
        <DownloadProgressModal
          isOpen={true}
          isStandalone={false}
          task={activeProcessTask}
          onClose={() => setActiveProcessTaskId(null)}
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancel}
          onOpenFile={handleOpenFile}
          onOpenFolder={handleOpenFolder}
        />
      )}
    </div>
  );
};
export default App;

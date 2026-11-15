import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  FolderOpen,
  AlertCircle,
  Video,
  Music,
  CheckCircle2,
  Clock,
  Loader2,
  HardDrive,
  Copy,
  Check,
  FileText,
  FileArchive,
  FileCode,
  File,
  RotateCw,
  Download,
} from 'lucide-react';
import {
  VideoAnalysisResult,
  VideoQualityOption,
  DownloadProbeInfo,
  DownloadTask,
} from '../types/download';
import { formatBytes } from '../utils/formatters';

interface Props {
  isOpen: boolean;
  isStandalone?: boolean;
  onClose: (createdTask?: DownloadTask) => void;
  onSubmit: (
    url: string,
    destinationDir?: string,
    segments?: number
  ) => Promise<DownloadTask | void>;
  onSubmitWithOptions?: (
    url: string,
    filename?: string,
    destinationDir?: string,
    segments?: number,
    startImmediately?: boolean,
    cookies?: string,
    referrer?: string,
    userAgent?: string
  ) => Promise<DownloadTask | void>;
  onProbeDownload?: (
    url: string,
    cookies?: string,
    referrer?: string,
    userAgent?: string
  ) => Promise<DownloadProbeInfo>;
  onProbeVideo: (
    url: string,
    cookies?: string,
    referrer?: string,
    userAgent?: string,
    fallbackTitle?: string
  ) => Promise<VideoAnalysisResult>;
  onSubmitVideo: (
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
  ) => Promise<DownloadTask | void>;
  defaultDir: string;
  defaultSegments?: number;
  initialUrl?: string;
  initialFilename?: string;
  initialMode?: 'file' | 'video';
  initialVideoData?: VideoAnalysisResult;
  initialCookies?: string;
  initialReferrer?: string;
  initialUserAgent?: string;
  initialError?: string;
}

const isTauri =
  typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

const KNOWN_MEDIA_EXT_RE = /\.(mp4|m4a|webm|mkv|mp3|aac|opus|ogg|wav|mov|avi|flv)$/i;
const VIDEO_URL_RE = /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitter\.com|x\.com)/i;

function sanitizeBasename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim();
}

function stripKnownMediaExt(name: string): string {
  return name.trim().replace(KNOWN_MEDIA_EXT_RE, '').trim();
}

function applyVideoExtension(name: string, ext: string): string {
  const cleanExt = ext.replace(/^\./, '') || 'mp4';
  const base = stripKnownMediaExt(name);
  return base ? `${base}.${cleanExt}` : `video.${cleanExt}`;
}

const VlcConeIcon: React.FC<{ className?: string }> = ({ className = 'w-9 h-9' }) => (
  <svg viewBox="0 0 64 64" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="32" cy="56" rx="26" ry="6" fill="#d35400" />
    <ellipse cx="32" cy="54" rx="23" ry="5" fill="#e67e22" />
    <path d="M14 53 L22 37 L42 37 L50 53 Z" fill="#e67e22" />
    <path d="M22 37 L25 29 L39 29 L42 37 Z" fill="#ffffff" />
    <path d="M25 29 L28 21 L36 21 L39 29 Z" fill="#e67e22" />
    <path d="M28 21 L30 14 L34 14 L36 21 Z" fill="#ffffff" />
    <path d="M30 14 L31 9 C31.5 7.5 32.5 7.5 33 9 L34 14 Z" fill="#e67e22" />
    <ellipse cx="32" cy="9" rx="1.5" ry="1" fill="#f39c12" />
  </svg>
);

export const AddDownloadModal: React.FC<Props> = ({
  isOpen,
  isStandalone = false,
  onClose,
  onSubmit,
  onSubmitWithOptions,
  onProbeDownload,
  onProbeVideo,
  onSubmitVideo,
  defaultDir,
  defaultSegments = 8,
  initialUrl = '',
  initialFilename = '',
  initialMode = 'file',
  initialVideoData,
  initialCookies,
  initialReferrer,
  initialUserAgent,
  initialError,
}) => {
  const [mode, setMode] = useState<'file' | 'video'>(initialMode || 'file');
  const [url, setUrl] = useState(initialUrl);
  const [customFilename, setCustomFilename] = useState(initialFilename);
  const [destDir, setDestDir] = useState(defaultDir || 'C:\\Downloads');
  const [segments, setSegments] = useState<number>(defaultSegments || 8);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError || null);

  // Authentication & Request headers
  const [cookies, setCookies] = useState<string | undefined>(initialCookies);
  const [referrer, setReferrer] = useState<string | undefined>(initialReferrer);
  const [userAgent, setUserAgent] = useState<string | undefined>(initialUserAgent);

  // IDM dialog metadata fields
  const [category, setCategory] = useState<string>(initialMode === 'video' ? 'Video' : 'Genel');
  const [rememberPath, setRememberPath] = useState(false);
  const [description, setDescription] = useState('');

  // File probing state
  const [isProbingFile, setIsProbingFile] = useState(false);
  const [probedInfo, setProbedInfo] = useState<DownloadProbeInfo | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Video analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoInfo, setVideoInfo] = useState<VideoAnalysisResult | null>(initialVideoData || null);
  const [selectedQuality, setSelectedQuality] = useState<VideoQualityOption | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filenameEditedRef = useRef(false);

  const baseUserPath = React.useMemo(() => {
    const safeDir = destDir || defaultDir || 'C:\\Downloads';
    const normalized = safeDir.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (parts.length >= 3 && parts[1]?.toLowerCase() === 'users') {
      return `${parts[0]}\\${parts[1]}\\${parts[2]}`;
    }
    return safeDir;
  }, [destDir, defaultDir]);

  const quickFolders = React.useMemo(() => {
    return [
      { name: 'İndirilenler', path: `${baseUserPath}\\Downloads` },
      { name: 'Masaüstü', path: `${baseUserPath}\\Desktop` },
      { name: 'Belgeler', path: `${baseUserPath}\\Documents` },
    ];
  }, [baseUserPath]);

  const domainHost = React.useMemo(() => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }, [url]);

  const triggerProbeFile = async (
    targetUrl: string,
    overrideCookies?: string,
    overrideReferrer?: string,
    overrideUserAgent?: string
  ) => {
    const trimmed = targetUrl.trim();
    if (!trimmed || (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))) {
      return;
    }

    try {
      setIsProbingFile(true);
      setError(null);
      if (onProbeDownload) {
        const info = await onProbeDownload(
          trimmed,
          overrideCookies ?? cookies ?? initialCookies,
          overrideReferrer ?? referrer ?? initialReferrer,
          overrideUserAgent ?? userAgent ?? initialUserAgent
        );
        setProbedInfo(info);
        if (!filenameEditedRef.current && info.filename) {
          setCustomFilename((prev) => (prev ? prev : info.filename));
        }
      }
    } catch (err: any) {
      console.warn('Probe failed, fallback to url filename:', err);
      const fallbackName = trimmed.split('/').pop()?.split('?')[0] || 'indirilen_dosya.bin';
      if (!filenameEditedRef.current) {
        setCustomFilename((prev) => prev || fallbackName);
      }
    } finally {
      setIsProbingFile(false);
    }
  };

  const handleAnalyzeVideoTarget = async (
    targetUrl: string,
    overrideCookies?: string,
    overrideReferrer?: string,
    overrideUserAgent?: string,
    overrideFallbackTitle?: string
  ) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    try {
      setIsAnalyzing(true);
      setError(null);
      const res = await onProbeVideo(
        trimmed,
        overrideCookies ?? cookies ?? initialCookies,
        overrideReferrer ?? referrer ?? initialReferrer,
        overrideUserAgent ?? userAgent ?? initialUserAgent,
        overrideFallbackTitle ?? (customFilename || initialFilename)
      );
      setVideoInfo(res);
      const firstQ = res.qualities.length > 0 ? res.qualities[0] : null;
      setSelectedQuality(firstQ);
      if (!filenameEditedRef.current && res.title) {
        const ext = firstQ?.extension || 'mp4';
        setCustomFilename(`${sanitizeBasename(res.title)}.${ext}`);
      }
    } catch (err: any) {
      setError(err?.message || String(err) || 'Video analizi başarısız oldu.');
      setVideoInfo(null);
      setSelectedQuality(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Sync props cleanly when opened or reset on close
  useEffect(() => {
    if (isOpen) {
      filenameEditedRef.current = false;
      setError(initialError || null);
      setCookies(initialCookies);
      setReferrer(initialReferrer);
      setUserAgent(initialUserAgent);
      setDestDir(defaultDir || 'C:\\Downloads');
      setSegments(defaultSegments || 8);
      setProbedInfo(null);
      setIsSubmitting(false);

      const looksLikeVideo = Boolean(initialUrl && VIDEO_URL_RE.test(initialUrl));
      const effectiveMode: 'file' | 'video' =
        initialMode === 'video' || (!initialMode && looksLikeVideo) || (initialMode !== 'file' && looksLikeVideo)
          ? 'video'
          : 'file';

      setMode(effectiveMode);
      setCategory(effectiveMode === 'video' ? 'Video' : 'Genel');

      if (initialVideoData) {
        setVideoInfo(initialVideoData);
        const firstQ = initialVideoData.qualities?.length > 0 ? initialVideoData.qualities[0] : null;
        setSelectedQuality(firstQ);
        if (initialFilename) {
          setCustomFilename(initialFilename);
        } else if (initialVideoData.title) {
          setCustomFilename(`${sanitizeBasename(initialVideoData.title)}.${firstQ?.extension || 'mp4'}`);
        } else {
          setCustomFilename('');
        }
      } else {
        setVideoInfo(null);
        setSelectedQuality(null);
        setCustomFilename(initialFilename || '');
      }

      if (initialUrl) {
        setUrl(initialUrl);
        if (effectiveMode === 'video') {
          if (!initialVideoData) {
            handleAnalyzeVideoTarget(
              initialUrl,
              initialCookies,
              initialReferrer,
              initialUserAgent,
              initialFilename
            );
          }
        } else {
          triggerProbeFile(initialUrl, initialCookies, initialReferrer, initialUserAgent);
        }
      } else {
        setUrl('');
        setIsAnalyzing(false);
        setIsProbingFile(false);
      }
    } else {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      setError(null);
      setProbedInfo(null);
      setIsProbingFile(false);
      setIsAnalyzing(false);
      setIsSubmitting(false);
      setVideoInfo(null);
      setSelectedQuality(null);
    }
  }, [
    isOpen,
    initialUrl,
    initialFilename,
    initialMode,
    initialVideoData,
    initialCookies,
    initialReferrer,
    initialUserAgent,
    initialError,
    defaultDir,
    defaultSegments,
  ]);

  const handleSelectQuality = (q: VideoQualityOption) => {
    setSelectedQuality(q);
    if (mode === 'video') {
      setCustomFilename((prev) => {
        if (prev && prev.trim()) {
          return applyVideoExtension(prev, q.extension);
        }
        if (videoInfo?.title) {
          return `${sanitizeBasename(videoInfo.title)}.${q.extension}`;
        }
        return prev;
      });
    }
  };

  const handleBrowseFolder = async () => {
    if (!isTauri) {
      const entered = window.prompt('Kaydedilecek klasör yolunu girin:', destDir);
      if (entered && entered.trim()) {
        setDestDir(entered.trim());
      }
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const selected = await invoke<string | null>('pick_folder');
      if (selected && selected.trim()) {
        setDestDir(selected.trim());
      }
    } catch (e) {
      console.error('pick_folder hatası:', e);
    }
  };

  const handleUrlChange = (newVal: string) => {
    setUrl(newVal);
    setError(null);
    setProbedInfo(null);

    if (VIDEO_URL_RE.test(newVal)) {
      setMode('video');
      setCategory('Video');
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      triggerProbeFile(newVal);
    }, 600);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
        handleUrlChange(text.trim());
      }
    } catch {
      // clipboard permission fallback
    }
  };

  const handleCopyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // copy error
    }
  };

  const handleAnalyzeVideo = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Lütfen geçerli bir video bağlantısı girin.');
      return;
    }
    await handleAnalyzeVideoTarget(trimmed);
  };

  const handleFinalSubmit = async (startImmediately: boolean) => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Lütfen bir indirme adresi girin.');
      return;
    }

    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      setError('Yalnızca HTTP ve HTTPS bağlantıları desteklenir.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);

      let createdTask: DownloadTask | void;

      if (mode === 'video') {
        if (!videoInfo || !selectedQuality) {
          setError('Lütfen önce videoyu analiz edin ve bir kalite seçin.');
          setIsSubmitting(false);
          return;
        }

        // Backend add_video_task appends .{extension}; strip trailing media ext to prevent .mp4.mp4
        const cleanedTitle = stripKnownMediaExt(customFilename || videoInfo.title) || videoInfo.title;

        createdTask = await onSubmitVideo(
          trimmed,
          cleanedTitle,
          selectedQuality.format_spec,
          selectedQuality.extension,
          selectedQuality.is_audio_only,
          destDir || undefined,
          selectedQuality.filesize_approx || undefined,
          cookies || initialCookies,
          referrer || initialReferrer,
          userAgent || initialUserAgent
        );
      } else {
        if (onSubmitWithOptions) {
          createdTask = await onSubmitWithOptions(
            trimmed,
            customFilename || undefined,
            destDir || undefined,
            segments,
            startImmediately,
            cookies || initialCookies,
            referrer || initialReferrer,
            userAgent || initialUserAgent
          );
        } else {
          createdTask = await onSubmit(trimmed, destDir || undefined, segments);
        }
      }

      onClose(createdTask || undefined);
    } catch (err: any) {
      setError(err?.message || String(err) || 'İndirme işlemi başarısız oldu.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatDuration = (seconds?: number | null) => {
    if (!seconds) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const getFileCategoryIcon = (cat?: string) => {
    switch (cat) {
      case 'compressed':
        return <FileArchive className="w-4 h-4 text-amber-600" />;
      case 'program':
        return <FileCode className="w-4 h-4 text-emerald-600" />;
      case 'video':
        return <Video className="w-4 h-4 text-rose-600" />;
      case 'audio':
        return <Music className="w-4 h-4 text-purple-600" />;
      case 'document':
        return <FileText className="w-4 h-4 text-[#0078d7]" />;
      default:
        return <File className="w-4 h-4 text-slate-500" />;
    }
  };

  if (!isOpen) return null;

  // Compact IDM standalone confirmation dialog (520x340 native window)
  if (isStandalone) {
    const fallbackExt = selectedQuality?.extension || 'mp4';
    const resolvedFilename =
      customFilename ||
      (videoInfo?.title
        ? `${sanitizeBasename(videoInfo.title)}.${fallbackExt}`
        : probedInfo?.filename || (mode === 'video' ? `video.${fallbackExt}` : 'dosya.bin'));
    const trimmedDest = (destDir || 'C:\\Downloads').replace(/[\\\/]+$/, '');
    const fullSavePath = `${trimmedDest}\\${resolvedFilename}`;

    return (
      <div className="h-full w-full bg-[#f0f0f0] dark:bg-[#1f242b] text-slate-900 dark:text-slate-100 px-3.5 py-2.5 select-none flex flex-col justify-between text-xs font-sans overflow-hidden">
        <div className="space-y-1.5">
          {/* Row 1: URL */}
          <div className="flex items-center gap-2">
            <label className="w-[60px] text-right text-[11.5px] text-slate-800 dark:text-slate-200 shrink-0">
              URL
            </label>
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <input
                type="text"
                value={url}
                readOnly
                title={url}
                className="flex-1 h-[23px] text-[11px] border border-[#7f9db9] dark:border-slate-600 bg-white dark:bg-[#181b20] rounded-[2px] px-2 text-slate-800 dark:text-slate-100 focus:outline-none truncate font-mono select-all"
              />
              {url && (
                <button
                  type="button"
                  onClick={handleCopyUrl}
                  title="Bağlantıyı Kopyala"
                  className="h-[23px] w-6 bg-[#e1e1e1] hover:bg-[#e5f1fb] border border-[#adadad] dark:border-slate-600 dark:bg-[#2d333b] rounded-[2px] flex items-center justify-center shrink-0"
                >
                  {copiedUrl ? (
                    <Check className="w-3 h-3 text-emerald-600" />
                  ) : (
                    <Copy className="w-3 h-3 text-slate-600 dark:text-slate-300" />
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Row 2: Kategori + Kalite / Dosya Özeti */}
          <div className="flex items-center gap-2">
            <label className="w-[60px] text-right text-[11.5px] text-slate-800 dark:text-slate-200 shrink-0">
              Kategori
            </label>
            <div className="flex-1 flex items-center gap-1.5 min-w-0">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-[23px] w-28 text-[11.5px] border border-[#7f9db9] dark:border-slate-600 bg-white dark:bg-[#181b20] rounded-[2px] px-1 text-slate-800 dark:text-slate-100 focus:outline-none shrink-0"
              >
                <option value="Video">Video</option>
                <option value="Sıkıştırılmış">Sıkıştırılmış</option>
                <option value="Programlar">Programlar</option>
                <option value="Belgeler">Belgeler</option>
                <option value="Müzik">Müzik</option>
                <option value="Genel">Genel</option>
              </select>

              {mode === 'video' && videoInfo?.qualities && videoInfo.qualities.length > 0 ? (
                <div className="flex-1 flex items-center gap-1 min-w-0">
                  <span className="text-[11px] text-slate-600 dark:text-slate-400 shrink-0">
                    Kalite:
                  </span>
                  <select
                    value={selectedQuality?.id || ''}
                    onChange={(e) => {
                      const found = videoInfo.qualities.find((q) => q.id === e.target.value);
                      if (found) handleSelectQuality(found);
                    }}
                    className="flex-1 min-w-0 h-[23px] text-[11px] border border-[#7f9db9] dark:border-slate-600 bg-white dark:bg-[#181b20] rounded-[2px] px-1 text-slate-800 dark:text-slate-100 focus:outline-none truncate"
                  >
                    {videoInfo.qualities.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.label} ({q.extension.toUpperCase()})
                        {q.filesize_approx ? ` — ~${formatBytes(q.filesize_approx)}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : mode === 'file' ? (
                <div className="flex-1 flex items-center justify-between gap-2 min-w-0 px-1.5 h-[23px] bg-[#e9ecef] dark:bg-[#272d36] border border-slate-300 dark:border-slate-600 rounded-[2px] text-[11px]">
                  <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                    {probedInfo?.formatted_size || (isProbingFile ? 'Sorgulanıyor...' : 'Bilinmiyor')}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10.5px] text-slate-500 dark:text-slate-400">Parça:</span>
                    <select
                      value={segments}
                      onChange={(e) => setSegments(Number(e.target.value))}
                      className="h-[18px] text-[10.5px] bg-white dark:bg-[#181b20] border border-slate-300 dark:border-slate-600 rounded-[2px] px-0.5 focus:outline-none"
                    >
                      {[1, 2, 4, 8, 16].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Row 3: Kaydet */}
          <div className="flex items-center gap-2">
            <label className="w-[60px] text-right text-[11.5px] text-slate-800 dark:text-slate-200 shrink-0">
              Kaydet
            </label>
            <div className="flex-1 flex items-center gap-1.5 min-w-0">
              <input
                type="text"
                value={fullSavePath}
                onChange={(e) => {
                  filenameEditedRef.current = true;
                  const val = e.target.value;
                  const lastSlash = Math.max(val.lastIndexOf('\\'), val.lastIndexOf('/'));
                  if (lastSlash !== -1) {
                    setDestDir(val.substring(0, lastSlash));
                    setCustomFilename(val.substring(lastSlash + 1));
                  } else {
                    setCustomFilename(val);
                  }
                }}
                className="flex-1 min-w-0 h-[23px] text-[11px] border border-[#7f9db9] dark:border-slate-600 bg-white dark:bg-[#181b20] rounded-[2px] px-2 text-slate-800 dark:text-slate-100 focus:outline-none truncate font-mono"
              />
              <button
                type="button"
                onClick={handleBrowseFolder}
                className="h-[23px] px-2.5 bg-[#e1e1e1] hover:bg-[#e5f1fb] active:bg-[#cce4f7] border border-[#adadad] dark:border-slate-600 dark:bg-[#2d333b] dark:hover:bg-[#373e47] rounded-[2px] text-slate-800 dark:text-slate-100 text-xs font-bold flex items-center justify-center cursor-pointer shrink-0"
                title="Klasör Seç"
              >
                ...
              </button>
            </div>
            <div className="w-9 flex justify-center items-center shrink-0">
              {mode === 'video' ? (
                <VlcConeIcon className="w-8 h-8" />
              ) : (
                <Download className="w-6 h-6 text-[#0078d7]" />
              )}
            </div>
          </div>

          {/* Row 4: Hatırla checkbox & gerçek hedef klasör */}
          <div className="flex items-start gap-2">
            <div className="w-[60px] shrink-0" />
            <div className="flex-1 mr-9 space-y-1 min-w-0">
              <label className="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberPath}
                  onChange={(e) => setRememberPath(e.target.checked)}
                  className="rounded-[2px] border-slate-400 text-[#0078d7] focus:ring-0 cursor-pointer"
                />
                <span>&quot;{category}&quot; için bu kayıt klasörünü kullan</span>
              </label>
              <div
                title={trimmedDest}
                className="w-full h-[21px] px-2 bg-[#f8f9fa] dark:bg-[#181b20] border border-slate-300 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-400 font-mono flex items-center select-all truncate rounded-[2px]"
              >
                {trimmedDest}
              </div>
            </div>
          </div>

          {/* Row 5: Açıklama */}
          <div className="flex items-center gap-2">
            <label className="w-[60px] text-right text-[11.5px] text-slate-800 dark:text-slate-200 shrink-0">
              Açıklama
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="flex-1 h-[23px] text-[11.5px] border border-[#7f9db9] dark:border-slate-600 bg-white dark:bg-[#181b20] rounded-[2px] px-2 text-slate-800 dark:text-slate-100 focus:outline-none"
            />
          </div>
        </div>

        {/* Status / Analyzing / Error Strip */}
        <div className="min-h-[24px] flex items-center">
          {error ? (
            <div className="w-full px-2 py-1 rounded-[2px] bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-[11px] text-rose-700 dark:text-rose-300 flex items-center gap-1.5 truncate">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate" title={error}>
                {error}
              </span>
            </div>
          ) : mode === 'video' && isAnalyzing ? (
            <div className="w-full px-2 py-1 rounded-[2px] bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-[11px] text-[#005a9e] dark:text-blue-300 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              <span>Video bilgileri ve mevcut kaliteler analiz ediliyor...</span>
            </div>
          ) : mode === 'file' && isProbingFile ? (
            <div className="w-full px-2 py-1 rounded-[2px] bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-[11px] text-[#005a9e] dark:text-blue-300 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              <span>Sunucudan dosya bilgisi ve boyut alınıyor...</span>
            </div>
          ) : mode === 'video' && videoInfo ? (
            <div className="w-full px-2 py-1 rounded-[2px] bg-[#e9ecef] dark:bg-[#272d36] border border-slate-300 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-200 flex items-center justify-between gap-2 min-w-0">
              <span className="truncate font-medium" title={videoInfo.title}>
                {videoInfo.title}
                {videoInfo.duration_seconds ? ` (${formatDuration(videoInfo.duration_seconds)})` : ''}
              </span>
              {selectedQuality?.filesize_approx ? (
                <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                  ~{formatBytes(selectedQuality.filesize_approx)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Bottom IDM Action Buttons */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-300 dark:border-slate-700">
          <button
            type="button"
            onClick={() => handleFinalSubmit(false)}
            disabled={
              isSubmitting || isAnalyzing || (mode === 'video' && !videoInfo) || !url.trim()
            }
            className="h-[25px] px-3 text-[11.5px] border border-[#adadad] dark:border-slate-600 bg-[#e1e1e1] hover:bg-[#e5f1fb] active:bg-[#cce4f7] dark:bg-[#2d333b] dark:hover:bg-[#373e47] text-slate-900 dark:text-slate-100 rounded-[2px] cursor-pointer disabled:opacity-50"
          >
            Daha Sonra İndir
          </button>

          <button
            type="button"
            onClick={() => handleFinalSubmit(true)}
            disabled={
              isSubmitting || isAnalyzing || (mode === 'video' && !videoInfo) || !url.trim()
            }
            className="h-[25px] px-4 text-[11.5px] font-medium border border-[#005a9e] bg-[#0078d7] hover:bg-[#106ebe] active:bg-[#005a9e] text-white rounded-[2px] cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Başlatılıyor...</span>
              </>
            ) : (
              <span>İndirmeyi Başlat</span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onClose()}
            disabled={isSubmitting}
            className="h-[25px] px-3.5 text-[11.5px] border border-[#adadad] dark:border-slate-600 bg-[#e1e1e1] hover:bg-[#e5f1fb] active:bg-[#cce4f7] dark:bg-[#2d333b] dark:hover:bg-[#373e47] text-slate-900 dark:text-slate-100 rounded-[2px] cursor-pointer"
          >
            İptal
          </button>
        </div>
      </div>
    );
  }

  // Dashboard Modal (Classic Win32/IDM Desktop Layout)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="w-full max-w-xl bg-[#f5f6f8] dark:bg-[#1f242b] border border-slate-300 dark:border-slate-700 rounded-md shadow-xl text-slate-900 dark:text-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
        {/* Title Bar */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#e9ecef] dark:bg-[#272d36] border-b border-slate-300 dark:border-slate-700 shrink-0">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-[#0078d7]" />
            <h2 className="text-sm font-semibold">Yeni İndirme Ekle</h2>
          </div>
          <button
            type="button"
            onClick={() => onClose()}
            className="p-1 rounded text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700"
            title="Kapat"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5 overflow-y-auto text-xs">
          {/* Classic Tab Bar */}
          <div className="flex border-b border-slate-300 dark:border-slate-700">
            <button
              type="button"
              onClick={() => {
                setMode('file');
                setCategory('Genel');
                setError(null);
                if (url.trim()) triggerProbeFile(url);
              }}
              className={`px-3.5 py-2 text-xs font-medium border-b-2 transition flex items-center gap-1.5 ${
                mode === 'file'
                  ? 'border-[#0078d7] text-[#0078d7] dark:text-[#4da3ff]'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>Dosya İndir (HTTP)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('video');
                setCategory('Video');
                setError(null);
              }}
              className={`px-3.5 py-2 text-xs font-medium border-b-2 transition flex items-center gap-1.5 ${
                mode === 'video'
                  ? 'border-[#0078d7] text-[#0078d7] dark:text-[#4da3ff]'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Video className="w-3.5 h-3.5" />
              <span>Video İndir (Akış / Medya)</span>
            </button>
          </div>

          {/* Error Box */}
          {error && (
            <div className="p-2.5 rounded bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* URL Field */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                {mode === 'video' ? 'Video Adresi (URL)' : 'İndirme Adresi (URL)'}
              </label>
              {domainHost && (
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  {domainHost}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder={
                  mode === 'video'
                    ? 'https://www.youtube.com/watch?v=...'
                    : 'https://example.com/dosya.zip'
                }
                className="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#181b20] font-mono focus:outline-none focus:border-[#0078d7]"
              />
              {url && (
                <button
                  type="button"
                  onClick={handleCopyUrl}
                  title="Bağlantıyı Kopyala"
                  className="px-2 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-[#e9ecef] hover:bg-slate-200 dark:bg-[#272d36] dark:hover:bg-[#323944] text-slate-700 dark:text-slate-200"
                >
                  {copiedUrl ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
              {mode === 'video' ? (
                <button
                  type="button"
                  onClick={handleAnalyzeVideo}
                  disabled={isAnalyzing || !url.trim()}
                  className="px-3 py-1.5 text-xs font-medium rounded bg-[#0078d7] hover:bg-[#106ebe] text-white border border-[#005a9e] disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                >
                  {isAnalyzing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Video className="w-3.5 h-3.5" />
                  )}
                  <span>Analiz Et</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => triggerProbeFile(url)}
                  disabled={isProbingFile || !url.trim()}
                  title="Sunucudan Bilgi Al"
                  className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-[#e9ecef] hover:bg-slate-200 dark:bg-[#272d36] dark:hover:bg-[#323944] text-slate-700 dark:text-slate-200 disabled:opacity-50"
                >
                  <RotateCw
                    className={`w-3.5 h-3.5 ${isProbingFile ? 'animate-spin text-[#0078d7]' : ''}`}
                  />
                </button>
              )}
              <button
                type="button"
                onClick={handlePaste}
                className="px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-[#e9ecef] hover:bg-slate-200 dark:bg-[#272d36] dark:hover:bg-[#323944] text-slate-700 dark:text-slate-200 shrink-0"
              >
                Yapıştır
              </button>
            </div>
          </div>

          {/* FILE MODE SECTION */}
          {mode === 'file' && (
            <div className="space-y-3">
              {isProbingFile && (
                <div className="p-2 rounded bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-[#005a9e] dark:text-blue-300 text-xs flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>Sunucudan dosya bilgisi, boyut ve parça desteği alınıyor...</span>
                </div>
              )}

              {/* Filename */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Dosya Adı
                </label>
                <div className="relative flex items-center">
                  <div className="absolute left-2.5 top-1/2 -translate-y-1/2">
                    {getFileCategoryIcon(probedInfo?.category)}
                  </div>
                  <input
                    type="text"
                    value={customFilename}
                    onChange={(e) => {
                      filenameEditedRef.current = true;
                      setCustomFilename(e.target.value);
                    }}
                    placeholder="ornek_dosya.zip"
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#181b20] font-mono focus:outline-none focus:border-[#0078d7]"
                  />
                </div>
              </div>

              {/* Probed Server Details */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="p-2.5 rounded bg-white dark:bg-[#181b20] border border-slate-300 dark:border-slate-700">
                  <span className="block text-[10px] uppercase text-slate-500 dark:text-slate-400 mb-0.5">
                    Dosya Boyutu
                  </span>
                  <div className="text-xs font-semibold font-mono flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5 text-[#0078d7] shrink-0" />
                    <span className="truncate">{probedInfo?.formatted_size || 'Bilinmiyor'}</span>
                  </div>
                </div>

                <div className="p-2.5 rounded bg-white dark:bg-[#181b20] border border-slate-300 dark:border-slate-700">
                  <span className="block text-[10px] uppercase text-slate-500 dark:text-slate-400 mb-0.5">
                    Devam Etme (Range)
                  </span>
                  <div className="text-xs font-semibold">
                    {probedInfo?.supports_range !== false ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Evet (Çoklu Parça)
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                        <AlertCircle className="w-3.5 h-3.5" /> Tek Bağlantı
                      </span>
                    )}
                  </div>
                </div>

                <div className="p-2.5 rounded bg-white dark:bg-[#181b20] border border-slate-300 dark:border-slate-700">
                  <span className="block text-[10px] uppercase text-slate-500 dark:text-slate-400 mb-0.5">
                    Kategori
                  </span>
                  <div className="text-xs font-semibold capitalize flex items-center gap-1.5">
                    {getFileCategoryIcon(probedInfo?.category)}
                    <span>{probedInfo?.category || 'Genel'}</span>
                  </div>
                </div>
              </div>

              {/* Segment Selector */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    Paralel Bağlantı Sayısı
                  </label>
                  <span className="text-[11px] font-mono text-[#0078d7] dark:text-[#4da3ff]">
                    {segments} bağlantı
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {[1, 2, 4, 8, 16].map((num) => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => setSegments(num)}
                      className={`py-1 text-xs font-medium rounded border transition ${
                        segments === num
                          ? 'bg-[#0078d7] border-[#005a9e] text-white'
                          : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-[#181b20] hover:bg-slate-100 dark:hover:bg-[#272d36] text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* VIDEO MODE SECTION */}
          {mode === 'video' && isAnalyzing && (
            <div className="p-2.5 rounded bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-[#005a9e] dark:text-blue-300 text-xs flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>Video bilgileri ve mevcut kaliteler analiz ediliyor...</span>
            </div>
          )}

          {mode === 'video' && videoInfo && (
            <div className="p-3 rounded bg-white dark:bg-[#181b20] border border-slate-300 dark:border-slate-700 space-y-3">
              <div className="flex gap-3 items-start">
                {videoInfo.thumbnail_url ? (
                  <img
                    src={videoInfo.thumbnail_url}
                    alt="Video önizleme"
                    className="w-24 h-14 object-cover rounded border border-slate-300 dark:border-slate-600 shrink-0"
                  />
                ) : (
                  <div className="w-24 h-14 rounded bg-slate-200 dark:bg-slate-800 flex items-center justify-center shrink-0">
                    <Video className="w-5 h-5 text-slate-500" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h4 className="text-xs font-semibold truncate text-slate-900 dark:text-slate-100">
                    {videoInfo.title}
                  </h4>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    {videoInfo.duration_seconds && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDuration(videoInfo.duration_seconds)}
                      </span>
                    )}
                    {selectedQuality?.filesize_approx && (
                      <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                        Tahmini: ~{formatBytes(selectedQuality.filesize_approx)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Editable Video Filename */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Kayıt Dosya Adı
                </label>
                <input
                  type="text"
                  value={customFilename}
                  onChange={(e) => {
                    filenameEditedRef.current = true;
                    setCustomFilename(e.target.value);
                  }}
                  placeholder={`${sanitizeBasename(videoInfo.title)}.${selectedQuality?.extension || 'mp4'}`}
                  className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-[#f8f9fa] dark:bg-[#1f242b] font-mono focus:outline-none focus:border-[#0078d7]"
                />
              </div>

              {/* Quality Choices */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Kalite ve Biçim Seçimi
                </label>
                <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto pr-1">
                  {videoInfo.qualities.map((q) => {
                    const isSelected = selectedQuality?.id === q.id;
                    return (
                      <button
                        key={q.id}
                        type="button"
                        onClick={() => handleSelectQuality(q)}
                        className={`p-2 rounded text-left text-xs border flex items-center justify-between transition ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-950/40 border-[#0078d7] text-[#005a9e] dark:text-[#66b2ff]'
                            : 'border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-[#272d36] text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          {q.is_audio_only ? (
                            <Music className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          ) : (
                            <Video className="w-3.5 h-3.5 text-[#0078d7] shrink-0" />
                          )}
                          <span className="truncate font-medium">{q.label}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0 ml-1">
                          {q.filesize_approx ? (
                            <span className="text-[10.5px] font-mono text-emerald-700 dark:text-emerald-400">
                              ~{formatBytes(q.filesize_approx)}
                            </span>
                          ) : null}
                          <span className="text-[10px] uppercase font-mono px-1 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                            {q.extension}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Shared Destination Directory */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                Kayıt Klasörü
              </label>
              <div className="flex items-center gap-1">
                {quickFolders.map((qf) => (
                  <button
                    key={qf.name}
                    type="button"
                    onClick={() => setDestDir(qf.path)}
                    className={`text-[10.5px] px-2 py-0.5 rounded border transition ${
                      destDir.toLowerCase() === qf.path.toLowerCase()
                        ? 'bg-blue-50 dark:bg-blue-950/40 border-[#0078d7] text-[#0078d7] dark:text-[#66b2ff] font-medium'
                        : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-[#272d36] text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {qf.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={destDir}
                onChange={(e) => setDestDir(e.target.value)}
                placeholder="C:\Downloads"
                className="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#181b20] font-mono focus:outline-none focus:border-[#0078d7]"
              />
              <button
                type="button"
                onClick={handleBrowseFolder}
                className="px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-[#e9ecef] hover:bg-slate-200 dark:bg-[#272d36] dark:hover:bg-[#323944] text-slate-700 dark:text-slate-200 flex items-center gap-1.5 shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Gözat...</span>
              </button>
            </div>
            {customFilename && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono mt-1 truncate">
                Hedef: {destDir.replace(/[\\\/]+$/, '')}\{customFilename}
              </p>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#e9ecef] dark:bg-[#272d36] border-t border-slate-300 dark:border-slate-700 shrink-0">
          <button
            type="button"
            onClick={() => onClose()}
            disabled={isSubmitting}
            className="px-3.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white hover:bg-slate-100 dark:bg-[#1f242b] dark:hover:bg-[#323944] text-slate-700 dark:text-slate-200"
          >
            Vazgeç
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleFinalSubmit(false)}
              disabled={
                isSubmitting || isAnalyzing || (mode === 'video' && !videoInfo) || !url.trim()
              }
              title="İndirmeyi başlatmadan listeye ekler"
              className="px-3.5 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-600 bg-white hover:bg-slate-100 dark:bg-[#1f242b] dark:hover:bg-[#323944] text-slate-800 dark:text-slate-100 disabled:opacity-50"
            >
              Daha Sonra İndir
            </button>

            <button
              type="button"
              onClick={() => handleFinalSubmit(true)}
              disabled={
                isSubmitting || isAnalyzing || (mode === 'video' && !videoInfo) || !url.trim()
              }
              className="px-4 py-1.5 text-xs font-medium rounded border border-[#005a9e] bg-[#0078d7] hover:bg-[#106ebe] text-white flex items-center gap-1.5 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Başlatılıyor...</span>
                </>
              ) : (
                <span>İndirmeyi Başlat</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

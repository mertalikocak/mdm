import React, { useState, useEffect, useRef } from 'react';
import {
  Zap,
  AlertCircle,
  Video,
  Music,
  CheckCircle2,
  Clock,
  Loader2,
  Copy,
  Check,
  FileText,
  FileArchive,
  FileCode,
  File,
  FolderOpen,
} from 'lucide-react';
import { VideoAnalysisResult, VideoQualityOption, DownloadProbeInfo, AppSettings } from './types/download';
import { formatBytes } from './utils/formatters';

const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

async function invokeTauri<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  throw new Error('Tauri not available');
}

async function closeWindow() {
  if (isTauri) {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    getCurrentWebviewWindow().close();
  } else {
    window.close();
  }
}

export const DownloadDialogApp: React.FC = () => {
  const [mode, setMode] = useState<'file' | 'video'>('file');
  const [url, setUrl] = useState('');
  const [customFilename, setCustomFilename] = useState('');
  const [destDir, setDestDir] = useState('C:\\Downloads');
  const [segments, setSegments] = useState<number>(8);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Authentication & Request headers
  const [cookies, setCookies] = useState<string | null>(null);
  const [referrer, setReferrer] = useState<string | null>(null);
  const [userAgent, setUserAgent] = useState<string | null>(null);

  // File probing state
  const [isProbingFile, setIsProbingFile] = useState(false);
  const [probedInfo, setProbedInfo] = useState<DownloadProbeInfo | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Video analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoInfo, setVideoInfo] = useState<VideoAnalysisResult | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<VideoQualityOption | null>(null);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-detect common user directories for quick buttons
  const baseUserPath = React.useMemo(() => {
    const safeDir = destDir || 'C:\\Downloads';
    const normalized = safeDir.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (parts.length >= 3 && parts[1]?.toLowerCase() === 'users') {
      return `${parts[0]}\\${parts[1]}\\${parts[2]}`;
    }
    return safeDir;
  }, [destDir]);

  const quickFolders = React.useMemo(() => {
    return [
      { name: 'İndirilenler', path: `${baseUserPath}\\Downloads` },
      { name: 'Masaüstü', path: `${baseUserPath}\\Desktop` },
      { name: 'Belgeler', path: `${baseUserPath}\\Documents` },
    ];
  }, [baseUserPath]);

  // Extract hostname for domain pill
  const domainPill = React.useMemo(() => {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return null;
    }
  }, [url]);

  // Load settings & pending download on mount
  useEffect(() => {
    // Ensure dark theme is active
    document.documentElement.classList.add('dark');

    if (isTauri) {
      invokeTauri<AppSettings>('get_settings')
        .then((s) => {
          if (s.default_download_dir) setDestDir(s.default_download_dir);
          if (s.default_segments) setSegments(s.default_segments);
        })
        .catch(console.error);

      // Check for pending payload
      invokeTauri<any>('check_pending_confirm')
        .then((pending) => {
          if (pending && pending.url) {
            applyPayload(pending);
          }
        })
        .catch(console.error);

      // Listen for runtime events
      let unlisten: (() => void) | undefined;
      (async () => {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          unlisten = await listen<any>('open-download-confirm', (event) => {
            if (event.payload) {
              applyPayload(event.payload);
            }
          });
        } catch (e) {
          console.error('Event listen error:', e);
        }
      })();

      return () => {
        if (unlisten) unlisten();
      };
    }
  }, []);

  const applyPayload = (payload: any) => {
    if (!payload.url) return;
    setUrl(payload.url);
    if (payload.filename) setCustomFilename(payload.filename);
    if (payload.destination_dir) setDestDir(payload.destination_dir);
    if (payload.segments) setSegments(payload.segments);
    if (payload.cookies) setCookies(payload.cookies);
    if (payload.referrer) setReferrer(payload.referrer);
    if (payload.user_agent) setUserAgent(payload.user_agent);

    const isVideo =
      payload.mode === 'video' ||
      /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitter\.com|x\.com)/i.test(payload.url);

    if (isVideo) {
      setMode('video');
      if (payload.video_data) {
        setVideoInfo(payload.video_data);
        if (payload.video_data.qualities?.length > 0) {
          setSelectedQuality(payload.video_data.qualities[0]);
        }
      } else {
        triggerAnalyzeVideo(
          payload.url,
          payload.cookies,
          payload.referrer,
          payload.user_agent,
          payload.filename
        );
      }
    } else {
      setMode('file');
      triggerProbeFile(payload.url);
    }
  };

  const triggerProbeFile = async (targetUrl: string) => {
    const trimmed = targetUrl.trim();
    if (!trimmed || (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))) return;
    try {
      setIsProbingFile(true);
      setError(null);
      const info = await invokeTauri<DownloadProbeInfo>('probe_download_info', {
        url: trimmed,
        cookies: cookies || null,
        referrer: referrer || null,
        userAgent: userAgent || null,
      });
      setProbedInfo(info);
      if (!customFilename) {
        setCustomFilename(info.filename);
      }
      if (info.suggested_path && !destDir) {
        const parts = info.suggested_path.split('\\');
        parts.pop();
        setDestDir(parts.join('\\'));
      }
    } catch (err: any) {
      const fallbackName = trimmed.split('/').pop()?.split('?')[0] || 'indirilen_dosya.bin';
      if (!customFilename) setCustomFilename(fallbackName);
    } finally {
      setIsProbingFile(false);
    }
  };

  const triggerAnalyzeVideo = async (
    targetUrl: string,
    cookiesParam?: string | null,
    referrerParam?: string | null,
    userAgentParam?: string | null,
    fallbackTitleParam?: string | null
  ) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    try {
      setIsAnalyzing(true);
      setError(null);
      const res = await invokeTauri<VideoAnalysisResult>('probe_video_info', {
        url: trimmed,
        cookies: cookiesParam ?? cookies ?? null,
        referrer: referrerParam ?? referrer ?? null,
        userAgent: userAgentParam ?? userAgent ?? null,
        fallbackTitle: fallbackTitleParam ?? (customFilename || null),
      });
      setVideoInfo(res);
      if (res.qualities?.length > 0) {
        setSelectedQuality(res.qualities[0]);
      }
    } catch (err: any) {
      setError(err?.message || String(err) || 'Video analizi başarısız oldu.');
      setVideoInfo(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStartDownload = async (startImmediately: boolean) => {
    if (!url.trim()) {
      setError('Lütfen geçerli bir indirme bağlantısı girin.');
      return;
    }
    try {
      setIsSubmitting(true);
      setError(null);

      if (mode === 'video') {
        if (!videoInfo || !selectedQuality) {
          setError('Lütfen bir video kalitesi seçin.');
          setIsSubmitting(false);
          return;
        }
        await invokeTauri('add_video_download', {
          url,
          title: videoInfo.title,
          formatSpec: selectedQuality.format_spec,
          extension: selectedQuality.extension,
          isAudioOnly: selectedQuality.is_audio_only,
          destinationDir: destDir || undefined,
          totalBytes: selectedQuality.filesize_approx || null,
          cookies: cookies || null,
          referrer: referrer || null,
          userAgent: userAgent || null,
        });
      } else {
        await invokeTauri('add_download_with_options', {
          url,
          filename: customFilename.trim() || undefined,
          destinationDir: destDir || undefined,
          segments,
          startImmediately,
          cookies: cookies || undefined,
          referrer: referrer || undefined,
          userAgent: userAgent || undefined,
        });
      }

      await closeWindow();
    } catch (err: any) {
      setError(err?.message || String(err) || 'İndirme eklenirken bir hata oluştu.');
      setIsSubmitting(false);
    }
  };

  const getCategoryIcon = (cat?: string) => {
    switch (cat) {
      case 'video':
        return <Video className="w-4 h-4 text-rose-500" />;
      case 'compressed':
        return <FileArchive className="w-4 h-4 text-amber-500" />;
      case 'program':
        return <FileCode className="w-4 h-4 text-emerald-500" />;
      case 'audio':
        return <Music className="w-4 h-4 text-purple-500" />;
      case 'document':
        return <FileText className="w-4 h-4 text-blue-500" />;
      default:
        return <File className="w-4 h-4 text-slate-400" />;
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-900 text-slate-100 font-sans select-none overflow-hidden border border-slate-800 shadow-2xl">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-5 py-3.5 bg-slate-950/80 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-tr from-blue-600 to-cyan-500 text-white shadow-md shadow-blue-500/20">
            <Zap className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              {mode === 'video' ? 'Video İndirme Bilgisi' : 'Dosya İndirme Bilgisi'}
              <span className="text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                MDM Engine
              </span>
            </h1>
            <p className="text-[11px] text-slate-400">
              {mode === 'video'
                ? 'YouTube ve web video akışlarını yüksek hızda indirin'
                : 'IDM tarzı çok parçalı paralel HTTP indirme'}
            </p>
          </div>
        </div>

        {/* Tab Toggle */}
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={() => setMode('file')}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
              mode === 'file'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Dosya
          </button>
          <button
            type="button"
            onClick={() => setMode('video')}
            className={`px-3 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition ${
              mode === 'video'
                ? 'bg-rose-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Video className="w-3 h-3" />
            Video
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
        )}

        {/* URL Input */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold text-slate-300">İndirme Bağlantısı (URL)</label>
            {domainPill && (
              <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
                {domainPill}
              </span>
            )}
          </div>
          <div className="relative">
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (mode === 'file') {
                  if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                  debounceTimerRef.current = setTimeout(() => triggerProbeFile(e.target.value), 600);
                }
              }}
              placeholder="https://example.com/dosya.zip veya video bağlantısı"
              className="w-full pl-3 pr-20 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-blue-500 font-mono"
            />
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {isProbingFile || isAnalyzing ? (
                <div className="p-1 text-blue-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(url);
                    setCopiedUrl(true);
                    setTimeout(() => setCopiedUrl(false), 1500);
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                  title="Bağlantıyı Kopyala"
                >
                  {copiedUrl ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* FILE MODE */}
        {mode === 'file' && (
          <>
            {/* Live Probe Stats Card */}
            <div className="grid grid-cols-3 gap-2.5 p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
              <div className="space-y-0.5">
                <span className="text-[10px] text-slate-500 block font-medium">Dosya Boyutu</span>
                <span className="text-xs font-bold text-slate-200">
                  {isProbingFile ? (
                    <span className="inline-flex items-center gap-1 text-slate-400">
                      <Loader2 className="w-3 h-3 animate-spin" /> Algılanıyor...
                    </span>
                  ) : probedInfo?.formatted_size ? (
                    probedInfo.formatted_size
                  ) : (
                    'Bilinmiyor (Akış)'
                  )}
                </span>
              </div>

              <div className="space-y-0.5">
                <span className="text-[10px] text-slate-500 block font-medium">Parçalı İndirme</span>
                <div className="flex items-center gap-1 text-xs font-bold">
                  {isProbingFile ? (
                    <span className="text-slate-400">Kontrol...</span>
                  ) : probedInfo?.supports_range ? (
                    <span className="text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Destekleniyor
                    </span>
                  ) : (
                    <span className="text-amber-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Tek Akış
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-0.5">
                <span className="text-[10px] text-slate-500 block font-medium">Kategori</span>
                <div className="flex items-center gap-1 text-xs font-bold text-slate-200">
                  {getCategoryIcon(probedInfo?.category)}
                  <span className="capitalize">{probedInfo?.category || 'Genel'}</span>
                </div>
              </div>
            </div>

            {/* Custom Filename */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">Kayıt Adı</label>
              <input
                type="text"
                value={customFilename}
                onChange={(e) => setCustomFilename(e.target.value)}
                placeholder="dosya_adi.zip"
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </>
        )}

        {/* VIDEO MODE */}
        {mode === 'video' && (
          <div className="space-y-3">
            {isAnalyzing && (
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-center space-y-2">
                <Loader2 className="w-5 h-5 text-blue-400 animate-spin mx-auto" />
                <p className="text-xs text-blue-300 font-medium">Video çözünürlükleri ve formatları taranıyor...</p>
              </div>
            )}

            {videoInfo && (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                <div className="flex gap-3 items-center">
                  {videoInfo.thumbnail_url && (
                    <img
                      src={videoInfo.thumbnail_url}
                      alt={videoInfo.title}
                      className="w-20 h-14 object-cover rounded-lg border border-slate-800"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-xs font-bold text-slate-200 truncate">{videoInfo.title}</h3>
                    {videoInfo.duration_seconds && (
                      <span className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3" />
                        {Math.floor(videoInfo.duration_seconds / 60)}:
                        {String(videoInfo.duration_seconds % 60).padStart(2, '0')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Quality Selection */}
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">Kalite Seçimi</label>
                  <div className="grid grid-cols-2 gap-2 max-h-32 overflow-y-auto">
                    {videoInfo.qualities?.map((q) => (
                      <button
                        key={q.id}
                        type="button"
                        onClick={() => setSelectedQuality(q)}
                        className={`p-2 rounded-lg border text-left text-xs transition flex items-center justify-between ${
                          selectedQuality?.id === q.id
                            ? 'bg-blue-600/20 border-blue-500 text-blue-300 font-bold'
                            : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <span className="truncate">{q.label}</span>
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          {q.filesize_approx ? (
                            <span className="text-[11px] font-semibold text-emerald-400">
                              ~{formatBytes(q.filesize_approx)}
                            </span>
                          ) : null}
                          <span className="text-[10px] text-slate-400 uppercase">{q.extension}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                  {selectedQuality?.filesize_approx ? (
                    <div className="mt-2 px-2.5 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 flex items-center justify-between text-xs">
                      <span className="text-slate-400">Seçilen Kalite Boyutu:</span>
                      <span className="font-bold text-emerald-400">
                        ~{formatBytes(selectedQuality.filesize_approx)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Destination Directory & Quick Folders */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold text-slate-300">Kaydedilecek Klasör</label>
            <div className="flex items-center gap-1">
              {quickFolders.map((qf) => (
                <button
                  key={qf.name}
                  type="button"
                  onClick={() => setDestDir(qf.path)}
                  className={`text-[10px] px-2 py-0.5 rounded font-medium border transition ${
                    destDir === qf.path
                      ? 'bg-blue-500/20 text-blue-400 border-blue-500/40'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {qf.name}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={destDir}
              onChange={(e) => setDestDir(e.target.value)}
              className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:outline-none focus:border-blue-500 font-mono"
            />
            <button
              type="button"
              onClick={async () => {
                if (isTauri) {
                  try {
                    // Optional folder dialog
                  } catch (e) {
                    console.error(e);
                  }
                }
              }}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Gözat
            </button>
          </div>
        </div>

        {/* Segments (File mode only) */}
        {mode === 'file' && (
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-semibold text-slate-300">Eşzamanlı Parça (Bağlantı) Sayısı</span>
            <div className="flex items-center gap-1.5">
              {[1, 2, 4, 8, 16].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setSegments(num)}
                  className={`w-7 h-7 rounded-lg text-xs font-bold transition ${
                    segments === num
                      ? 'bg-cyan-500 text-white shadow-sm'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  {num}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* IDM Signature Bottom Action Bar */}
      <div className="flex items-center justify-between px-5 py-3.5 bg-slate-950 border-t border-slate-800">
        <button
          type="button"
          onClick={closeWindow}
          disabled={isSubmitting}
          className="px-4 py-2 rounded-xl border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold transition"
        >
          Vazgeç
        </button>

        <div className="flex items-center gap-2">
          {mode === 'file' && (
            <button
              type="button"
              onClick={() => handleStartDownload(false)}
              disabled={isSubmitting || !url.trim()}
              className="px-4 py-2 rounded-xl bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-600/30 text-xs font-semibold transition"
            >
              Daha Sonra İndir
            </button>
          )}

          <button
            type="button"
            onClick={() => handleStartDownload(true)}
            disabled={isSubmitting || !url.trim()}
            className="px-5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white text-xs font-bold transition shadow-lg shadow-blue-500/25 flex items-center gap-1.5"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Başlatılıyor...
              </>
            ) : mode === 'video' ? (
              'Videoyu İndir'
            ) : (
              'İndirmeyi Başlat'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
export default DownloadDialogApp;

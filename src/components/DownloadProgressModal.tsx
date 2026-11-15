import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Play,
  Pause,
  FolderOpen,
  FileCheck,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { DownloadTask, AppSettings } from '../types/download';
import { formatBytes, formatSpeed, formatEta } from '../utils/formatters';

interface Props {
  isOpen: boolean;
  isStandalone?: boolean;
  task: DownloadTask | null;
  onClose: () => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: (path: string) => void;
}

const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

function playCompletionChime() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}

export const DownloadProgressModal: React.FC<Props> = ({
  isOpen,
  isStandalone = false,
  task,
  onClose,
  onPause,
  onResume,
  onCancel,
  onOpenFile,
  onOpenFolder,
}) => {
  const [activeTab, setActiveTab] = useState<'status' | 'limiter' | 'completion'>('status');
  const [showDetails, setShowDetails] = useState<boolean>(true);

  const [closeOnComplete, setCloseOnComplete] = useState<boolean>(false);
  const [openFileOnComplete, setOpenFileOnComplete] = useState<boolean>(false);
  const [playSoundOnComplete, setPlaySoundOnComplete] = useState<boolean>(true);

  const [isLimiterEnabled, setIsLimiterEnabled] = useState<boolean>(false);
  const [limitKbps, setLimitKbps] = useState<number>(2048);
  const [limiterSavedMsg, setLimiterSavedMsg] = useState<string | null>(null);

  const prevStatusRef = useRef<string | undefined>(task?.status);
  const hasTriggeredCompleteRef = useRef<boolean>(false);

  // Sync speed limiter UI state from backend settings on open
  useEffect(() => {
    if (!isOpen || !isTauri) return;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const settings = await invoke<AppSettings>('get_settings');
        if (settings.global_speed_limit_bytes && settings.global_speed_limit_bytes > 0) {
          setIsLimiterEnabled(true);
          setLimitKbps(Math.max(1, Math.round(settings.global_speed_limit_bytes / 1024)));
        } else {
          setIsLimiterEnabled(false);
        }
      } catch {}
    })();
  }, [isOpen]);

  const applySpeedLimit = async (enabled: boolean, kbpsValue: number) => {
    const safeKbps = Math.max(16, Math.round(kbpsValue || 0));
    const bytesPerSec = enabled ? safeKbps * 1024 : null;
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_speed_limit', { limitBytesPerSec: bytesPerSec });
        setLimiterSavedMsg(enabled ? `${safeKbps} KB/sn uygulandı` : 'Hız sınırı kaldırıldı');
        setTimeout(() => setLimiterSavedMsg(null), 2000);
      } catch (e) {
        console.error('set_speed_limit error:', e);
      }
    }
  };

  useEffect(() => {
    if (!task) return;

    if (task.status === 'completed' && prevStatusRef.current !== 'completed' && !hasTriggeredCompleteRef.current) {
      hasTriggeredCompleteRef.current = true;
      if (playSoundOnComplete) {
        playCompletionChime();
      }
      if (openFileOnComplete) {
        onOpenFile(task.destination_path);
      }
      if (closeOnComplete || openFileOnComplete) {
        setTimeout(() => {
          onClose();
        }, 800);
      }
    }
    prevStatusRef.current = task.status;
  }, [task?.status, playSoundOnComplete, openFileOnComplete, closeOnComplete, onOpenFile, onClose, task?.destination_path]);

  // Adjust standalone window title & size only while visible/active
  useEffect(() => {
    if (!isStandalone || !isOpen || !task) return;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const { LogicalSize } = await import('@tauri-apps/api/dpi');
        const win = getCurrentWebviewWindow();

        if (task.status === 'completed') {
          await win.setTitle(`İndirme Tamamlandı - ${task.filename}`);
          await win.setSize(new LogicalSize(520, 340));
        } else if (task.merging) {
          const mergePct = Math.min(100, Math.max(0, task.merge_progress ?? 0));
          await win.setTitle(`Birleştiriliyor %${Math.round(mergePct)} ${task.filename} - Mak Download Manager`);
          await win.setSize(new LogicalSize(560, showDetails ? 500 : 300));
        } else {
          const rawPct =
            task.total_bytes && task.total_bytes > 0
              ? Math.min(100, Math.round((task.downloaded_bytes / task.total_bytes) * 100))
              : 0;
          const pct = task.status === 'downloading' ? Math.min(99, rawPct) : rawPct;
          await win.setTitle(`%${pct} ${task.filename} - Mak Download Manager`);
          await win.setSize(new LogicalSize(560, showDetails ? 500 : 300));
        }
      } catch (e) {
        console.warn('Window size update warning:', e);
      }
    })();
  }, [isStandalone, isOpen, task?.filename, task?.downloaded_bytes, task?.total_bytes, task?.status, task?.merging, task?.merge_progress, showDetails]);

  if (!isOpen || !task) return null;

  const rawPercent =
    task.total_bytes && task.total_bytes > 0
      ? Math.min(100, Math.max(0, (task.downloaded_bytes / task.total_bytes) * 100))
      : 0;
  const percent = task.status === 'downloading' && !task.merging ? Math.min(99.9, rawPercent) : rawPercent;

  const isCompleted = task.status === 'completed';
  const isDownloading = task.status === 'downloading';
  const isPaused = task.status === 'paused';
  const isVideoTask = Boolean(task.etag && task.etag.startsWith('video:'));
  const isMerging = Boolean(task.merging && !isCompleted);
  const mergePercent = Math.min(100, Math.max(0, task.merge_progress ?? 0));

  const getStatusText = () => {
    if (isMerging) {
      return `Parçalar birleştiriliyor... (%${Math.round(mergePercent)})`;
    }
    switch (task.status) {
      case 'downloading':
        return isVideoTask ? 'Medya akışı indiriliyor...' : 'Veri alınıyor...';
      case 'paused':
        return 'Duraklatıldı';
      case 'completed':
        return 'Tamamlandı';
      case 'failed':
        return `Hata: ${task.error_message || 'İndirme kesildi'}`;
      case 'cancelled':
        return 'İptal edildi';
      case 'probing':
        return 'Sunucuya bağlanılıyor...';
      default:
        return 'Kuyrukta bekliyor...';
    }
  };

  const segmentItems: { index: number; downloaded: number; total: number; info: string }[] = [];
  if (isVideoTask) {
    const isAudioOnly = task.etag?.startsWith('video:audio:') ?? false;
    segmentItems.push({
      index: 1,
      downloaded: task.downloaded_bytes,
      total: task.total_bytes || task.downloaded_bytes,
      info: isCompleted
        ? 'Tamamlandı (yt-dlp / FFmpeg)'
        : isPaused
        ? 'Duraklatıldı'
        : isAudioOnly
        ? 'yt-dlp ses akışı indiriliyor...'
        : 'yt-dlp görüntü + ses akışı indiriliyor...',
    });
  } else if (task.segments && task.segments.length > 0) {
    task.segments.forEach((s) => {
      const segTotal = s.end_byte - s.start_byte + 1;
      let infoText = 'Veri alınıyor...';
      if (isMerging) {
        infoText = 'Parça birleştiriliyor...';
      } else if (s.completed) {
        infoText = 'Tamamlandı';
      } else if (isPaused) {
        infoText = 'Duraklatıldı';
      } else if (s.downloaded_bytes === 0) {
        infoText = 'Bağlantı başlatılıyor...';
      }
      segmentItems.push({
        index: s.index + 1,
        downloaded: s.downloaded_bytes,
        total: segTotal,
        info: infoText,
      });
    });
  } else {
    segmentItems.push({
      index: 1,
      downloaded: task.downloaded_bytes,
      total: task.total_bytes || task.downloaded_bytes,
      info: isCompleted ? 'Tamamlandı' : isPaused ? 'Duraklatıldı' : isDownloading ? 'Tek akış veri alınıyor...' : 'Bekliyor...',
    });
  }

  // Completed View
  if (isCompleted) {
    const completeContent = (
      <div className="flex flex-col h-full bg-[#f0f0f0] dark:bg-[#1f242b] text-slate-800 dark:text-slate-100 font-sans select-none p-4 justify-between">
        <div className="flex items-start justify-between border-b border-slate-300 dark:border-slate-700 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0 border border-emerald-300 dark:border-emerald-800">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white leading-tight">
                İndirme Tamamlandı
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Dosya başarıyla diske kaydedildi.
              </p>
            </div>
          </div>
          {!isStandalone && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500"
              title="Kapat"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="my-3 p-3 bg-white dark:bg-[#181b20] rounded border border-slate-300 dark:border-slate-700 text-xs space-y-2">
          <div className="flex items-start gap-2">
            <span className="font-semibold text-slate-500 dark:text-slate-400 w-24 shrink-0">Dosya Adı:</span>
            <span className="font-medium text-slate-900 dark:text-white break-all">{task.filename}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-500 dark:text-slate-400 w-24 shrink-0">Boyut:</span>
            <span className="font-mono font-medium text-slate-900 dark:text-white tabular-nums">
              {formatBytes(task.total_bytes || task.downloaded_bytes)}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-semibold text-slate-500 dark:text-slate-400 w-24 shrink-0">Klasör / Yol:</span>
            <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300 break-all">{task.destination_path}</span>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-slate-300 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onOpenFile(task.destination_path);
                onClose();
              }}
              className="px-3.5 py-1.5 text-xs font-medium bg-[#0078d7] hover:bg-[#006abc] text-white rounded flex items-center gap-1.5"
            >
              <FileCheck className="w-3.5 h-3.5" />
              Dosyayı Aç
            </button>
            <button
              onClick={() => {
                onOpenFolder(task.destination_path);
                onClose();
              }}
              className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-600 rounded flex items-center gap-1.5"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Klasörü Aç
            </button>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] border border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-200 rounded"
          >
            Kapat
          </button>
        </div>
      </div>
    );

    if (isStandalone) return completeContent;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-lg rounded overflow-hidden shadow-lg border border-slate-300 dark:border-slate-700">
          {completeContent}
        </div>
      </div>
    );
  }

  // Downloading Process View
  const dialogContent = (
    <div className="flex flex-col h-full bg-[#f0f0f0] dark:bg-[#1f242b] text-slate-800 dark:text-slate-100 font-sans select-none">
      {/* Classic Tab Strip */}
      <div className="flex items-center justify-between px-3 pt-2 bg-[#e4e7ec] dark:bg-[#161a20] border-b border-slate-300 dark:border-slate-700 shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('status')}
            className={`px-3 py-1.5 text-xs font-medium rounded-t border-t border-l border-r ${
              activeTab === 'status'
                ? 'bg-[#f0f0f0] dark:bg-[#1f242b] border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white -mb-px'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            İndirme durumu
          </button>
          <button
            onClick={() => setActiveTab('limiter')}
            className={`px-3 py-1.5 text-xs font-medium rounded-t border-t border-l border-r ${
              activeTab === 'limiter'
                ? 'bg-[#f0f0f0] dark:bg-[#1f242b] border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white -mb-px'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            Hız Sınırlayıcı
          </button>
          <button
            onClick={() => setActiveTab('completion')}
            className={`px-3 py-1.5 text-xs font-medium rounded-t border-t border-l border-r ${
              activeTab === 'completion'
                ? 'bg-[#f0f0f0] dark:bg-[#1f242b] border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white -mb-px'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            Tamamlanma seçenekleri
          </button>
        </div>

        {!isStandalone && (
          <button
            onClick={onClose}
            className="p-1 mb-1 rounded hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-500"
            title="Kapat (İndirme arka planda devam eder)"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Tab 1: Download Status */}
      {activeTab === 'status' && (
        <div className="flex-1 flex flex-col p-3 overflow-hidden">
          <div className="space-y-1 text-xs">
            <div className="truncate font-mono text-[11px] text-blue-700 dark:text-blue-400 select-all cursor-text" title={task.url}>
              {task.url}
            </div>

            <div className="flex items-center">
              <span className="w-28 text-slate-600 dark:text-slate-400">Durum:</span>
              <span className={`font-semibold ${isDownloading ? 'text-blue-700 dark:text-blue-400' : isPaused ? 'text-amber-600' : 'text-slate-800 dark:text-slate-200'}`}>
                {getStatusText()}
              </span>
            </div>

            <div className="flex items-center">
              <span className="w-28 text-slate-600 dark:text-slate-400">Dosya boyutu:</span>
              <span className="font-mono font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                {task.total_bytes ? formatBytes(task.total_bytes) : 'Bilinmiyor'}
              </span>
            </div>

            <div className="flex items-center">
              <span className="w-28 text-slate-600 dark:text-slate-400">İndirilen:</span>
              <span className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                {formatBytes(task.downloaded_bytes)}{task.total_bytes && task.total_bytes > 0 ? ` ( %${percent.toFixed(2)} )` : ''}
              </span>
            </div>

            <div className="flex items-center">
              <span className="w-28 text-slate-600 dark:text-slate-400">Aktarım hızı:</span>
              <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                {isDownloading ? formatSpeed(task.speed_bytes_per_sec) : '--'}
              </span>
            </div>

            <div className="flex items-center">
              <span className="w-28 text-slate-600 dark:text-slate-400">Kalan süre:</span>
              <span className="font-mono font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                {isDownloading ? formatEta(task.eta_seconds) : '--:--'}
              </span>
            </div>

            <div className="flex items-center">
              <span className="w-28 text-slate-600 dark:text-slate-400">Devam edebilme:</span>
              <span className={`font-medium ${isVideoTask || task.supports_range ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {isVideoTask ? 'Evet (yt-dlp --continue)' : task.supports_range ? 'Evet' : 'Hayır (Tek Parça)'}
              </span>
            </div>
          </div>

          {/* Flat Classic IDM Progress Bar */}
          <div className="my-2.5">
            {isMerging && (
              <div className="flex items-center justify-between text-[11px] font-semibold text-blue-700 dark:text-blue-400 mb-1">
                <span>Parçalar tek dosyada birleştiriliyor...</span>
                <span className="font-mono tabular-nums">%{mergePercent.toFixed(0)}</span>
              </div>
            )}
            <div className="w-full h-4 bg-white dark:bg-[#15181c] rounded-[2px] border border-slate-400 dark:border-slate-600 p-[1px] overflow-hidden">
              <div
                className={
                  isMerging
                    ? 'h-full bg-[#0078d7] transition-all duration-75'
                    : 'h-full bg-[#16a34a] transition-all duration-200'
                }
                style={{ width: `${isMerging ? mergePercent : percent}%` }}
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between pb-2 shrink-0">
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-600 rounded flex items-center gap-1"
            >
              {showDetails ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Detayları Gizle
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  Detayları Göster
                </>
              )}
            </button>

            <div className="flex items-center gap-2">
              {isDownloading ? (
                <button
                  onClick={() => onPause(task.id)}
                  className="px-3.5 py-1 text-xs font-medium bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-600 rounded flex items-center gap-1"
                >
                  <Pause className="w-3.5 h-3.5 text-amber-600" />
                  Duraklat
                </button>
              ) : (
                <button
                  onClick={() => onResume(task.id)}
                  className="px-3.5 py-1 text-xs font-medium bg-[#0078d7] hover:bg-[#006abc] text-white rounded flex items-center gap-1"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Devam Et
                </button>
              )}

              <button
                onClick={() => onCancel(task.id)}
                className="px-3.5 py-1 text-xs font-medium bg-white dark:bg-[#232830] hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-slate-300 dark:border-slate-600 rounded"
              >
                İptal
              </button>
            </div>
          </div>

          {/* Connection Details Table */}
          {showDetails && (
            <div className="flex-1 flex flex-col min-h-0 pt-1.5 border-t border-slate-300 dark:border-slate-700">
              <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1 flex items-center justify-between">
                <span>Bağlantılara göre indirme ilerlemesi:</span>
                <span>{isVideoTask ? 'Medya Akışı' : `${segmentItems.length} bağlantı`}</span>
              </div>

              <div className="flex w-full h-3 bg-white dark:bg-[#15181c] border border-slate-400 dark:border-slate-600 rounded-[2px] overflow-hidden mb-2 p-[1px] gap-[1px]">
                {segmentItems.map((seg) => {
                  const segPct = seg.total > 0 ? Math.min(100, Math.max(0, (seg.downloaded / seg.total) * 100)) : 0;
                  return (
                    <div
                      key={seg.index}
                      className="relative flex-1 bg-slate-200 dark:bg-slate-800 h-full overflow-hidden"
                      title={`Bağlantı #${seg.index}: ${formatBytes(seg.downloaded)} (%${segPct.toFixed(1)})`}
                    >
                      <div
                        className="h-full bg-[#0078d7] transition-all duration-200"
                        style={{ width: `${segPct}%` }}
                      />
                    </div>
                  );
                })}
              </div>

              <div className="flex-1 overflow-auto bg-white dark:bg-[#15181c] rounded border border-slate-300 dark:border-slate-700">
                <table className="w-full text-left text-[11px] border-collapse">
                  <thead className="sticky top-0 bg-[#f5f6f8] dark:bg-[#232830] text-slate-700 dark:text-slate-300 border-b border-slate-300 dark:border-slate-700 select-none">
                    <tr>
                      <th className="py-1 px-2.5 w-10">N.</th>
                      <th className="py-1 px-3 w-32">İndirilen</th>
                      <th className="py-1 px-3">Bilgi / Durum</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {segmentItems.map((s) => (
                      <tr key={s.index} className="hover:bg-blue-50/50 dark:hover:bg-slate-800/50">
                        <td className="py-1 px-2.5 font-mono text-slate-500 tabular-nums">{s.index}</td>
                        <td className="py-1 px-3 font-mono font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                          {formatBytes(s.downloaded)}
                        </td>
                        <td className="py-1 px-3 text-slate-600 dark:text-slate-400 truncate">
                          {s.info}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Speed Limiter */}
      {activeTab === 'limiter' && (
        <div className="flex-1 p-4 space-y-4 text-xs">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enable-limiter"
              checked={isLimiterEnabled}
              onChange={(e) => {
                const checked = e.target.checked;
                setIsLimiterEnabled(checked);
                applySpeedLimit(checked, limitKbps);
              }}
              className="rounded border-slate-300 text-[#0078d7] focus:ring-0 cursor-pointer"
            />
            <label htmlFor="enable-limiter" className="font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">
              Küresel hız sınırını etkinleştir
            </label>
          </div>

          <div className="pl-6 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Maksimum indirme hızı:</span>
              <input
                type="number"
                min={16}
                disabled={!isLimiterEnabled}
                value={limitKbps}
                onChange={(e) => setLimitKbps(Math.max(16, Number(e.target.value) || 16))}
                className="w-24 px-2 py-1 bg-white dark:bg-[#15181c] border border-slate-300 dark:border-slate-600 rounded text-right font-mono tabular-nums disabled:opacity-50"
              />
              <span className="font-medium text-slate-600 dark:text-slate-400">KB/sn</span>
              <button
                type="button"
                disabled={!isLimiterEnabled}
                onClick={() => applySpeedLimit(true, limitKbps)}
                className="px-3 py-1 rounded bg-[#0078d7] hover:bg-[#006abc] text-white text-xs font-medium disabled:opacity-50"
              >
                Uygula
              </button>
            </div>
            {limiterSavedMsg && (
              <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                {limiterSavedMsg}
              </p>
            )}
            <p className="text-slate-500 text-[11px]">
              HTTP indirmeleri için aktif bant genişliği kullanımını anlık olarak sınırlar.
            </p>
          </div>
        </div>
      )}

      {/* Tab 3: Completion Options */}
      {activeTab === 'completion' && (
        <div className="flex-1 p-4 space-y-3 text-xs">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="opt-close-dialog"
              checked={closeOnComplete}
              onChange={(e) => setCloseOnComplete(e.target.checked)}
              className="rounded border-slate-300 text-[#0078d7] focus:ring-0 cursor-pointer"
            />
            <label htmlFor="opt-close-dialog" className="font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
              İndirme tamamlandığında bu iletişim kutusunu kapat
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="opt-open-file"
              checked={openFileOnComplete}
              onChange={(e) => setOpenFileOnComplete(e.target.checked)}
              className="rounded border-slate-300 text-[#0078d7] focus:ring-0 cursor-pointer"
            />
            <label htmlFor="opt-open-file" className="font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
              İndirme tamamlandığında dosyayı otomatik aç
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="opt-play-sound"
              checked={playSoundOnComplete}
              onChange={(e) => setPlaySoundOnComplete(e.target.checked)}
              className="rounded border-slate-300 text-[#0078d7] focus:ring-0 cursor-pointer"
            />
            <label htmlFor="opt-play-sound" className="font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
              İndirme tamamlandığında bildirim sesi çal
            </label>
          </div>
        </div>
      )}
    </div>
  );

  if (isStandalone) return dialogContent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded overflow-hidden shadow-lg border border-slate-300 dark:border-slate-700">
        {dialogContent}
      </div>
    </div>
  );
};

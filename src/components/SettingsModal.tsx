import React, { useState, useEffect } from 'react';
import {
  X,
  Settings as SettingsIcon,
  FolderOpen,
  Moon,
  Sun,
  Check,
  Video,
  DownloadCloud,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { AppSettings, AppUpdateInfo, ToolStatus } from '../types/download';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (newSettings: AppSettings) => Promise<void>;
  onGetToolStatus?: () => Promise<ToolStatus>;
  onInstallYtdlp?: () => Promise<string>;
  initialUpdateInfo?: AppUpdateInfo | null;
}

const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

export const SettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  settings,
  onSave,
  onGetToolStatus,
  onInstallYtdlp,
  initialUpdateInfo = null,
}) => {
  const [current, setCurrent] = useState<AppSettings>(settings);
  const [isSaving, setIsSaving] = useState(false);
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [isUpdatingYtdlp, setIsUpdatingYtdlp] = useState(false);
  const [toolMessage, setToolMessage] = useState<string | null>(null);

  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(initialUpdateInfo);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateProgressPct, setUpdateProgressPct] = useState<number>(0);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCurrent(settings);
      if (initialUpdateInfo) {
        setUpdateInfo(initialUpdateInfo);
      }
      if (onGetToolStatus) {
        onGetToolStatus().then(setToolStatus).catch(console.error);
      }
    }
  }, [isOpen, settings, onGetToolStatus, initialUpdateInfo]);

  useEffect(() => {
    if (!isOpen || !isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{ percent?: number }>('app-update-progress', (ev) => {
          if (typeof ev.payload?.percent === 'number') {
            setUpdateProgressPct(Math.min(100, Math.max(0, ev.payload.percent)));
          }
        });
      } catch {}
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const speedLimitKbps = current.global_speed_limit_bytes
    ? Math.round(current.global_speed_limit_bytes / 1024)
    : 0;

  const handleBrowseFolder = async () => {
    if (!isTauri) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const selected = await invoke<string | null>('pick_folder');
      if (selected && selected.trim()) {
        setCurrent((prev) => ({ ...prev, default_download_dir: selected.trim() }));
      }
    } catch (e) {
      console.error('pick_folder hatası:', e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSaving(true);
      await onSave(current);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateYtdlp = async () => {
    if (!onInstallYtdlp) return;
    try {
      setIsUpdatingYtdlp(true);
      setToolMessage(null);
      const newVersion = await onInstallYtdlp();
      setToolMessage(`yt-dlp güncellendi: ${newVersion}`);
      if (onGetToolStatus) {
        const updated = await onGetToolStatus();
        setToolStatus(updated);
      }
    } catch (err: any) {
      setToolMessage(`Hata: ${err?.message || String(err)}`);
    } finally {
      setIsUpdatingYtdlp(false);
    }
  };

  const handleCheckUpdate = async () => {
    if (!isTauri) {
      setUpdateMessage('Güncelleme denetimi yalnızca masaüstü uygulamasında çalışır.');
      return;
    }
    try {
      setIsCheckingUpdate(true);
      setUpdateMessage(null);
      const { invoke } = await import('@tauri-apps/api/core');
      const info = await invoke<AppUpdateInfo>('check_app_update');
      setUpdateInfo(info);
      if (info.update_available) {
        setUpdateMessage(`Yeni sürüm bulundu: v${info.latest_version}`);
      } else {
        setUpdateMessage(`Uygulamanız güncel (v${info.current_version}).`);
      }
    } catch (err: any) {
      setUpdateMessage(`Hata: ${err?.message || String(err)}`);
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!isTauri || !updateInfo?.download_url) return;
    try {
      setIsInstallingUpdate(true);
      setUpdateProgressPct(0);
      setUpdateMessage('Güncelleme paketi indiriliyor, kurulum otomatik başlatılacak...');
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('install_app_update', {
        downloadUrl: updateInfo.download_url,
        sha256: updateInfo.sha256 || null,
      });
    } catch (err: any) {
      setIsInstallingUpdate(false);
      setUpdateMessage(`Güncelleme başarısız: ${err?.message || String(err)}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="relative w-full max-w-lg rounded border border-slate-300 dark:border-slate-700 bg-[#f5f6f8] dark:bg-[#1f242b] shadow-lg text-slate-800 dark:text-slate-100 max-h-[90vh] overflow-y-auto">
        {/* Title Bar */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#e8ecf1] dark:bg-[#161a20] border-b border-slate-300 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-4 h-4 text-slate-700 dark:text-slate-300" />
            <h2 className="text-xs font-bold text-slate-900 dark:text-white">Ayarlar ve Araçlar</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700"
            title="Kapat"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4 text-xs">
          {/* Default Directory */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Varsayılan İndirme Klasörü
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={current.default_download_dir}
                onChange={(e) =>
                  setCurrent({ ...current, default_download_dir: e.target.value })
                }
                className="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#15181c] font-mono focus:outline-none focus:border-[#0078d7]"
              />
              <button
                type="button"
                onClick={handleBrowseFolder}
                disabled={!isTauri}
                title="Klasör Seç"
                className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] text-slate-700 dark:text-slate-200 flex items-center gap-1 disabled:opacity-50"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Gözat</span>
              </button>
            </div>
          </div>

          {/* Concurrency, Segments & Global Speed Limit */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Eşzamanlı İndirme
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={current.max_concurrent_downloads}
                onChange={(e) =>
                  setCurrent({
                    ...current,
                    max_concurrent_downloads: Math.max(1, parseInt(e.target.value) || 1),
                  })
                }
                className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#15181c] font-mono tabular-nums focus:outline-none focus:border-[#0078d7]"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Bağlantı Sayısı
              </label>
              <select
                value={current.default_segments}
                onChange={(e) =>
                  setCurrent({ ...current, default_segments: parseInt(e.target.value) })
                }
                className="w-full px-2 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#15181c] focus:outline-none focus:border-[#0078d7]"
              >
                <option value={1}>1 Bağlantı</option>
                <option value={2}>2 Bağlantı</option>
                <option value={4}>4 Bağlantı (Önerilen)</option>
                <option value={8}>8 Bağlantı</option>
                <option value={16}>16 Bağlantı</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Hız Sınırı (KB/sn)
              </label>
              <input
                type="number"
                min={0}
                placeholder="0 = Sınırsız"
                value={speedLimitKbps}
                onChange={(e) => {
                  const kbps = Math.max(0, parseInt(e.target.value) || 0);
                  setCurrent({
                    ...current,
                    global_speed_limit_bytes: kbps > 0 ? kbps * 1024 : null,
                  });
                }}
                className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#15181c] font-mono tabular-nums focus:outline-none focus:border-[#0078d7]"
              />
            </div>
          </div>

          {/* Video Tools */}
          <div className="p-3 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#181b20] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Video className="w-4 h-4 text-slate-600 dark:text-slate-300" />
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Video Araçları (yt-dlp ve FFmpeg)
                </span>
              </div>
              {onInstallYtdlp && (
                <button
                  type="button"
                  onClick={handleUpdateYtdlp}
                  disabled={isUpdatingYtdlp}
                  className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-600 bg-[#f5f6f8] dark:bg-[#232830] hover:bg-slate-200 dark:hover:bg-[#2c323c] text-slate-800 dark:text-slate-100 flex items-center gap-1 disabled:opacity-50"
                >
                  {isUpdatingYtdlp ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <DownloadCloud className="w-3 h-3" />
                  )}
                  <span>yt-dlp İndir / Güncelle</span>
                </button>
              )}
            </div>

            {toolMessage && (
              <p className="text-[11px] p-2 rounded bg-slate-100 dark:bg-slate-900 font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                {toolMessage}
              </p>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              <div className="p-2 rounded border border-slate-200 dark:border-slate-700 bg-[#f8f9fa] dark:bg-[#1f242b]">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold">yt-dlp</span>
                  {toolStatus?.ytdlp_installed ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                      <CheckCircle2 className="w-3 h-3" /> Yüklü
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                      <AlertTriangle className="w-3 h-3" /> Yok
                    </span>
                  )}
                </div>
                <p className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {toolStatus?.ytdlp_version ? `Sürüm: ${toolStatus.ytdlp_version}` : 'Bulunamadı'}
                </p>
              </div>

              <div className="p-2 rounded border border-slate-200 dark:border-slate-700 bg-[#f8f9fa] dark:bg-[#1f242b]">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold">FFmpeg</span>
                  {toolStatus?.ffmpeg_installed ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                      <CheckCircle2 className="w-3 h-3" /> Yüklü
                    </span>
                  ) : (
                    <span className="text-slate-500 dark:text-slate-400 font-medium">
                      Bulunamadı
                    </span>
                  )}
                </div>
                <p className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {toolStatus?.ffmpeg_installed ? 'Video/ses birleştirme hazır' : 'Gerekli araç'}
                </p>
              </div>
            </div>
          </div>

          {/* App Auto-Update (GitHub Releases) */}
          <div className="p-3 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#181b20] space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <RefreshCw className="w-4 h-4 text-[#0078d7]" />
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Uygulama Güncelleme
                </span>
                <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  v{updateInfo?.current_version || '0.1.0'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {updateInfo?.update_available && updateInfo.download_url && (
                  <button
                    type="button"
                    onClick={handleInstallUpdate}
                    disabled={isInstallingUpdate || isCheckingUpdate}
                    className="px-2.5 py-1 text-[11px] font-medium rounded bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1 disabled:opacity-50"
                  >
                    {isInstallingUpdate ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <DownloadCloud className="w-3 h-3" />
                    )}
                    <span>Şimdi Güncelle (v{updateInfo.latest_version})</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCheckUpdate}
                  disabled={isCheckingUpdate || isInstallingUpdate}
                  className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-600 bg-[#f5f6f8] dark:bg-[#232830] hover:bg-slate-200 dark:hover:bg-[#2c323c] text-slate-800 dark:text-slate-100 flex items-center gap-1 disabled:opacity-50"
                >
                  {isCheckingUpdate ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3 h-3" />
                  )}
                  <span>Güncellemeleri Denetle</span>
                </button>
              </div>
            </div>

            {updateMessage && (
              <p className="text-[11px] p-2 rounded bg-slate-100 dark:bg-slate-900 font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                {updateMessage}
              </p>
            )}

            {updateInfo?.update_available && updateInfo.release_notes && (
              <div className="text-[11px] p-2 rounded bg-blue-50/70 dark:bg-blue-950/30 text-slate-700 dark:text-slate-300 border border-blue-200 dark:border-blue-800/60 max-h-24 overflow-y-auto whitespace-pre-wrap">
                {updateInfo.release_notes}
              </div>
            )}

            {isInstallingUpdate && (
              <div className="space-y-1">
                <div className="w-full h-2 rounded bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-[#0078d7] transition-all duration-150"
                    style={{ width: `${updateProgressPct}%` }}
                  />
                </div>
                <p className="text-[10.5px] text-right font-mono text-slate-500">
                  %{Math.round(updateProgressPct)} indirildi
                </p>
              </div>
            )}
          </div>

          {/* Theme */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Görünüm Teması
            </label>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setCurrent({ ...current, theme: 'dark' })}
                className={`flex items-center justify-center gap-1.5 py-1.5 rounded border text-xs font-medium transition-colors ${
                  current.theme === 'dark'
                    ? 'bg-[#0078d7] text-white border-[#0078d7]'
                    : 'bg-white dark:bg-[#181b20] text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>Koyu Tema</span>
              </button>
              <button
                type="button"
                onClick={() => setCurrent({ ...current, theme: 'light' })}
                className={`flex items-center justify-center gap-1.5 py-1.5 rounded border text-xs font-medium transition-colors ${
                  current.theme === 'light'
                    ? 'bg-[#0078d7] text-white border-[#0078d7]'
                    : 'bg-white dark:bg-[#181b20] text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span>Açık Tema</span>
              </button>
            </div>
          </div>

          {/* Footer Buttons */}
          <div className="pt-3 border-t border-slate-300 dark:border-slate-700 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] text-slate-700 dark:text-slate-200"
            >
              İptal
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded bg-[#0078d7] hover:bg-[#006abc] text-white disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Kaydet</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

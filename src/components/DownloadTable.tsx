import React from 'react';
import { DownloadTask } from '../types/download';
import { formatBytes, formatSpeed, formatEta } from '../utils/formatters';
import { StatusBadge } from './StatusBadge';
import { SegmentVisualizer } from './SegmentVisualizer';
import {
  Play,
  Pause,
  RotateCcw,
  FolderOpen,
  Trash2,
  ExternalLink,
  Square,
  FileArchive,
  FileCode,
  FileVideo,
  FileAudio,
  FileSpreadsheet,
  FileText,
  File,
  Disc,
} from 'lucide-react';

interface Props {
  tasks: DownloadTask[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelectTask?: (task: DownloadTask) => void;
}

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'zst':
      return <FileArchive className="w-4 h-4 text-amber-600 dark:text-amber-400" />;
    case 'exe':
    case 'msi':
    case 'bat':
      return <FileCode className="w-4 h-4 text-blue-600 dark:text-blue-400" />;
    case 'iso':
    case 'img':
      return <Disc className="w-4 h-4 text-slate-600 dark:text-slate-300" />;
    case 'mp4':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'webm':
      return <FileVideo className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />;
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'm4a':
      return <FileAudio className="w-4 h-4 text-rose-600 dark:text-rose-400" />;
    case 'pdf':
    case 'doc':
    case 'docx':
    case 'txt':
      return <FileText className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />;
    case 'xls':
    case 'xlsx':
    case 'csv':
      return <FileSpreadsheet className="w-4 h-4 text-green-600 dark:text-green-400" />;
    default:
      return <File className="w-4 h-4 text-slate-400" />;
  }
}

export const DownloadTable: React.FC<Props> = ({
  tasks,
  onPause,
  onResume,
  onRetry,
  onCancel,
  onRemove,
  onOpenFolder,
  onOpenFile,
  onSelectTask,
}) => {
  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-10 text-center select-none">
        <div className="w-12 h-12 rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 flex items-center justify-center text-slate-400 mb-3">
          <File className="w-6 h-6 stroke-1" />
        </div>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
          Kayıtlı indirme yok
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mt-1">
          Bu görünümde gösterilecek görev bulunamadı. "URL Ekle" düğmesine tıklayarak yeni bir indirme başlatabilirsiniz.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-white dark:bg-[#181b20]">
      <table className="w-full text-left text-xs border-collapse">
        <thead className="sticky top-0 bg-[#f5f6f8] dark:bg-[#1f242b] border-b border-slate-300 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 select-none z-10">
          <tr>
            <th className="py-2 px-3 w-[270px] border-r border-slate-200 dark:border-slate-800">Dosya Adı</th>
            <th className="py-2 px-2.5 w-[110px] border-r border-slate-200 dark:border-slate-800">Durum</th>
            <th className="py-2 px-3 min-w-[180px] border-r border-slate-200 dark:border-slate-800">İlerleme</th>
            <th className="py-2 px-2.5 w-[145px] border-r border-slate-200 dark:border-slate-800">Boyut</th>
            <th className="py-2 px-2.5 w-[95px] border-r border-slate-200 dark:border-slate-800">Hız</th>
            <th className="py-2 px-2.5 w-[80px] border-r border-slate-200 dark:border-slate-800">Kalan Süre</th>
            <th className="py-2 px-3 text-right w-[130px]">İşlemler</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
          {tasks.map((task) => {
            const percent =
              task.total_bytes && task.total_bytes > 0
                ? Math.min(100, Math.max(0, (task.downloaded_bytes / task.total_bytes) * 100))
                : 0;

            return (
              <tr
                key={task.id}
                onDoubleClick={() => {
                  if (onSelectTask) {
                    onSelectTask(task);
                  } else if (task.status === 'completed') {
                    onOpenFile(task.destination_path);
                  }
                }}
                className="hover:bg-blue-50/60 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
              >
                {/* Dosya Adı & Konum */}
                <td className="py-2 px-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0">
                      {getFileIcon(task.filename)}
                    </div>
                    <div className="min-w-0">
                      <div
                        className="font-medium text-slate-900 dark:text-slate-100 truncate text-xs"
                        title={task.filename}
                      >
                        {task.filename}
                      </div>
                      <div
                        className="text-[10.5px] text-slate-400 dark:text-slate-500 truncate max-w-[225px]"
                        title={task.destination_path}
                      >
                        {task.destination_path}
                      </div>
                      {task.error_message && (
                        <div className="text-[10.5px] text-rose-600 dark:text-rose-400 truncate mt-0.5" title={task.error_message}>
                          {task.error_message}
                        </div>
                      )}
                    </div>
                  </div>
                </td>

                {/* Durum */}
                <td className="py-2 px-2.5">
                  <StatusBadge status={task.status} />
                </td>

                {/* İlerleme */}
                <td className="py-2 px-3">
                  <SegmentVisualizer
                    segments={task.segments}
                    totalBytes={task.total_bytes}
                    overallPercent={percent}
                  />
                </td>

                {/* Boyut */}
                <td className="py-2 px-2.5 text-[11.5px] text-slate-700 dark:text-slate-200 font-mono tabular-nums whitespace-nowrap">
                  <div>{formatBytes(task.downloaded_bytes)}</div>
                  <div className="text-[10.5px] text-slate-400 dark:text-slate-500">
                    / {task.total_bytes ? formatBytes(task.total_bytes) : 'Bilinmiyor'}
                  </div>
                </td>

                {/* Hız */}
                <td className="py-2 px-2.5 text-[11.5px] font-mono tabular-nums whitespace-nowrap">
                  {task.status === 'downloading' ? (
                    <span className="text-blue-600 dark:text-blue-400 font-semibold">
                      {formatSpeed(task.speed_bytes_per_sec)}
                    </span>
                  ) : (
                    <span className="text-slate-400">--</span>
                  )}
                </td>

                {/* Kalan Süre */}
                <td className="py-2 px-2.5 text-[11.5px] font-mono tabular-nums text-slate-600 dark:text-slate-400 whitespace-nowrap">
                  {task.status === 'downloading' ? formatEta(task.eta_seconds) : '--:--'}
                </td>

                {/* İşlemler */}
                <td className="py-2 px-3 text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-0.5">
                    {task.status === 'downloading' && (
                      <button
                        onClick={() => onPause(task.id)}
                        title="Duraklat"
                        className="p-1.5 rounded text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
                      >
                        <Pause className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {task.status === 'paused' && (
                      <button
                        onClick={() => onResume(task.id)}
                        title="Devam Et"
                        className="p-1.5 rounded text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {(task.status === 'failed' || task.status === 'cancelled') && (
                      <button
                        onClick={() => onRetry(task.id)}
                        title="Yeniden Dene"
                        className="p-1.5 rounded text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {task.status === 'completed' && (
                      <button
                        onClick={() => onOpenFile(task.destination_path)}
                        title="Dosyayı Aç"
                        className="p-1.5 rounded text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {(task.status === 'downloading' || task.status === 'paused' || task.status === 'queued') && (
                      <button
                        onClick={() => onCancel(task.id)}
                        title="İptal Et"
                        className="p-1.5 rounded text-rose-500 hover:bg-rose-100 dark:hover:bg-rose-950/50 transition-colors"
                      >
                        <Square className="w-3 h-3" />
                      </button>
                    )}

                    <button
                      onClick={() => onOpenFolder(task.destination_path)}
                      title="Klasörü Aç"
                      className="p-1.5 rounded text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => onRemove(task.id)}
                      title="Listeden Kaldır"
                      className="p-1.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-100 dark:hover:bg-rose-950/50 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

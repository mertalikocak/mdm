import React from 'react';
import {
  Plus,
  Play,
  Pause,
  Trash2,
  Search,
} from 'lucide-react';
import { formatSpeed } from '../utils/formatters';

interface Props {
  onOpenAddModal: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onClearCompleted: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  totalSpeed: number;
  activeCount: number;
}

export const Navbar: React.FC<Props> = ({
  onOpenAddModal,
  onPauseAll,
  onResumeAll,
  onClearCompleted,
  searchQuery,
  onSearchChange,
  totalSpeed,
  activeCount,
}) => {
  return (
    <header className="h-12 px-4 border-b border-slate-300 dark:border-slate-700/80 bg-[#f5f6f8] dark:bg-[#1f242b] flex items-center justify-between gap-3 select-none shrink-0">
      {/* Left: Classic Desktop Toolbar Buttons */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onOpenAddModal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#0078d7] hover:bg-[#006abc] active:bg-[#005aa0] text-white font-medium text-xs transition-colors"
        >
          <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
          <span>URL Ekle</span>
        </button>

        <div className="h-5 w-px bg-slate-300 dark:bg-slate-700 mx-1" />

        <button
          onClick={onResumeAll}
          title="Tüm İndirmeleri Başlat"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-slate-700/70 border border-transparent hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
        >
          <Play className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          <span className="hidden lg:inline">Devam Et</span>
        </button>

        <button
          onClick={onPauseAll}
          title="Tüm İndirmeleri Duraklat"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-slate-700/70 border border-transparent hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
        >
          <Pause className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          <span className="hidden lg:inline">Duraklat</span>
        </button>

        <button
          onClick={onClearCompleted}
          title="Tamamlananları Listeden Temizle"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-slate-700/70 border border-transparent hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          <span className="hidden lg:inline">Temizle</span>
        </button>
      </div>

      {/* Middle: Compact Search Box */}
      <div className="relative flex-1 max-w-sm">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Dosya adı veya bağlantı ara..."
          className="w-full pl-8 pr-3 py-1 text-xs rounded bg-white dark:bg-[#15181c] border border-slate-300 dark:border-slate-700 focus:border-[#0078d7] text-slate-800 dark:text-slate-200 placeholder-slate-400 outline-none"
        />
      </div>

      {/* Right: Clean Tabular Speed & Active Counter */}
      <div className="flex items-center gap-2.5 px-2.5 py-1 rounded bg-white dark:bg-[#15181c] border border-slate-300 dark:border-slate-700 text-xs tabular-nums">
        <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              activeCount > 0 ? 'bg-emerald-500' : 'bg-slate-400'
            }`}
          />
          <span>{activeCount} aktif</span>
        </span>
        <span className="text-slate-300 dark:text-slate-600">|</span>
        <span className="font-mono font-semibold text-slate-800 dark:text-slate-100 min-w-[74px] text-right">
          {formatSpeed(totalSpeed)}
        </span>
      </div>
    </header>
  );
};

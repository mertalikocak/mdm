import React from 'react';
import {
  Download,
  ArrowDownCircle,
  CheckCircle2,
  Clock,
  AlertCircle,
  Video,
  Settings,
  Sun,
  Moon,
  FolderKanban,
} from 'lucide-react';
import { FilterCategory } from '../types/download';

interface Props {
  activeCategory: FilterCategory;
  onSelectCategory: (cat: FilterCategory) => void;
  counts: Record<FilterCategory, number>;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export const Sidebar: React.FC<Props> = ({
  activeCategory,
  onSelectCategory,
  counts,
  theme,
  onToggleTheme,
  onOpenSettings,
}) => {
  const navItems: { id: FilterCategory; label: string; icon: React.ReactNode }[] = [
    {
      id: 'all',
      label: 'Tüm İndirmeler',
      icon: <FolderKanban className="w-4 h-4" />,
    },
    {
      id: 'downloading',
      label: 'İndirilenler',
      icon: <ArrowDownCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />,
    },
    {
      id: 'completed',
      label: 'Tamamlananlar',
      icon: <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />,
    },
    {
      id: 'queued',
      label: 'Kuyrukta',
      icon: <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400" />,
    },
    {
      id: 'failed',
      label: 'Hatalı / İptal',
      icon: <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />,
    },
    {
      id: 'video',
      label: 'Video İndirmeleri',
      icon: <Video className="w-4 h-4 text-slate-600 dark:text-slate-300" />,
    },
  ];

  return (
    <aside className="w-14 md:w-44 lg:w-52 flex flex-col border-r border-slate-300 dark:border-slate-700/80 bg-[#f0f2f5] dark:bg-[#1a1e24] select-none shrink-0 transition-all">
      {/* Classic Brand Header */}
      <div className="h-12 px-2 md:px-3 flex items-center justify-center md:justify-start gap-2.5 border-b border-slate-300 dark:border-slate-700/80 bg-[#e8ecf1] dark:bg-[#161a20]">
        <div className="flex items-center justify-center w-7 h-7 rounded bg-[#0078d7] text-white shrink-0">
          <Download className="w-4 h-4 stroke-[2.2]" />
        </div>
        <div className="hidden md:block min-w-0">
          <div className="font-bold text-slate-900 dark:text-white text-xs leading-tight truncate">
            Mak Download Manager
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">
            Sürüm 0.1
          </div>
        </div>
      </div>

      {/* Category Navigation */}
      <nav className="flex-1 p-1.5 md:p-2 space-y-0.5 overflow-y-auto">
        <div className="hidden md:block px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Kategoriler
        </div>
        {navItems.map((item) => {
          const isActive = activeCategory === item.id;
          const count = counts[item.id] || 0;

          return (
            <button
              key={item.id}
              onClick={() => onSelectCategory(item.id)}
              title={item.label}
              className={`w-full flex items-center justify-center md:justify-between px-2 md:px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-[#0078d7] text-white'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800/70'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`shrink-0 ${isActive ? 'text-white' : ''}`}>{item.icon}</span>
                <span className="hidden md:inline truncate">{item.label}</span>
              </div>
              <span
                className={`hidden md:inline text-[11px] px-1.5 py-0.2 rounded tabular-nums shrink-0 ${
                  isActive
                    ? 'bg-white/20 text-white'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Bottom Controls */}
      <div className="p-1.5 md:p-2 border-t border-slate-300 dark:border-slate-700/80 flex flex-col md:flex-row items-center justify-between gap-1.5">
        <button
          onClick={onOpenSettings}
          title="Ayarlar"
          className="w-full md:flex-1 flex items-center justify-center gap-1.5 px-2 md:px-2.5 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] text-slate-700 dark:text-slate-200 transition-colors"
        >
          <Settings className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden md:inline">Ayarlar</span>
        </button>

        <button
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Açık Temaya Geç' : 'Koyu Temaya Geç'}
          aria-label="Tema değiştir"
          className="w-full md:w-auto flex items-center justify-center p-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#232830] hover:bg-slate-100 dark:hover:bg-[#2c323c] text-slate-700 dark:text-slate-200 transition-colors"
        >
          {theme === 'dark' ? (
            <Sun className="w-3.5 h-3.5 text-amber-400" />
          ) : (
            <Moon className="w-3.5 h-3.5 text-slate-700" />
          )}
        </button>
      </div>
    </aside>
  );
};

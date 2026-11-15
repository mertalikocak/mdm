import React from 'react';
import { SegmentProgress } from '../types/download';

interface Props {
  segments: SegmentProgress[];
  totalBytes: number | null;
  overallPercent: number;
}

export const SegmentVisualizer: React.FC<Props> = ({ segments, totalBytes, overallPercent }) => {
  const safePercent = Math.min(100, Math.max(0, overallPercent));

  if (!segments || segments.length <= 1) {
    return (
      <div className="flex flex-col gap-1 w-full">
        <div className="w-full h-2.5 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-[2px] overflow-hidden">
          <div
            className="h-full bg-[#16a34a] transition-all duration-200"
            style={{ width: `${safePercent}%` }}
          />
        </div>
        <div className="flex justify-between items-center text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
          <span>{totalBytes ? 'Tek akış' : 'Boyut hesaplanıyor'}</span>
          <span>%{safePercent.toFixed(1)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex gap-[1px] h-2.5 w-full bg-slate-300 dark:bg-slate-700 border border-slate-300 dark:border-slate-700 rounded-[2px] overflow-hidden">
        {segments.map((seg) => {
          const segTotal = seg.end_byte - seg.start_byte + 1;
          const segPct = segTotal > 0 ? Math.min(100, Math.max(0, (seg.downloaded_bytes / segTotal) * 100)) : 0;
          return (
            <div
              key={seg.index}
              className="relative flex-1 bg-slate-100 dark:bg-slate-900 overflow-hidden h-full"
              title={`Parça #${seg.index + 1}: %${segPct.toFixed(1)}`}
            >
              <div
                className={`h-full transition-all duration-200 ${
                  seg.completed ? 'bg-[#16a34a]' : 'bg-[#0078d7]'
                }`}
                style={{ width: `${segPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between items-center text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
        <span>{segments.length} parça</span>
        <span>%{safePercent.toFixed(1)}</span>
      </div>
    </div>
  );
};

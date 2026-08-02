import { useMemo } from 'react';
import type { TaskEvent } from './api.ts';

const CELLS = 120; // 累计时间线压缩格数
const SILENT_MS = 10_000; // 超过该间隔的格子显示为"静默空洞"
const WINDOW = 60; // 最近间隔条展示的 chunk 数

/** 间隔时间线：任务节奏的"心电图"——累计时间线（整任务压缩）+ 最近间隔条 */
export default function TimelineStrip({ events }: { events: TaskEvent[] }) {
  const outputs = useMemo(() => events.filter((e) => e.type === 'output'), [events]);

  const cumulative = useMemo(() => {
    if (outputs.length < 2) return null;
    const start = outputs[0].ts;
    const end = outputs[outputs.length - 1].ts;
    const span = Math.max(end - start, 1);
    const cells: (number | null)[] = new Array(CELLS).fill(null);
    for (const o of outputs) {
      const idx = Math.min(CELLS - 1, Math.floor(((o.ts - start) / span) * CELLS));
      cells[idx] = cells[idx] === null ? o.dt : Math.max(cells[idx]!, o.dt);
    }
    const maxDt = Math.max(...cells.filter((v): v is number => v !== null), 1);
    return { cells, maxDt, span };
  }, [outputs]);

  const recent = useMemo(() => outputs.slice(-WINDOW).map((o) => o.dt), [outputs]);

  if (!cumulative || outputs.length === 0) return null;

  return (
    <div className="timeline">
      <div className="tl-row">
        <span className="tl-label" title="整个任务时间轴上的输出间隔（绿=快 → 红=慢，暗格=静默）">
          全程
        </span>
        <div className="tl-cells">
          {cumulative.cells.map((dt, i) => {
            if (dt === null) return <span key={i} className="tl-cell tl-empty" />;
            const silent = dt >= SILENT_MS;
            const r = Math.min(dt / cumulative.maxDt, 1);
            const hue = 120 - r * 120;
            return (
              <span
                key={i}
                className={`tl-cell${silent ? ' tl-silent' : ''}`}
                style={silent ? undefined : { background: `hsl(${hue} 75% 42%)` }}
                title={silent ? `静默 ${(dt / 1000).toFixed(1)}s` : `间隔 ${(dt / 1000).toFixed(2)}s`}
              />
            );
          })}
        </div>
      </div>
      <div className="tl-row">
        <span className="tl-label" title="最近 60 个输出块的间隔">
          近期
        </span>
        <div className="tl-cells">
          {recent.map((dt, i) => {
            const silent = dt >= SILENT_MS;
            const r = Math.min(dt / 5000, 1);
            const hue = 120 - r * 120;
            return (
              <span
                key={i}
                className={`tl-cell${silent ? ' tl-silent' : ''}`}
                style={silent ? undefined : { background: `hsl(${hue} 80% 45%)` }}
                title={`间隔 ${(dt / 1000).toFixed(2)}s`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

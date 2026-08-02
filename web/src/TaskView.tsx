import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  connectWs,
  fetchEvents,
  fetchTask,
  fmtDur,
  postInput,
  postKill,
  STATUS_LABEL,
  type TaskEvent,
  type TaskMeta,
} from './api.ts';

const GAP_WINDOW = 60; // 间隔热力条展示的最近 chunk 数
const MAX_SILENT = 30000; // 间隔图中最长刻度（>30s 显示为"已截断"）

export default function TaskView({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskMeta | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('connecting');

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const gapsRef = useRef<number[]>([]);
  const outputCountRef = useRef(0);
  const lastSeqRef = useRef(0);
  const runningRef = useRef(false);
  const [, forceRender] = useState(0);

  const bump = useCallback(() => forceRender((n) => n + 1), []);

  const onEvent = useCallback(
    (ev: TaskEvent) => {
      lastSeqRef.current = Math.max(lastSeqRef.current, ev.seq);
      if (ev.type === 'output') {
        termRef.current?.write(ev.data);
        gapsRef.current.push(ev.dt);
        if (gapsRef.current.length > GAP_WINDOW) gapsRef.current.shift();
        outputCountRef.current++;
        bump();
      } else if (ev.type === 'progress') {
        setPct(ev.pct);
        if (ev.msg) setStage(ev.msg);
      } else if (ev.type === 'stage') {
        setStage(ev.name);
      } else if (ev.type === 'status') {
        runningRef.current = false;
        setTask((prev) => (prev ? { ...prev, status: ev.status, exitCode: ev.exitCode, endedAt: ev.ts } : prev));
      }
    },
    [bump],
  );

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      theme: { background: '#0d1117', foreground: '#e6edf3' },
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(document.getElementById('term-host')!);
    fit.fit();
    // 键盘输入 → 转发给正在运行的进程（PTY 输入通道）
    term.onData((data) => {
      if (runningRef.current) void postInput(taskId, data);
    });

    let ws: WebSocket | null = null;
    let closed = false;

    const init = async () => {
      try {
        const meta = await fetchTask(taskId);
        if (closed) return;
        setTask(meta);
        runningRef.current = meta.status === 'running';
        const events = await fetchEvents(taskId, 0);
        for (const ev of events) {
          if (closed) return;
          onEvent(ev);
        }
        // 已结束的任务（非 running）不再连 WS
        if (meta.status !== 'running') return;
        const connect = () => {
          if (closed) return;
          setWsState('connecting');
          ws = connectWs(taskId, lastSeqRef.current, {
            onOpen: () => setWsState('open'),
            onClose: () => {
              if (closed) return;
              setWsState('closed');
              // 断线重连（2s 退避）
              setTimeout(connect, 2000);
            },
            onEvent,
          });
        };
        connect();
      } catch {
        /* 任务不存在等 */
      }
    };
    void init();

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(document.getElementById('term-host')!);
    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    return () => {
      closed = true;
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      ws?.close();
      term.dispose();
      termRef.current = null;
      gapsRef.current = [];
      outputCountRef.current = 0;
    };
  }, [taskId, onEvent]);

  const stats = useMemo(() => {
    const gaps = gapsRef.current;
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    const lastGap = gaps.length ? gaps[gaps.length - 1] : 0;
    const elapsed = task ? (task.endedAt ? task.endedAt - task.startedAt : Date.now() - task.startedAt) : 0;
    return { maxGap, lastGap, elapsed, lines: outputCountRef.current };
  }, [task, bump]);

  const running = task?.status === 'running';

  return (
    <div className="task-view">
      <div className="task-head">
        <div className="task-head-line">
          <span className="task-id big">{taskId}</span>
          {task && <span className={`badge badge-${task.status}`}>{STATUS_LABEL[task.status]}</span>}
          {task && <span className="muted">{task.cmd}</span>}
        </div>
        <div className="stats-bar">
          <Stat label="总时长" value={fmtDur(stats.elapsed)} />
          <Stat label="输出行数" value={String(stats.lines)} />
          <Stat label="最近间隔" value={stats.lastGap < 1000 ? `${Math.round(stats.lastGap)}ms` : `${(stats.lastGap / 1000).toFixed(1)}s`} warn={stats.lastGap > 5000} />
          <Stat label="最长静默" value={stats.maxGap < 1000 ? `${Math.round(stats.maxGap)}ms` : `${(stats.maxGap / 1000).toFixed(1)}s`} warn={stats.maxGap > 10000} />
          {pct !== null && (
            <div className="progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="progress-label">
                {stage ?? '执行中'} {pct}%
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="gap-strip" title="最近 60 个输出块的行间间隔（绿色=快，红色=慢）">
        {stats.lastGap >= 0 &&
          gapsRef.current.map((dt, i) => {
            const r = Math.min(dt / MAX_SILENT, 1);
            const hue = 120 - r * 120;
            return (
              <span
                key={i}
                className="gap-bar"
                style={{ width: `${Math.max(100 / GAP_WINDOW, r * 100)}%`, background: `hsl(${hue} 80% 45%)` }}
                title={`${Math.round(dt)}ms`}
              />
            );
          })}
      </div>

      <div className="term-toolbar">
        <span className={`ws-ind ws-${wsState}`}>
          {wsState === 'open' ? '实时连接' : wsState === 'connecting' ? '连接中…' : '已断开，重连中…'}
        </span>
        <span className="toolbar-spacer" />
        {running && (
          <>
            <button className="btn" onClick={() => void postKill(taskId, 'SIGINT')} title="发送 Ctrl-C（SIGINT），5s 未退自动升级">
              Ctrl-C
            </button>
            <button className="btn btn-danger" onClick={() => void postKill(taskId, 'SIGKILL')} title="强制终止（SIGKILL）">
              强制终止
            </button>
          </>
        )}
      </div>

      <div id="term-host" className="term-host" />
      {running && (
        <div className="term-hint">终端可输入——键盘输入将直接转发给正在运行的进程</div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span className={`stat${warn ? ' warn' : ''}`}>
      <span className="stat-label">{label}</span> {value}
    </span>
  );
}

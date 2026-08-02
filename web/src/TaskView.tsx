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
  postResize,
  STATUS_LABEL,
  type TaskEvent,
  type TaskMeta,
} from './api.ts';
import TimelineStrip from './TimelineStrip.tsx';

export default function TaskView({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskMeta | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [wsState, setWsState] = useState<'idle' | 'connecting' | 'open' | 'closed'>('connecting');
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [termSize, setTermSize] = useState('');
  const [silentMs, setSilentMs] = useState(0);

  const termRef = useRef<Terminal | null>(null);
  const gapsRef = useRef<number[]>([]);
  const outputCountRef = useRef(0);
  const lastSeqRef = useRef(0);
  const runningRef = useRef(false);
  const allEventsRef = useRef<TaskEvent[]>([]);
  const lastOutputTsRef = useRef(0);
  const [, forceRender] = useState(0);

  const bump = useCallback(() => forceRender((n) => n + 1), []);

  const doKill = useCallback(
    async (signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => {
      setActionErr(null);
      setActionOk(null);
      try {
        await postKill(taskId, signal);
        setActionOk(`已发送 ${signal}`);
        setTimeout(() => setActionOk(null), 3000);
      } catch (e) {
        setActionErr((e as Error).message);
      }
    },
    [taskId],
  );

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* clipboard 不可用时忽略 */
      }
    },
    [],
  );

  const onEvent = useCallback(
    (ev: TaskEvent) => {
      lastSeqRef.current = Math.max(lastSeqRef.current, ev.seq);
      allEventsRef.current.push(ev);
      if (allEventsRef.current.length > 20000) allEventsRef.current.splice(0, 5000); // 窗口化防爆
      if (ev.type === 'output') {
        termRef.current?.write(ev.data);
        gapsRef.current.push(ev.dt);
        if (gapsRef.current.length > 60) gapsRef.current.shift();
        outputCountRef.current++;
        lastOutputTsRef.current = ev.ts;
        if (autoScrollRef.current) termRef.current?.scrollToBottom();
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
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      theme: { background: '#0b0f14', foreground: '#e8eaed', cursor: '#4ade80' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    term.open(document.getElementById('term-host')!);
    fit.fit();
    setTermSize(fitSize(fit));
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
        // 分批拉取历史（server 单次 limit 5000，避免大任务截断）
        let after = 0;
        for (;;) {
          const batch = await fetchEvents(taskId, after);
          if (closed) return;
          for (const ev of batch) onEvent(ev);
          if (batch.length < 5000) break;
          after = batch[batch.length - 1].seq;
        }
        // 已结束的任务（非 running）不再连 WS：历史回放模式
        if (meta.status !== 'running') {
          setWsState('idle');
          return;
        }
        const connect = () => {
          if (closed) return;
          setWsState('connecting');
          ws = connectWs(taskId, lastSeqRef.current, {
            onOpen: () => setWsState('open'),
            onClose: () => {
              if (closed) return;
              setWsState('closed');
              setTimeout(connect, 2000);
            },
            onEvent,
          });
        };
        connect();
      } catch {
        setWsState('idle');
      }
    };
    void init();

    // 终端尺寸变化 → fit + 转发 resize 给 PTY（TUI 程序按真实尺寸重排）
    const doFit = () => {
      fit.fit();
      setTermSize(fitSize(fit));
      if (runningRef.current && Number.isFinite(fit.cols)) void postResize(taskId, fit.cols, fit.rows);
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(document.getElementById('term-host')!);
    const onWinResize = () => doFit();
    window.addEventListener('resize', onWinResize);
    setTimeout(doFit, 100);

    // 静默检测（FR-6）：running 时每秒刷新"距最后输出的秒数"，超阈值触发横幅
    const silentTimer = setInterval(() => {
      if (lastOutputTsRef.current > 0) {
        setSilentMs(Date.now() - lastOutputTsRef.current);
      }
    }, 1000);

    return () => {
      closed = true;
      clearInterval(silentTimer);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      ws?.close();
      term.dispose();
      termRef.current = null;
      gapsRef.current = [];
      outputCountRef.current = 0;
      allEventsRef.current = [];
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
  const showProgress = pct !== null || (running && !!stage);

  return (
    <div className="task-view">
      {/* ① 任务头：身份 + 统计 + 操作 */}
      <div className="task-header">
        <div className="th-identity">
          <div className="th-line1">
            <span className="task-id big">{taskId}</span>
            {task && (
              <span className={`badge badge-${task.status}`}>
                <span className="dot" />
                {STATUS_LABEL[task.status]}
              </span>
            )}
          </div>
          <div className="th-cmd" onClick={() => task && void copyText(task.cmd)}>
            {task?.cmd ?? '加载中…'}
            {task && <span className="copy-hint">{copied ? '已复制' : '复制'}</span>}
          </div>
        </div>
        <div className="th-stats">
          <Stat label="总时长" value={fmtDur(stats.elapsed)} />
          <Stat label="输出行数" value={String(stats.lines)} />
          <Stat label="最近间隔" value={fmtGap(stats.lastGap)} warn={stats.lastGap > 5000} />
          <Stat label="最长静默" value={fmtGap(stats.maxGap)} warn={stats.maxGap > 10000} />
        </div>
        <div className="th-actions">
          {actionErr && <span className="action-err">✗ {actionErr}</span>}
          {actionOk && <span className="action-ok">✓ {actionOk}</span>}
          {task && (
            <button className="btn btn-ghost" onClick={() => void copyText(task.id)} title="复制任务 id">
              {copied ? '已复制' : '复制 id'}
            </button>
          )}
          {running && (
            <>
              <button className="btn" onClick={() => void doKill('SIGINT')} title="发送 Ctrl-C（SIGINT），5s 未退自动升级">
                Ctrl-C
              </button>
              <button className="btn btn-danger" onClick={() => void doKill('SIGKILL')} title="强制终止（SIGKILL）">
                强制终止
              </button>
            </>
          )}
        </div>
      </div>

      {/* ② 静默告警：距最后输出超过阈值时醒目提示 */}
      {running && silentMs > 30000 && (
        <div className="silent-banner" title="无输出超过 30 秒">
          已静默 {(silentMs / 1000).toFixed(0)}s——任务可能卡住，可尝试 Ctrl-C
        </div>
      )}

      {/* ③ 进度区：脚本上报 progress/stage 时显示 */}
      {showProgress && (
        <div className="progress-section">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct ?? 0}%` }} />
          </div>
          <span className="progress-label">
            {stage ?? '执行中'} {pct != null ? `${pct}%` : ''}
          </span>
        </div>
      )}

      {/* ③ 间隔时间线：任务节奏（slice 生成新引用，保证实时输出触发重算） */}
      <TimelineStrip events={allEventsRef.current.slice()} />

      {/* ④ 终端窗口 */}
      <div className="term-panel">
        <div className="term-bar">
          {wsState !== 'idle' && (
            <span className={`ws-ind ws-${wsState}`}>
              {wsState === 'open' ? '● 实时' : wsState === 'connecting' ? '◌ 连接中' : '✕ 已断开，重连中'}
            </span>
          )}
          {running && <span className="term-size">{termSize}</span>}
          <label className="autoscroll" title="新输出自动滚动到底部">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
        </div>
        <div className="term-body">
          <div id="term-host" className="term-host" />
          {task && !running && (
            <div className={`term-overlay-badge badge-${task.status}`}>{STATUS_LABEL[task.status]}</div>
          )}
        </div>
      </div>
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

function fmtGap(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 终端尺寸字符串；fit 未就绪（布局未完成）时返回空，避免显示 undefined×undefined */
function fitSize(fit: FitAddon): string {
  if (Number.isFinite(fit.cols) && Number.isFinite(fit.rows)) return `${fit.cols}×${fit.rows}`;
  return '';
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchTasks, fmtDur, STATUS_LABEL, type TaskMeta } from './api.ts';

type Filter = 'all' | 'running' | 'finished' | 'error';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '运行中' },
  { key: 'finished', label: '已结束' },
  { key: 'error', label: '异常' },
];

export default function Sidebar({
  selectedId,
  onSelect,
  open,
  onClose,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<TaskMeta[] | null>(null);
  const [conn, setConn] = useState<boolean>(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await fetchTasks();
        if (!alive) return;
        setTasks(list);
        setConn(true);
        // 新任务检测（首次出现 → 短暂高亮动画）
        const ids = new Set(list.map((t) => t.id));
        const fresh = new Set([...ids].filter((id) => !seenRef.current.has(id)));
        if (fresh.size > 0) {
          setNewIds((prev) => new Set([...prev, ...fresh]));
          setTimeout(() => {
            setNewIds((prev) => {
              const next = new Set(prev);
              fresh.forEach((id) => next.delete(id));
              return next;
            });
          }, 2000);
        }
        seenRef.current = ids;
      } catch {
        if (alive) setConn(false);
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!tasks) return null;
    let list = tasks;
    if (filter === 'running') list = list.filter((t) => t.status === 'running');
    else if (filter === 'finished') list = list.filter((t) => t.status === 'success' || t.status === 'failed' || t.status === 'killed');
    else if (filter === 'error') list = list.filter((t) => t.status === 'error');
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((t) => t.cmd.toLowerCase().includes(q) || t.id.includes(q));
    // running 置顶，其余按开始时间倒序
    return [...list].sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (a.status !== 'running' && b.status === 'running') return 1;
      return b.startedAt - a.startedAt;
    });
  }, [tasks, filter, query]);

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="brand-row">
        <span className="brand">
          <span className="brand-dot" /> tmon
        </span>
        <span className="brand-row-right">
          <span className={`conn-dot ${conn ? 'on' : 'off'}`} title={conn ? 'server 已连接' : 'server 连接失败'} />
          <button className="close-drawer" onClick={onClose} aria-label="关闭列表">
            ✕
          </button>
        </span>
      </div>

      <div className="filter-row">
        <div className="filter-tabs">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`filter-tab${filter === f.key ? ' active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="search-input"
          placeholder="搜索命令或任务 id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="task-list">
        {filtered === null && <div className="sb-hint">加载中…</div>}
        {filtered !== null && filtered.length === 0 && (
          <div className="sb-hint">
            {query || filter !== 'all' ? '没有匹配的任务' : '暂无任务'}
            {!query && filter === 'all' && (
              <>
                <br />
                让 Agent 用 <code>tmon "命令"</code> 执行即可在此查看
              </>
            )}
          </div>
        )}
        {filtered?.map((t) => (
          <TaskItem key={t.id} task={t} selected={t.id === selectedId} isNew={newIds.has(t.id)} onSelect={onSelect} />
        ))}
      </div>
    </aside>
  );
}

function TaskItem({
  task,
  selected,
  isNew,
  onSelect,
}: {
  task: TaskMeta;
  selected: boolean;
  isNew: boolean;
  onSelect: (id: string) => void;
}) {
  const [, setNow] = useState(Date.now());

  useEffect(() => {
    if (task.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [task.status]);

  const elapsed = task.endedAt ? task.endedAt - task.startedAt : Date.now() - task.startedAt;
  const pct = task.latestPct;

  return (
    <div
      className={`task-item${selected ? ' selected' : ''}${isNew ? ' new' : ''}`}
      onClick={() => onSelect(task.id)}
      title={task.cmd}
    >
      <span className={`task-bar bar-${task.status}`} />
      <div className="task-item-main">
        <div className="ti-line1">
          <span className="task-id">{task.id}</span>
          <span className="ti-cmd">{task.cmd}</span>
        </div>
        <div className="ti-line2">
          <span className={`badge badge-${task.status}`}>
            <span className="dot" />
            {STATUS_LABEL[task.status]}
          </span>
          <span className="ti-elapsed">{fmtDur(elapsed)}</span>
          {task.status === 'running' && pct != null && (
            <span className="mini-progress" title={`${pct}%`}>
              <span className="mini-fill" style={{ width: `${pct}%` }} />
            </span>
          )}
          {task.status === 'running' && pct == null && <span className="live-dot" />}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { fetchTasks, fmtDur, STATUS_LABEL, type TaskMeta } from './api.ts';

export default function TaskList({ onOpen }: { onOpen: (id: string) => void }) {
  const [tasks, setTasks] = useState<TaskMeta[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await fetchTasks();
        if (alive) {
          setTasks(list);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(`无法连接 tmon server: ${(e as Error).message}`);
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (err) {
    return (
      <div className="empty">
        <p className="empty-err">{err}</p>
        <p>请确认 tmon server 已启动（任何 tmon 命令都会自动拉起）。</p>
      </div>
    );
  }
  if (!tasks) return <div className="empty">加载中…</div>;
  if (tasks.length === 0) return <div className="empty">暂无任务——让 Agent 用 <code>tmon "命令"</code> 执行即可在此实时查看。</div>;

  return (
    <table className="task-table">
      <thead>
        <tr>
          <th>状态</th>
          <th>任务</th>
          <th>时长</th>
          <th>退出码</th>
          <th>开始时间</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => {
          const elapsed = t.endedAt ? t.endedAt - t.startedAt : Date.now() - t.startedAt;
          const live = t.status === 'running';
          return (
            <tr key={t.id} className="clickable" onClick={() => onOpen(t.id)}>
              <td>
                <span className={`badge badge-${t.status}`}>{STATUS_LABEL[t.status]}</span>
              </td>
              <td className="task-cmd">
                <span className="task-id">{t.id}</span> {t.cmd}
              </td>
              <td>{fmtDur(elapsed)}{live && <span className="live-dot" title="执行中" />}</td>
              <td>{t.exitCode ?? '—'}</td>
              <td className="muted">{new Date(t.startedAt).toLocaleTimeString()}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

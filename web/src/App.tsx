import { useEffect, useState } from 'react';
import TaskList from './TaskList.tsx';
import TaskView from './TaskView.tsx';

// hash 路由：#/task/<id> → 详情页；其余 → 列表页
function currentTaskId(): string | null {
  const m = location.hash.match(/^#\/task\/([0-9a-f]{8})$/);
  return m ? m[1] : null;
}

export default function App() {
  const [taskId, setTaskId] = useState<string | null>(currentTaskId());

  useEffect(() => {
    const onHash = () => setTaskId(currentTaskId());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-dot" /> tmon <span className="brand-sub">任务监控</span>
        </a>
        {taskId && (
          <a className="back" href="#/">
            ← 任务列表
          </a>
        )}
      </header>
      {taskId ? <TaskView key={taskId} taskId={taskId} /> : <TaskList onOpen={(id) => (location.hash = `#/task/${id}`)} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import Sidebar from './Sidebar.tsx';
import TaskView from './TaskView.tsx';

// hash 路由兼容：#/task/<id> 直接打开并选中对应任务
function currentTaskId(): string | null {
  const m = location.hash.match(/^#\/task\/([0-9a-f]{8})$/);
  return m ? m[1] : null;
}

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(currentTaskId());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setSelectedId(currentTaskId());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (id: string | null) => {
    setSelectedId(id);
    if (id) {
      location.hash = `#/task/${id}`;
    } else {
      history.replaceState(null, '', location.pathname);
    }
    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  return (
    <div className="app">
      <Sidebar selectedId={selectedId} onSelect={select} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      {sidebarOpen && <div className="sidebar-mask" onClick={() => setSidebarOpen(false)} />}
      <main className="main">
        <button
          className="hamburger"
          onClick={() => setSidebarOpen((o) => !o)}
          title="任务列表"
          aria-label="打开任务列表"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        {selectedId ? <TaskView key={selectedId} taskId={selectedId} /> : <EmptyState />}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="es-logo">
        <span className="brand-dot" />
        tmon
      </div>
      <h2>任务监控台</h2>
      <p className="es-desc">
        让 Agent（或你自己）用 <code>tmon</code> 执行命令，即可在这里实时查看输出、节奏与进度。
      </p>
      <pre className="es-code">
        <code>tmon "curl -o big.bin https://example.com/big.bin"</code>
      </pre>
      <p className="es-hint">想先试试？启动交互式演示：</p>
      <pre className="es-code">
        <code>node bin/tmon.js "node demo-interactive.mjs"</code>
      </pre>
    </div>
  );
}

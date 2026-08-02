// 进度上报客户端（docs/03-design.md §9）：`tmon progress <pct> <msg>` / `tmon stage <name>`
// 脚本内直接调用（bash/python/node 均可），读取 executor 注入的环境变量
import { readPort, readToken } from './paths.ts';

export interface ProgressPayload {
  pct?: number;
  msg?: string;
  stage?: string;
}

export async function reportProgress(payload: ProgressPayload): Promise<void> {
  const taskId = process.env.TMON_TASK_ID;
  if (!taskId) {
    throw new Error('未在 tmon 任务环境中运行（缺少 TMON_TASK_ID）——请通过 tmon 执行脚本以获得进度上报能力');
  }
  const port = await readPort();
  const token = await readToken();
  if (!port) throw new Error('tmon server 未运行');
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `上报失败（HTTP ${res.status}）`);
  }
}

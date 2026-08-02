// JSONL / meta 落盘 + 重启恢复（docs/03-design.md §5）
// server 是唯一写入者：events 逐条追加 stream.jsonl，meta 状态变更原子改写 meta.json
import fs from 'node:fs';
import type { TaskEvent, TaskMeta, TaskStatus } from './protocol.ts';
import { ensureDirs, metaFile, streamFile, taskDir, tasksDir } from './paths.ts';

export class Store {
  private metas = new Map<string, TaskMeta>();

  constructor() {
    ensureDirs();
  }

  /** serve 启动时扫描恢复 */
  loadExisting(): TaskMeta[] {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(tasksDir());
    } catch {
      return [];
    }
    const list: TaskMeta[] = [];
    for (const name of entries) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile(name), 'utf8')) as TaskMeta;
        if (meta.status === 'running') {
          // server 重启后无法再控制原 executor，标记为 error
          meta.status = 'error';
          meta.endedAt = Date.now();
          this.writeMeta(meta);
        }
        this.metas.set(meta.id, meta);
        list.push(meta);
      } catch {
        // 半成品目录（无 meta.json）忽略
      }
    }
    return list;
  }

  get(id: string): TaskMeta | undefined {
    return this.metas.get(id);
  }

  all(): TaskMeta[] {
    return [...this.metas.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  create(meta: TaskMeta): void {
    fs.mkdirSync(taskDir(meta.id), { recursive: true });
    this.metas.set(meta.id, meta);
    this.writeMeta(meta);
  }

  appendEvent(id: string, ev: TaskEvent): void {
    const meta = this.metas.get(id);
    if (meta) meta.seq = ev.seq;
    fs.appendFileSync(streamFile(id), JSON.stringify(ev) + '\n');
  }

  updateStatus(id: string, status: TaskStatus, exitCode: number | null, endedAt: number): void {
    const meta = this.metas.get(id);
    if (!meta) return;
    meta.status = status;
    meta.exitCode = exitCode;
    meta.endedAt = endedAt;
    this.writeMeta(meta);
  }

  /** 读取某任务 lastSeq 之后的事件（web 历史续传 / 恢复环形缓冲） */
  readEventsAfter(id: string, lastSeq: number, limit = 5000): TaskEvent[] {
    try {
      const lines = fs.readFileSync(streamFile(id), 'utf8').split('\n');
      const out: TaskEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: TaskEvent;
        try {
          ev = JSON.parse(line) as TaskEvent;
        } catch {
          continue;
        }
        if (ev.seq > lastSeq) {
          out.push(ev);
          if (out.length >= limit) break;
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private writeMeta(meta: TaskMeta): void {
    const tmp = metaFile(meta.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, metaFile(meta.id));
  }
}

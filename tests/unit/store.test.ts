import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store.ts';
import type { TaskEvent, TaskMeta } from '../../src/protocol.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmon-test-'));
  process.env.TMON_DATA_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TMON_DATA_DIR;
});

function meta(id: string): TaskMeta {
  return {
    id,
    cmd: `echo ${id}`,
    cwd: '/tmp',
    pid: 123,
    mode: 'pty',
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    seq: 0,
  };
}

function output(seq: number, data: string): TaskEvent {
  return { type: 'output', seq, ts: Date.now(), dt: 1, stream: 'stdout', data };
}

describe('Store', () => {
  it('create/get/all 基础读写', () => {
    const s = new Store();
    s.create(meta('a1b2c3d4'));
    expect(s.get('a1b2c3d4')?.status).toBe('running');
    expect(s.get('nonexistent')).toBeUndefined();
    expect(s.all()).toHaveLength(1);
  });

  it('appendEvent 落盘 JSONL，readEventsAfter 按 seq 续传', () => {
    const s = new Store();
    s.create(meta('a1b2c3d4'));
    s.appendEvent('a1b2c3d4', output(1, 'a'));
    s.appendEvent('a1b2c3d4', output(2, 'b'));
    s.appendEvent('a1b2c3d4', output(3, 'c'));

    // 新实例（模拟 server 重启）从磁盘恢复
    const s2 = new Store();
    expect(s2.readEventsAfter('a1b2c3d4', 0).map((e) => e.data)).toEqual(['a', 'b', 'c']);
    expect(s2.readEventsAfter('a1b2c3d4', 1).map((e) => e.data)).toEqual(['b', 'c']);
    expect(s2.readEventsAfter('a1b2c3d4', 3)).toEqual([]);
  });

  it('updateStatus 持久化到 meta.json，重载后可见', () => {
    const s = new Store();
    s.create(meta('a1b2c3d4'));
    s.updateStatus('a1b2c3d4', 'killed', 130, Date.now());

    // 新实例需显式 loadExisting（与 server 启动流程一致）后从磁盘恢复
    const s2 = new Store();
    s2.loadExisting();
    const t = s2.get('a1b2c3d4')!;
    expect(t.status).toBe('killed');
    expect(t.exitCode).toBe(130);
    expect(t.endedAt).not.toBeNull();
  });

  it('loadExisting 将遗留 running 任务标记为 error（server 重启场景）', () => {
    const s = new Store();
    s.create(meta('a1b2c3d4')); // 保持 running

    const s2 = new Store();
    const list = s2.loadExisting();
    const t = list.find((x) => x.id === 'a1b2c3d4')!;
    expect(t.status).toBe('error');
  });
});

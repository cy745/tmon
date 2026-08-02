// 数据目录与发现文件（docs/03-design.md §3）
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function dataDir(): string {
  return process.env.TMON_DATA_DIR ?? path.join(homedir(), '.tmon');
}

export function tasksDir(): string {
  return path.join(dataDir(), 'tasks');
}

export function taskDir(id: string): string {
  return path.join(tasksDir(), id);
}

export function metaFile(id: string): string {
  return path.join(taskDir(id), 'meta.json');
}

export function streamFile(id: string): string {
  return path.join(taskDir(id), 'stream.jsonl');
}

/** 默认端口：8456 起，被占用则递增 */
export const DEFAULT_PORT = 8456;

export function portFile(): string {
  return path.join(dataDir(), 'port');
}

export function tokenFile(): string {
  return path.join(dataDir(), 'token');
}

export function ensureDirs(): void {
  fs.mkdirSync(tasksDir(), { recursive: true });
}

export async function readPort(): Promise<number | null> {
  try {
    const raw = fs.readFileSync(portFile(), 'utf8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function readToken(): Promise<string | null> {
  try {
    return fs.readFileSync(tokenFile(), 'utf8').trim();
  } catch {
    return null;
  }
}

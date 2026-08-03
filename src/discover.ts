// server 发现与自动拉起（docs/03-design.md §6）
// 任何 tmon 子命令先 ensureServer()：探测健康 → 不存在则 detached spawn 拉起；
// 版本不匹配（升级后残留的旧版本 server）→ kill 旧 server 并替换，杜绝版本混杂与旧进程残留
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pidFile, portFile, readPort, readToken } from './paths.ts';
import { VERSION } from './server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ServerInfo {
  port: number;
  token: string;
}

export async function ensureServer(): Promise<ServerInfo> {
  const token = (await readToken()) ?? '';
  const port = await readPort();
  if (port !== null) {
    const health = await ping(port, token);
    if (health.ok && health.version === VERSION) {
      return { port, token };
    }
    if (health.ok) {
      // 版本不匹配：该 server 是升级前残留的旧进程（无 P0 安全修复等），kill 后由 launch 替换
      console.error(`tmon: 检测到旧版本 server（${health.version} ≠ ${VERSION}），自动替换`);
      await stopOldServer();
      try { fs.rmSync(portFile(), { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
    }
  }
  return launch();
}

/** kill 旧版本 server 进程（依据 pid 文件）。无 pid 文件（更老版本）时跳过：
 *  新 server 会另寻端口，旧进程成孤儿需手动清理（0.1.0 起均有 pid 文件，升级链路自动） */
async function stopOldServer(): Promise<void> {
  try {
    const pid = Number(fs.readFileSync(pidFile(), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
  } catch { /* 无 pid 文件 */ }
}

async function ping(port: number, token: string): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { version?: string };
    return { ok: true, version: body.version };
  } catch {
    return { ok: false };
  }
}

async function launch(): Promise<ServerInfo> {
  // detached + stdio ignore：CLI 退出后 server 独立存活
  const entry = path.join(__dirname, '..', 'bin', 'tmon.js');
  const child = spawn(process.execPath, [entry, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  // 等待 server 就绪（最多 5s）
  const deadline = Date.now() + 5000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const token = (await readToken()) ?? '';
    const port = await readPort();
    if (port !== null && (await ping(port, token)).ok) {
      return { port, token };
    }
    lastErr = new Error(`server 未就绪（port=${port ?? '-'}）`);
  }
  throw new Error(`tmon server 自动拉起失败: ${lastErr}`);
}

/**
 * 控制台服务的启动 / 停止 / 重启。
 *
 * 服务进程用服务端项目（apps/web/backend）的虚拟环境里的 Python 直接拉起
 * （不经 `uv run` 的中间进程），这样拿到的进程号就是服务本体，停止时不会留下孤儿进程。
 *
 * 端口从环境变量 `CONSOLE_TEST_PORT` 取，默认 8100：宿主 8000 端口被无关进程占用。
 *
 * `uv run` 一律带 `--no-sync`：工作区里两个成员共用同一个虚拟环境，
 * 按成员同步是精确对齐的（只同步服务端包会把核心包的依赖剪掉），
 * 两个成员来回跑就互相剪。环境由
 * `cd apps && uv sync --all-packages --all-groups` 一次性装齐，取解释器不再顺手同步。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { BACKEND_PROJECT_DIR, CONSOLE_DIST_DIR, RUNTIME_DIR } from './paths';

export const DEFAULT_PORT = Number(process.env.CONSOLE_TEST_PORT ?? '8100');
export const HOST = '127.0.0.1';

const RUNTIME_FILE = path.join(RUNTIME_DIR, 'server.json');
const LOG_FILE = path.join(RUNTIME_DIR, 'server.log');

/** 服务进程信息（落盘，供「重启服务」用例跨进程复用）。 */
export interface ServerRuntime {
  pid: number;
  port: number;
  host: string;
  logFile: string;
}

/** 取服务端项目虚拟环境里的 Python 解释器路径。 */
export function backendPython(): string {
  const result = spawnSync(
    'uv',
    ['run', '--no-sync', '--project', BACKEND_PROJECT_DIR, 'python', '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf-8', cwd: BACKEND_PROJECT_DIR },
  );
  if (result.status !== 0) {
    throw new Error(
      `取服务端 Python 解释器失败（退出码 ${result.status}）：${result.stderr || result.stdout}`,
    );
  }
  const executable = result.stdout.trim();
  if (!executable) {
    throw new Error('取服务端 Python 解释器失败：输出为空');
  }
  return executable;
}

/** 端口是否空闲。 */
export async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });
}

/** 等端口释放（停服务后调用）。 */
export async function waitPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`端口 ${port} 在 ${timeoutMs} 毫秒内没有释放`);
}

/** 服务自检是否通过。 */
export async function healthOk(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/** 等服务自检通过。 */
export async function waitForHealth(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthOk(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`控制台服务在 ${timeoutMs} 毫秒内没有通过自检（端口 ${port}）`);
}

/** 拉起控制台服务，返回进程信息。 */
export async function startConsoleServer(port: number = DEFAULT_PORT): Promise<ServerRuntime> {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const python = backendPython();
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child: ChildProcess = spawn(python, ['-m', 'sandbox_console'], {
    cwd: BACKEND_PROJECT_DIR,
    env: {
      ...process.env,
      SANDBOX_CONSOLE_HOST: HOST,
      SANDBOX_CONSOLE_PORT: String(port),
      // 前端产物目录显式指到仓库内的构建产物，避免依赖「相对当前工作目录」的默认值
      SANDBOX_CONSOLE_DIST: CONSOLE_DIST_DIR,
    },
    stdio: ['ignore', logFd, logFd],
    detached: false,
  });
  fs.closeSync(logFd);
  const runtime: ServerRuntime = {
    pid: child.pid ?? -1,
    port,
    host: HOST,
    logFile: LOG_FILE,
  };
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf-8');
  try {
    await waitForHealth(port);
  } catch (error) {
    await stopConsoleServer(runtime);
    throw error;
  }
  return runtime;
}

/** 停止控制台服务。 */
export async function stopConsoleServer(runtime: ServerRuntime): Promise<void> {
  if (runtime.pid > 0) {
    try {
      process.kill(runtime.pid, 'SIGTERM');
    } catch {
      // 进程已经退出：忽略
    }
  }
  await waitPortFree(runtime.port, 30_000);
  if (fs.existsSync(RUNTIME_FILE)) {
    fs.rmSync(RUNTIME_FILE, { force: true });
  }
}

/** 读回落盘的服务进程信息。 */
export function readServerRuntime(): ServerRuntime | null {
  if (!fs.existsSync(RUNTIME_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf-8')) as ServerRuntime;
  } catch {
    return null;
  }
}

/**
 * 重启控制台服务。
 *
 * 用于「服务重启后旧会话失效」这条验收标准：停掉旧进程再拉起新进程，
 * 端口不变（浏览器页面不用改地址）。
 */
export async function restartConsoleServer(port: number = DEFAULT_PORT): Promise<ServerRuntime> {
  const current = readServerRuntime();
  if (current) {
    await stopConsoleServer(current);
  } else {
    await waitPortFree(port, 10_000).catch(() => undefined);
  }
  return startConsoleServer(port);
}

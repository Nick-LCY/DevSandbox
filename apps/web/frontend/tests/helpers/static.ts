/**
 * 独立静态源的启动 / 停止。
 *
 * **网页控制台的前端不再由后端托管**：后端退化成纯 API 服务（只提供 `/api`，
 * 根路径返回 404），前端产物由**独立静态源**伺服。验收套件照这条生产形态走：
 * 页面从静态源加载，接口从后端取，两者**刻意不同源**。
 *
 * 静态源用 Vite 自带的 preview 服务器（`node_modules/.bin/vite preview`）：
 * - **绑 `127.0.0.1`**（硬要求）：`http://127.0.0.1` 是**安全上下文**，
 *   `navigator.clipboard` 在安全上下文里才可用（终端剪贴板用例依赖它）；
 * - **`--strictPort`**（硬要求）：端口被占时**直接失败**而不是静默换一个端口。
 *   静默换端口会毁掉验收配置里的 origin（`baseURL` 与 storageState 的
 *   origin 键都按配置端口算），页面要么 404、要么预置的连接配置压根注不进去，
 *   报错现场还跟「端口写错了」根本看不出来。
 *
 * 端口来自环境变量 `CONSOLE_STATIC_PORT`（默认 8200），与后端的
 * `CONSOLE_TEST_PORT`（默认 8100）**刻意错开**：两者同源会掩盖「后端根路径
 * 到底返回什么」这类跨源问题。
 *
 * 启停套路复用 `helpers/server.ts`（端口探测 / 等端口释放都走同一份实现）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CONSOLE_DIR, CONSOLE_DIST_DIR, RUNTIME_DIR } from './paths';
import { portFree, waitPortFree } from './server';

/** 静态源的默认端口（可用环境变量 `CONSOLE_STATIC_PORT` 覆盖）。 */
export const DEFAULT_STATIC_PORT = Number(process.env.CONSOLE_STATIC_PORT ?? '8200');
/** 静态源只绑回环（安全上下文要求，也不对外暴露）。 */
export const STATIC_HOST = '127.0.0.1';

const STATIC_RUNTIME_FILE = path.join(RUNTIME_DIR, 'static.json');
const STATIC_LOG_FILE = path.join(RUNTIME_DIR, 'static.log');

/** 静态源进程信息（落盘，供收尾时停掉）。 */
export interface StaticRuntime {
  pid: number;
  port: number;
  host: string;
  /** 静态源的 origin（页面基址）。 */
  origin: string;
  logFile: string;
}

/** 静态源的可执行文件（Vite 自带的 preview 服务器）。 */
function viteBin(): string {
  const bin = path.join(CONSOLE_DIR, 'node_modules', '.bin', 'vite');
  if (!fs.existsSync(bin)) {
    throw new Error(
      `找不到 Vite 可执行文件：${bin}。请先在 apps/web/frontend 跑一次 pnpm install。`,
    );
  }
  return bin;
}

/** 静态源是否已经能出页面（根路径 200 且是 HTML）。 */
export async function staticOk(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(`http://${STATIC_HOST}:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.text();
    return body.toLowerCase().includes('<html');
  } catch {
    return false;
  }
}

/** 等静态源就绪（根路径能出 HTML 页面）。 */
export async function waitForStatic(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await staticOk(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`静态源在 ${timeoutMs} 毫秒内没有就绪（端口 ${port}）`);
}

/**
 * 拉起静态源，返回进程信息。
 *
 * 起之前先确认**端口是空的**：端口被占时 `--strictPort` 会让 Vite 直接退出，
 * 与其等它静默失败，不如提前抛一句人话。
 */
export async function startStaticServer(
  port: number = DEFAULT_STATIC_PORT,
): Promise<StaticRuntime> {
  if (!fs.existsSync(path.join(CONSOLE_DIST_DIR, 'index.html'))) {
    throw new Error(
      `静态源需要构建产物：${CONSOLE_DIST_DIR}/index.html 不存在。请先跑 pnpm run build。`,
    );
  }
  if (!(await portFree(port))) {
    throw new Error(
      `静态源端口 ${port} 已被占用（--strictPort 不会静默换端口，换了会毁掉验收配置的 origin）。` +
        `换一个端口：CONSOLE_STATIC_PORT=<端口> pnpm run test:acceptance`,
    );
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const logFd = fs.openSync(STATIC_LOG_FILE, 'a');
  const child: ChildProcess = spawn(
    viteBin(),
    ['preview', '--host', STATIC_HOST, '--port', String(port), '--strictPort'],
    { cwd: CONSOLE_DIR, stdio: ['ignore', logFd, logFd], detached: false },
  );
  fs.closeSync(logFd);

  const runtime: StaticRuntime = {
    pid: child.pid ?? -1,
    port,
    host: STATIC_HOST,
    origin: `http://${STATIC_HOST}:${port}`,
    logFile: STATIC_LOG_FILE,
  };
  fs.writeFileSync(STATIC_RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf-8');
  try {
    await waitForStatic(port);
  } catch (error) {
    await stopStaticServer(runtime);
    throw error;
  }
  return runtime;
}

/** 停止静态源。 */
export async function stopStaticServer(runtime: StaticRuntime): Promise<void> {
  if (runtime.pid > 0) {
    try {
      process.kill(runtime.pid, 'SIGTERM');
    } catch {
      // 进程已经退出：忽略
    }
  }
  try {
    await waitPortFree(runtime.port, 10_000);
  } catch {
    // 优雅退出没成功：强杀后再等一次。
    if (runtime.pid > 0) {
      try {
        process.kill(runtime.pid, 'SIGKILL');
      } catch {
        // 已经退出：忽略
      }
    }
    await waitPortFree(runtime.port, 10_000);
  }
  if (fs.existsSync(STATIC_RUNTIME_FILE)) {
    fs.rmSync(STATIC_RUNTIME_FILE, { force: true });
  }
}

/** 读回落盘的静态源进程信息。 */
export function readStaticRuntime(): StaticRuntime | null {
  if (!fs.existsSync(STATIC_RUNTIME_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(STATIC_RUNTIME_FILE, 'utf-8')) as StaticRuntime;
  } catch {
    return null;
  }
}

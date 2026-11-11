/**
 * 路由：哈希路由（两层）。
 *
 * 为什么用哈希而不是路径路由：路径路由的深链接（如 `/sandboxes/demo`）在
 * 静态托管下没有服务端回退规则，会直接 404。哈希路由不依赖服务端回退规则，
 * 刷新与直接粘贴链接都能落到同一个页面。
 *
 * 两层结构：
 * - `workbench`：工作台本身（没选中沙箱）；
 * - `workbench-sandbox`：工作台 + 选中的沙箱（`sessionId` 为 null 表示还没选终端标签）。
 *
 * 新建沙箱 / 沙箱详情 / 代理设置都不再是路由，是弹窗：开关状态不入路由，
 * 刷新页面后弹窗自然关闭。
 */

import { useCallback, useSyncExternalStore } from 'react';

export type ConsoleRoute =
  | { name: 'workbench' }
  | { name: 'workbench-sandbox'; sandboxName: string; sessionId: string | null };

/** 工作台（没选中沙箱）的哈希地址。 */
export const WORKBENCH_HASH = '#/';

/**
 * 把哈希解析成路由。无法识别的地址一律落到工作台。
 *
 * 认识的地址只有两种：`#/` 与 `#/sandboxes/<沙箱名>[/<会话标识>]`。
 * `#/new`、`#/settings` 这些旧四页地址不再有对应路由，解析时也退回工作台。
 */
export function parseRoute(hash: string): ConsoleRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const segments = path.split('/').filter((segment) => segment.length > 0);

  if (segments.length < 2 || segments.length > 3 || segments[0] !== 'sandboxes') {
    return { name: 'workbench' };
  }

  let sandboxName: string;
  let sessionId: string | null = null;
  try {
    sandboxName = decodeURIComponent(segments[1]);
    if (segments.length === 3) {
      sessionId = decodeURIComponent(segments[2]);
    }
  } catch {
    // 畸形百分号编码（如 `#/sandboxes/%`）会让 decodeURIComponent 抛 URIError。
    // 解析路由的调用栈直通 React 渲染，一个坏地址就会把整站打成白屏，
    // 这里一律退回工作台。
    return { name: 'workbench' };
  }
  return { name: 'workbench-sandbox', sandboxName, sessionId };
}

/** 路由对应的哈希地址。 */
export function routeToHash(route: ConsoleRoute): string {
  if (route.name === 'workbench') {
    return WORKBENCH_HASH;
  }
  const base = `#/sandboxes/${encodeURIComponent(route.sandboxName)}`;
  if (route.sessionId === null || route.sessionId === '') {
    return base;
  }
  return `${base}/${encodeURIComponent(route.sessionId)}`;
}

/**
 * 沙箱地址（页面内跳转用）。
 *
 * `sessionId` 传 null / undefined / 空串都等价于「不选终端标签」，
 * 地址就是 `#/sandboxes/<沙箱名>`。
 */
export function sandboxHash(name: string, sessionId?: string | null): string {
  return routeToHash({
    name: 'workbench-sandbox',
    sandboxName: name,
    sessionId: sessionId ?? null,
  });
}

let cachedHash: string | null = null;
let cachedRoute: ConsoleRoute = { name: 'workbench' };

function getSnapshot(): ConsoleRoute {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseRoute(hash);
  }
  return cachedRoute;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** 当前路由。哈希变化时组件重渲染。 */
export function useRoute(): ConsoleRoute {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 路由跳转：写 `window.location.hash`。
 *
 * 同名沙箱之间切换靠会话标识区分；会话标识本身来自后端（十六进制串），
 * 不含斜号，编码后仍是安全的路径段。
 */
export function useNavigate(): (route: ConsoleRoute) => void {
  return useCallback((route: ConsoleRoute) => {
    const next = routeToHash(route);
    if (window.location.hash === next) {
      return;
    }
    window.location.hash = next;
  }, []);
}

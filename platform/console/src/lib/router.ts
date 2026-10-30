/**
 * 路由：哈希路由。
 *
 * 为什么用哈希而不是路径路由：后端把前端构建产物挂在 `/` 上（静态目录托管），
 * 深链接（如 `/sandboxes/demo`）在服务端没有对应的回退路由，会直接 404。
 * 哈希路由不依赖服务端回退规则，刷新与直接粘贴链接都能落到同一个页面。
 */

import { useSyncExternalStore } from 'react';

export type ConsoleRoute =
  | { name: 'sandbox-list' }
  | { name: 'sandbox-create' }
  | { name: 'sandbox-detail'; sandboxName: string }
  | { name: 'settings' };

/** 各页面的哈希地址（新建页用 `#/new`，与沙箱名空间 `#/sandboxes/<名字>` 隔开）。 */
export const ROUTE_HASH = {
  list: '#/',
  create: '#/new',
  settings: '#/settings',
} as const;

/** 把哈希解析成路由。无法识别的地址一律落到沙箱列表。 */
export function parseRoute(hash: string): ConsoleRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const segments = path.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return { name: 'sandbox-list' };
  }
  if (segments.length === 1 && segments[0] === 'new') {
    return { name: 'sandbox-create' };
  }
  if (segments.length === 1 && segments[0] === 'settings') {
    return { name: 'settings' };
  }
  if (segments.length === 2 && segments[0] === 'sandboxes') {
    let sandboxName: string;
    try {
      sandboxName = decodeURIComponent(segments[1]);
    } catch {
      // 畸形百分号编码（如 `#/sandboxes/%`）会让 decodeURIComponent 抛 URIError。
      // 解析路由的调用栈直通 React 渲染，一个坏地址就会把整站打成白屏，
      // 这里一律退回沙箱列表页。
      return { name: 'sandbox-list' };
    }
    return { name: 'sandbox-detail', sandboxName };
  }
  return { name: 'sandbox-list' };
}

/** 路由对应的哈希地址。 */
export function routeToHash(route: ConsoleRoute): string {
  switch (route.name) {
    case 'sandbox-list':
      return ROUTE_HASH.list;
    case 'sandbox-create':
      return ROUTE_HASH.create;
    case 'settings':
      return ROUTE_HASH.settings;
    case 'sandbox-detail':
      return `#/sandboxes/${encodeURIComponent(route.sandboxName)}`;
  }
}

/** 沙箱详情页地址（页面内跳转用）。 */
export function sandboxDetailHash(name: string): string {
  return routeToHash({ name: 'sandbox-detail', sandboxName: name });
}

let cachedHash: string | null = null;
let cachedRoute: ConsoleRoute = { name: 'sandbox-list' };

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

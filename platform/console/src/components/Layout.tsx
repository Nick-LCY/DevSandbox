import type { ReactNode } from 'react';

import { useRoute } from '../lib/router';

/** 控制台外壳：顶部标题 + 三页导航。 */
export function Layout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const activeKey =
    route.name === 'sandbox-list'
      ? 'sandboxes'
      : route.name === 'sandbox-create'
        ? 'create'
        : route.name === 'settings'
          ? 'settings'
          : 'sandboxes';

  return (
    <div className="layout">
      <header className="layout-header">
        <div className="layout-brand">
          <span className="layout-logo" aria-hidden="true">
            ▣
          </span>
          <span className="layout-name">沙箱平台控制台</span>
        </div>
        <nav className="layout-nav" aria-label="主导航">
          <a
            href="#/"
            className={activeKey === 'sandboxes' ? 'nav-link nav-link-active' : 'nav-link'}
            data-testid="page-layout-nav-sandboxes"
          >
            沙箱列表
          </a>
          <a
            href="#/new"
            className={activeKey === 'create' ? 'nav-link nav-link-active' : 'nav-link'}
            data-testid="page-layout-nav-create"
          >
            新建沙箱
          </a>
          <a
            href="#/settings"
            className={activeKey === 'settings' ? 'nav-link nav-link-active' : 'nav-link'}
            data-testid="page-layout-nav-settings"
          >
            代理设置
          </a>
        </nav>
      </header>
      <main className="layout-main">{children}</main>
    </div>
  );
}

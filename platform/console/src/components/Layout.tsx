import { useEffect, useState, type ReactNode } from 'react';

import { api } from '../api/client';
import type { HealthResponse } from '../api/types';
import { useRoute } from '../lib/router';

/** 后端健康自检的轮询间隔（毫秒）。 */
const HEALTH_POLL_INTERVAL = 15000;

/** 健康自检的展示状态。 */
type HealthState = 'checking' | 'ok' | 'degraded' | 'down';

interface HealthView {
  state: HealthState;
  text: string;
}

/**
 * 控制台外壳：顶部标题 + 主导航 + 后端健康自检。
 *
 * 健康自检走 `GET /api/health`：后端不可达时页面顶部直接提示，
 * 不用等用户点某个按钮才报错。
 */
export function Layout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const [health, setHealth] = useState<HealthView>({
    state: 'checking',
    text: '正在检查后端服务…',
  });

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      let view: HealthView;
      try {
        const result: HealthResponse = await api.health();
        if (!result.console_mounted) {
          view = { state: 'degraded', text: `服务正常（v${result.version}），前端产物未挂载` };
        } else {
          view = { state: 'ok', text: `服务正常（v${result.version}）` };
        }
      } catch (exc) {
        const reason = exc instanceof Error ? exc.message : '无法连接后端服务';
        view = { state: 'down', text: `后端服务不可达：${reason}` };
      }
      if (!cancelled) {
        setHealth(view);
      }
    };

    void check();
    const timer = window.setInterval(() => {
      void check();
    }, HEALTH_POLL_INTERVAL);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
          <span className="layout-name" data-testid="page-layout-title">
            沙箱平台控制台
          </span>
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
        <span
          className={`layout-health layout-health-${health.state}`}
          data-testid="page-layout-health"
          data-health-state={health.state}
        >
          {health.text}
        </span>
      </header>
      <main className="layout-main">{children}</main>
    </div>
  );
}

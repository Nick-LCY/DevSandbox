import { Layout } from './components/Layout';
import { useRoute } from './lib/router';
import { SandboxCreatePage } from './pages/SandboxCreatePage';
import { SandboxDetailPage } from './pages/SandboxDetailPage';
import { SandboxListPage } from './pages/SandboxListPage';
import { SettingsPage } from './pages/SettingsPage';

/** 控制台入口：按路由渲染四个页面之一。 */
export default function App() {
  const route = useRoute();

  return (
    <Layout>
      {route.name === 'sandbox-list' && <SandboxListPage />}
      {route.name === 'sandbox-create' && <SandboxCreatePage />}
      {route.name === 'sandbox-detail' && <SandboxDetailPage sandboxName={route.sandboxName} />}
      {route.name === 'settings' && <SettingsPage />}
    </Layout>
  );
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// 新底座样式入口：Tailwind v4 + 双主题令牌 + shadcn/ui 原语。
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('页面缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

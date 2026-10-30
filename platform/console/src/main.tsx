import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// 并存期引入顺序：globals.css 在前、styles.css 在后。
// 旧 styles.css 是无层 CSS，优先级高于 Tailwind 的分层规则，旧四页外观不受新底座影响。
import './styles/globals.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('页面缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

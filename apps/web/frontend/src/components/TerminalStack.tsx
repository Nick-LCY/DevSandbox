import { useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import {
  DEFAULT_TERMINAL_PREFERENCES,
  type TerminalPreferences,
} from '../lib/terminal-preferences';
import { markVisited, resolveMountedSessions } from '../lib/terminal-residency';
import { TerminalView, type TerminalState } from './TerminalView';

/**
 * 终端栈：**终端标签之间的实例常驻**。
 *
 * 过去切标签会让终端整块重挂载（`key={activeId}`）——xterm 实例连同它身上的
 * 终端模式（鼠标上报 / 焦点上报 / 括号粘贴 / 备用屏）与滚动现场一起被丢掉，
 * 新实例只能靠重放服务端缓冲把画面拼回来。这里改成：
 *
 * - **访问过的会话保留自己的实例**（挂载集合口径在
 *   `src/lib/terminal-residency.ts`，纯函数可单测）；
 * - 切标签只是把不活跃的那份**藏起来**（`display:none`——xterm 在隐藏态下
 *   量不到尺寸，所以显示时要补一次 fit，见 `TerminalView`）；
 * - 没访问过的会话**不挂载**（不自动附着用户没点过的会话）。
 *
 * **切到 Obsidian tab 时整个分屏仍然整体卸载**（那是既有口径，不在本组件内）：
 * 切回来时重新挂载，走 attach + 快照恢复。
 */
interface TerminalStackProps {
  /** 会话表里的会话标识（顺序 = 标签顺序）。 */
  sessionIds: string[];
  /** 当前激活的会话标识。 */
  activeId: string | null;
  /** 每个会话的重试令牌：值变化时该会话重建连接。 */
  retryTokens: Record<string, number>;
  /** 每个会话的焦点回填请求序号：>0 时该会话回填一次焦点。 */
  focusRequests: Record<string, number>;
  /** 终端视图上报状态（按会话区分——后台会话也报）。 */
  onStateChange: (sessionId: string, state: TerminalState) => void;
  /** 终端交互偏好；未传时使用默认关闭值。 */
  terminalPreferences?: TerminalPreferences;
}

export function TerminalStack({
  sessionIds,
  activeId,
  retryTokens,
  focusRequests,
  onStateChange,
  terminalPreferences = DEFAULT_TERMINAL_PREFERENCES,
}: TerminalStackProps) {
  /**
   * 已访问过的会话。
   *
   * **谁被访问过由「激活过」决定**：会话被激活过一次就登记进来，此后
   * 一直常驻（直到会话被关掉、从会话表里消失）。
   */
  const [visited, setVisited] = useState<string[]>([]);

  useEffect(() => {
    if (!activeId) {
      return;
    }
    setVisited((previous) => markVisited(previous, activeId));
  }, [activeId]);

  const mounted = resolveMountedSessions({ sessionIds, visited, activeId });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="page-terminal-stack">
      {mounted.map((sessionId) => (
        <div
          key={sessionId}
          className={cn('flex min-h-0 flex-1 flex-col', sessionId !== activeId && 'hidden')}
          data-testid="page-terminal-stack-item"
          data-session-id={sessionId}
          data-hidden={sessionId === activeId ? 'false' : 'true'}
        >
          <TerminalView
            sessionId={sessionId}
            active={sessionId === activeId}
            retryToken={retryTokens[sessionId] ?? 0}
            focusRequestId={focusRequests[sessionId] ?? 0}
            terminalPreferences={terminalPreferences}
            onStateChange={(state) => {
              onStateChange(sessionId, state);
            }}
          />
        </div>
      ))}
    </div>
  );
}

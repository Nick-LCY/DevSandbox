/**
 * 文件窗格的折叠状态：折叠 / 展开二选一，落在 localStorage 里。
 *
 * 口径与 `src/lib/sidebar-collapsed.ts` 同款：
 * - 只认「用户明确切过的值」：非法值、读取失败一律回落**展开**（默认给全量窗格）；
 * - 存储不可用（隐私模式）时读回落、写静默忽略，不打断交互；
 * - **挂载时不写存储**：只有用户主动点折叠 / 展开按钮才落盘。
 *
 * 值存 '1'（折叠）/ '0'（展开）字符串。
 *
 * **按应用记，不按沙箱记**（与侧栏折叠同一个键位惯例）：折叠态是「这个人的
 * 工作台习惯」，跨沙箱、跨会话关闭 / 重开都保持一致（PRD FP-03）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** 文件窗格折叠状态的存储键。 */
export const FILE_PANE_COLLAPSED_STORAGE_KEY = 'sandbox-console-file-pane-collapsed';

/** 默认展开（不折叠）：窗格是浏览文件的主入口，默认给全量宽度。 */
export const DEFAULT_FILE_PANE_COLLAPSED = false;

/** 取存储句柄；隐私模式等场景下访问 localStorage 会抛异常。 */
function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 读已存折叠状态：没存过、值非法或读取失败都回落默认展开。 */
export function readStoredFilePaneCollapsed(storage?: Storage | null): boolean {
  const store = resolveStorage(storage);
  if (!store) {
    return DEFAULT_FILE_PANE_COLLAPSED;
  }
  try {
    const raw = store.getItem(FILE_PANE_COLLAPSED_STORAGE_KEY);
    if (raw === '1') {
      return true;
    }
    if (raw === '0') {
      return false;
    }
    return DEFAULT_FILE_PANE_COLLAPSED;
  } catch {
    return DEFAULT_FILE_PANE_COLLAPSED;
  }
}

/** 写折叠状态；写不进去（隐私模式）时静默忽略，不打断交互。 */
export function writeStoredFilePaneCollapsed(
  collapsed: boolean,
  storage?: Storage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.setItem(FILE_PANE_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // 忽略：存不下就算了，本次会话内的折叠状态仍然生效。
  }
}

export interface FilePaneCollapsedApi {
  /** 当前是否折叠。 */
  collapsed: boolean;
  /** 直接设成折叠 / 展开，并落盘。 */
  setCollapsed: (collapsed: boolean) => void;
  /** 折叠 / 展开互切，并落盘。 */
  toggle: () => void;
}

/**
 * 文件窗格折叠 Hook。
 *
 * - 初始值来自 localStorage（非法值回落默认展开），**挂载时不写存储**；
 * - 只有用户主动切换才写存储；
 * - 引用与状态对齐（口径同 `src/lib/theme.ts`）：同一帧内连点两次也不会
 *   算出同一个结果。
 */
export function useFilePaneCollapsed(): FilePaneCollapsedApi {
  const [collapsed, setCollapsedState] = useState<boolean>(() =>
    readStoredFilePaneCollapsed(),
  );
  // 供 toggle 取「最新值」：同一帧内连点两次也不能算出同一个结果。
  const collapsedRef = useRef<boolean>(collapsed);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  const setCollapsed = useCallback((next: boolean) => {
    collapsedRef.current = next;
    writeStoredFilePaneCollapsed(next);
    setCollapsedState(next);
  }, []);

  const toggle = useCallback(() => {
    const next = !collapsedRef.current;
    collapsedRef.current = next;
    writeStoredFilePaneCollapsed(next);
    setCollapsedState(next);
  }, []);

  return { collapsed, setCollapsed, toggle };
}

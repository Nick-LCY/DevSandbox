/**
 * 主题机制：亮色 / 暗色二选一，落在 <html> 的 class 与 dataset 上。
 *
 * 口径：
 * - 只认「用户明确选过的值」。非法值、读取失败一律回落亮色，**不跟随系统**。
 * - index.html 的防闪烁脚本用同一套存储键先挂 dark 类，避免首帧闪一下亮色。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'sandbox-console-theme';
export const DEFAULT_THEME: Theme = 'light';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

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
    // 隐私模式等场景下访问 localStorage 会抛异常。
    return null;
  }
}

/** 读已存主题；没有存过、值非法或读取失败都回落默认亮色。 */
export function readStoredTheme(storage?: Storage | null): Theme {
  const store = resolveStorage(storage);
  if (!store) {
    return DEFAULT_THEME;
  }
  try {
    const raw = store.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 写主题；写不进去（隐私模式）时静默忽略，不打断交互。 */
export function writeStoredTheme(theme: Theme, storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 忽略：存不下就算了，本次会话内的主题仍然生效。
  }
}

/** 把主题挂到 <html>：暗色加 dark 类，同时写 dataset.theme 供调试与 CSS 选择器使用。 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
}

export interface ThemeApi {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

/**
 * 主题 Hook。
 *
 * - 初始值来自 localStorage（非法值回落亮色）。
 * - 写入 localStorage 只发生在用户主动切换时，挂载时不写。
 */
export function useTheme(): ThemeApi {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const themeRef = useRef<Theme>(theme);

  useEffect(() => {
    themeRef.current = theme;
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    themeRef.current = next;
    applyTheme(next);
    writeStoredTheme(next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = themeRef.current === 'dark' ? 'light' : 'dark';
    themeRef.current = next;
    applyTheme(next);
    writeStoredTheme(next);
    setThemeState(next);
  }, []);

  return { theme, setTheme, toggle };
}

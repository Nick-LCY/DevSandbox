// @vitest-environment jsdom
/**
 * 主题机制的行为约定。
 *
 * 覆盖：默认亮色、存储里的暗色、非法值回落、挂 dark 类、写 localStorage、
 * 不跟随系统偏好、切换读写闭环。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredTheme,
  useTheme,
  writeStoredTheme,
} from './theme';

function clearThemeDom() {
  const root = document.documentElement;
  root.classList.remove('dark');
  delete root.dataset.theme;
}

describe('主题机制', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearThemeDom();
  });

  afterEach(() => {
    window.localStorage.clear();
    clearThemeDom();
    vi.restoreAllMocks();
  });

  it('没有存过主题时默认亮色', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(readStoredTheme()).toBe('light');
  });

  it('存储里是 dark 时读出 dark', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('存储里是非法值时回落亮色', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    expect(readStoredTheme()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, '');
    expect(readStoredTheme()).toBe('light');
  });

  it('不跟随系统偏好（读取路径不碰 matchMedia）', () => {
    // 系统偏好是暗色时，只要用户没明确选过就仍然是亮色。
    expect(readStoredTheme()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('系统偏好伪造成暗色时，读取路径一次都不调用 matchMedia', () => {
    // 把 matchMedia 伪造成「系统是暗色」：若读取路径真去问过系统偏好，
    // 下面第一条断言（没存过 → 亮色）就会失败；toHaveBeenCalledTimes(0)
    // 则把「不跟随系统」这条约定变成真正被执行过的断言，而不是一句注释。
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('dark'),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList
    );

    expect(readStoredTheme()).toBe('light');

    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    expect(matchMedia).toHaveBeenCalledTimes(0);
  });

  it('applyTheme 给根元素挂 dark 类并写 dataset', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('writeStoredTheme 把主题写进 localStorage', () => {
    writeStoredTheme('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    writeStoredTheme('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('存储不可用时读写都不抛异常', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    expect(readStoredTheme(broken)).toBe('light');
    expect(() => writeStoredTheme('dark', broken)).not.toThrow();
  });

  it('useTheme 初始读存储值，切换后写回存储并更新根元素', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => result.current.toggle());

    expect(result.current.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => result.current.setTheme('dark'));

    expect(result.current.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('useTheme 挂载时不写 localStorage', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(null);
  });
});

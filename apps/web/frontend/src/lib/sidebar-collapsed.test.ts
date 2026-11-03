// @vitest-environment jsdom
/**
 * 侧栏折叠状态的行为约定。
 *
 * 覆盖：默认展开、存储里的折叠、非法值回落、存储抛异常时读回落写静默、
 * 挂载时不写存储、切换后写回且再读一致。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SIDEBAR_COLLAPSED,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  readStoredSidebarCollapsed,
  useSidebarCollapsed,
  writeStoredSidebarCollapsed,
} from './sidebar-collapsed';

/** 一个会抛异常的存储（模拟隐私模式）。 */
function brokenStorage(): Storage {
  return {
    getItem: () => {
      throw new Error('存储不可用');
    },
    setItem: () => {
      throw new Error('存储不可用');
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe('侧栏折叠状态', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('没有存过时默认展开', () => {
    expect(DEFAULT_SIDEBAR_COLLAPSED).toBe(false);
    expect(readStoredSidebarCollapsed()).toBe(false);
  });

  it('存储里是 1 时读出折叠', () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1');
    expect(readStoredSidebarCollapsed()).toBe(true);
  });

  it('存储里是非法值时回落展开', () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');
    expect(readStoredSidebarCollapsed()).toBe(false);
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '');
    expect(readStoredSidebarCollapsed()).toBe(false);
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '折叠');
    expect(readStoredSidebarCollapsed()).toBe(false);
  });

  it('存储抛异常时不崩：读回落展开，写静默忽略', () => {
    const storage = brokenStorage();
    expect(readStoredSidebarCollapsed(storage)).toBe(false);
    expect(() => writeStoredSidebarCollapsed(true, storage)).not.toThrow();
  });

  it('写进去能读回来（存的是 1 / 0 字符串）', () => {
    writeStoredSidebarCollapsed(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1');
    expect(readStoredSidebarCollapsed()).toBe(true);

    writeStoredSidebarCollapsed(false);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0');
    expect(readStoredSidebarCollapsed()).toBe(false);
  });
});

describe('useSidebarCollapsed', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('初始值来自存储，挂载时不写存储', () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const { result } = renderHook(() => useSidebarCollapsed());

    expect(result.current.collapsed).toBe(true);
    expect(setItem).not.toHaveBeenCalled();

    setItem.mockRestore();
  });

  it('toggle 后写回存储，且再读一致', () => {
    const { result } = renderHook(() => useSidebarCollapsed());

    expect(result.current.collapsed).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1');
    expect(readStoredSidebarCollapsed()).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0');
    expect(readStoredSidebarCollapsed()).toBe(false);
  });

  it('setCollapsed 直接设值并写回存储', () => {
    const { result } = renderHook(() => useSidebarCollapsed());

    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1');

    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0');
  });
});

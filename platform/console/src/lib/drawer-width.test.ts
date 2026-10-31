// @vitest-environment jsdom
/**
 * 抽屉宽度：存储往返、非法值回落、越界钳位、像素与百分比换算。
 *
 * 覆盖五件事：
 * - 存进去能读回来（三个抽屉共用一个存储键）；
 * - 存储里的值非法（非数字 / 空串）时回落默认宽度 40；
 * - 越界值钳到 [20, 80]；
 * - 视口宽与百分比宽互相换算，视口宽不可用时原值返回；
 * - 存储读写抛异常（隐私模式）时不崩，静默回落。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  clampDrawerWidth,
  DEFAULT_DRAWER_WIDTH_VW,
  DRAWER_WIDTH_STORAGE_KEY,
  MAX_DRAWER_WIDTH_VW,
  MIN_DRAWER_WIDTH_VW,
  pxToVw,
  readStoredDrawerWidth,
  useDrawerWidth,
  vwToPx,
  writeStoredDrawerWidth,
} from './drawer-width';

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

describe('抽屉宽度', () => {
  it('存进去能读回来', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;

    writeStoredDrawerWidth(55, storage);
    expect(store.get(DRAWER_WIDTH_STORAGE_KEY)).toBe('55');
    expect(readStoredDrawerWidth(storage)).toBe(55);
  });

  it('没存过时回落默认宽度 40', () => {
    expect(DEFAULT_DRAWER_WIDTH_VW).toBe(40);
    expect(readStoredDrawerWidth()).toBe(40);
  });

  it('存储里的值非法时回落 40', () => {
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, '不是数字');
    expect(readStoredDrawerWidth()).toBe(40);
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, '');
    expect(readStoredDrawerWidth()).toBe(40);
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, 'NaN');
    expect(readStoredDrawerWidth()).toBe(40);
    window.localStorage.removeItem(DRAWER_WIDTH_STORAGE_KEY);
  });

  it('越界值钳到 [20, 80]', () => {
    expect(MIN_DRAWER_WIDTH_VW).toBe(20);
    expect(MAX_DRAWER_WIDTH_VW).toBe(80);
    expect(clampDrawerWidth(5)).toBe(20);
    expect(clampDrawerWidth(95)).toBe(80);
    expect(clampDrawerWidth(40)).toBe(40);
    // 不是数字回落默认值。
    expect(clampDrawerWidth(Number.NaN)).toBe(40);
    expect(clampDrawerWidth(Number.POSITIVE_INFINITY)).toBe(40);

    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, '95');
    expect(readStoredDrawerWidth()).toBe(80);
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, '5');
    expect(readStoredDrawerWidth()).toBe(20);
    window.localStorage.removeItem(DRAWER_WIDTH_STORAGE_KEY);
  });

  it('百分比与像素互相换算，视口宽不可用时原值返回', () => {
    expect(vwToPx(40, 1000)).toBe(400);
    expect(pxToVw(400, 1000)).toBe(40);
    expect(vwToPx(40, 0)).toBe(40);
    expect(pxToVw(400, 0)).toBe(400);
    expect(vwToPx(40, -1)).toBe(40);
    expect(pxToVw(400, -1)).toBe(400);
  });

  it('存储抛异常时不崩：读回落 40，写静默忽略', () => {
    const storage = brokenStorage();
    expect(readStoredDrawerWidth(storage)).toBe(40);
    expect(() => writeStoredDrawerWidth(60, storage)).not.toThrow();
  });
});

describe('useDrawerWidth', () => {
  it('初始值来自存储，挂载时不写存储', () => {
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, '62');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const { result } = renderHook(() => useDrawerWidth());
    expect(result.current.widthVw).toBe(62);
    expect(setItem).not.toHaveBeenCalled();

    setItem.mockRestore();
    window.localStorage.removeItem(DRAWER_WIDTH_STORAGE_KEY);
  });

  it('setWidthVw 先钳位再写存储', () => {
    const { result } = renderHook(() => useDrawerWidth());

    act(() => {
      result.current.setWidthVw(95);
    });
    expect(result.current.widthVw).toBe(80);
    expect(window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY)).toBe('80');

    act(() => {
      result.current.setWidthVw(5);
    });
    expect(result.current.widthVw).toBe(20);
    expect(window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY)).toBe('20');

    window.localStorage.removeItem(DRAWER_WIDTH_STORAGE_KEY);
  });
});

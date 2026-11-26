// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TERMINAL_PREFERENCES,
  readTerminalPreferences,
  useTerminalPreferences,
} from './terminal-preferences';

function throwingStorage(): Storage {
  return {
    get length(): number {
      throw new Error('storage unavailable');
    },
    clear: () => {
      throw new Error('storage unavailable');
    },
    getItem: () => {
      throw new Error('storage unavailable');
    },
    key: () => {
      throw new Error('storage unavailable');
    },
    removeItem: () => {
      throw new Error('storage unavailable');
    },
    setItem: () => {
      throw new Error('storage unavailable');
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('readTerminalPreferences', () => {
  it('默认关闭，且不写入存储', () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem');

    expect(readTerminalPreferences()).toEqual(DEFAULT_TERMINAL_PREFERENCES);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('分别读取两个独立键的 1 / 0 值', () => {
    window.localStorage.setItem('sandbox-console-terminal-shift-enter-escape', '1');
    window.localStorage.setItem('sandbox-console-terminal-right-click-clipboard', '0');

    expect(readTerminalPreferences()).toEqual({
      shiftEnterEscape: true,
      rightClickClipboard: false,
    });
  });

  it('非法值和缺键回落关闭', () => {
    window.localStorage.setItem('sandbox-console-terminal-shift-enter-escape', 'true');
    window.localStorage.setItem('sandbox-console-terminal-right-click-clipboard', '2');

    expect(readTerminalPreferences()).toEqual(DEFAULT_TERMINAL_PREFERENCES);
  });

  it('存储访问抛异常时静默回落关闭', () => {
    expect(readTerminalPreferences(throwingStorage())).toEqual(DEFAULT_TERMINAL_PREFERENCES);
  });
});

describe('useTerminalPreferences', () => {
  it('挂载时不写存储，切换后落盘并更新状态', () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const { result } = renderHook(() => useTerminalPreferences());

    expect(result.current.preferences).toEqual(DEFAULT_TERMINAL_PREFERENCES);
    expect(setItem).not.toHaveBeenCalled();

    act(() => {
      result.current.setShiftEnterEscape(true);
    });
    expect(result.current.preferences).toEqual({
      shiftEnterEscape: true,
      rightClickClipboard: false,
    });
    expect(window.localStorage.getItem('sandbox-console-terminal-shift-enter-escape')).toBe('1');

    act(() => {
      result.current.setRightClickClipboard(true);
    });
    expect(result.current.preferences).toEqual({
      shiftEnterEscape: true,
      rightClickClipboard: true,
    });
    expect(window.localStorage.getItem('sandbox-console-terminal-right-click-clipboard')).toBe('1');
  });

  it('切换关闭值后写入 0', () => {
    window.localStorage.setItem('sandbox-console-terminal-shift-enter-escape', '1');
    const { result } = renderHook(() => useTerminalPreferences());

    act(() => {
      result.current.setShiftEnterEscape(false);
    });

    expect(result.current.preferences.shiftEnterEscape).toBe(false);
    expect(window.localStorage.getItem('sandbox-console-terminal-shift-enter-escape')).toBe('0');
  });

  it('写存储抛异常时仍更新状态', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const { result } = renderHook(() => useTerminalPreferences());

    expect(() => {
      act(() => {
        result.current.setRightClickClipboard(true);
      });
    }).not.toThrow();
    expect(result.current.preferences.rightClickClipboard).toBe(true);
  });
});

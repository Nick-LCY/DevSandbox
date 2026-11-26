import { useCallback, useRef, useState } from 'react';

export interface TerminalPreferences {
  shiftEnterEscape: boolean;
  rightClickClipboard: boolean;
}

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  shiftEnterEscape: false,
  rightClickClipboard: false,
};

const STORAGE_KEYS = {
  shiftEnterEscape: 'sandbox-console-terminal-shift-enter-escape',
  rightClickClipboard: 'sandbox-console-terminal-right-click-clipboard',
} as const;

type TerminalPreferenceKey = keyof TerminalPreferences;

function resolveStorage(storage?: Storage): Storage | null {
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

function readPreference(key: TerminalPreferenceKey, storage: Storage | null): boolean {
  if (!storage) {
    return false;
  }
  try {
    return storage.getItem(STORAGE_KEYS[key]) === '1';
  } catch {
    return false;
  }
}

export function readTerminalPreferences(storage?: Storage): TerminalPreferences {
  const store = resolveStorage(storage);
  return {
    shiftEnterEscape: readPreference('shiftEnterEscape', store),
    rightClickClipboard: readPreference('rightClickClipboard', store),
  };
}

export function writeTerminalPreference(
  key: TerminalPreferenceKey,
  value: boolean,
  storage?: Storage,
): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.setItem(STORAGE_KEYS[key], value ? '1' : '0');
  } catch {
    // 存储不可用时静默忽略，本次会话内的偏好仍然生效。
  }
}

export function useTerminalPreferences(): {
  preferences: TerminalPreferences;
  setShiftEnterEscape: (enabled: boolean) => void;
  setRightClickClipboard: (enabled: boolean) => void;
} {
  const [preferences, setPreferences] = useState<TerminalPreferences>(() =>
    readTerminalPreferences(),
  );
  const preferencesRef = useRef(preferences);

  const setPreference = useCallback((key: TerminalPreferenceKey, enabled: boolean) => {
    const next = { ...preferencesRef.current, [key]: enabled };
    preferencesRef.current = next;
    writeTerminalPreference(key, enabled);
    setPreferences(next);
  }, []);

  const setShiftEnterEscape = useCallback(
    (enabled: boolean) => setPreference('shiftEnterEscape', enabled),
    [setPreference],
  );
  const setRightClickClipboard = useCallback(
    (enabled: boolean) => setPreference('rightClickClipboard', enabled),
    [setPreference],
  );

  return { preferences, setShiftEnterEscape, setRightClickClipboard };
}

/**
 * 抽屉宽度：新建沙箱 / 沙箱详情 / 代理设置三个抽屉共用一份宽度。
 *
 * 口径：
 * - 宽度按视口宽度的百分比（vw）记：窗口缩放时抽屉跟着变，不需要重新存。
 * - 三个抽屉共用**同一个存储键**：拖动一个抽屉的宽度，其余两个跟着变。
 * - 存储读写包 try/catch（口径同 `src/lib/theme.ts`）：读不到 / 值非法 /
 *   访问抛异常一律回落默认宽度，写失败静默忽略（存不下就算了，本次会话照样生效）。
 */
import { useCallback, useState } from 'react';

/** 抽屉宽度的存储键（三个抽屉共用）。 */
export const DRAWER_WIDTH_STORAGE_KEY = 'sandbox-console-drawer-width';

/** 默认宽度：视口宽度的 40%。 */
export const DEFAULT_DRAWER_WIDTH_VW = 40;

/** 最小宽度：视口宽度的 20%（再窄就看不清表单了）。 */
export const MIN_DRAWER_WIDTH_VW = 20;

/** 最大宽度：视口宽度的 80%（再宽就把工作区挤没了）。 */
export const MAX_DRAWER_WIDTH_VW = 80;

/**
 * 钳位：越界收到 [20, 80]，不是数字（NaN / Infinity）回落默认值 40。
 */
export function clampDrawerWidth(vw: number): number {
  if (typeof vw !== 'number' || !Number.isFinite(vw)) {
    return DEFAULT_DRAWER_WIDTH_VW;
  }
  if (vw < MIN_DRAWER_WIDTH_VW) {
    return MIN_DRAWER_WIDTH_VW;
  }
  if (vw > MAX_DRAWER_WIDTH_VW) {
    return MAX_DRAWER_WIDTH_VW;
  }
  return vw;
}

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

/**
 * 读已存宽度：没存过、值非法或读取失败都回落默认宽度 40。
 * 存的是越界值时按钳位收进 [20, 80]。
 */
export function readStoredDrawerWidth(storage?: Storage | null): number {
  const store = resolveStorage(storage);
  if (!store) {
    return DEFAULT_DRAWER_WIDTH_VW;
  }
  try {
    const raw = store.getItem(DRAWER_WIDTH_STORAGE_KEY);
    if (raw === null || raw.trim() === '') {
      return DEFAULT_DRAWER_WIDTH_VW;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_DRAWER_WIDTH_VW;
    }
    return clampDrawerWidth(parsed);
  } catch {
    return DEFAULT_DRAWER_WIDTH_VW;
  }
}

/** 写宽度；写不进去（隐私模式）时静默忽略，不打断交互。 */
export function writeStoredDrawerWidth(vw: number, storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.setItem(DRAWER_WIDTH_STORAGE_KEY, String(vw));
  } catch {
    // 忽略：存不下就算了，本次会话内的宽度仍然生效。
  }
}

/** 百分比宽转像素宽。视口宽不可用（≤ 0）时原值返回。 */
export function vwToPx(vw: number, viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return vw;
  }
  return (vw / 100) * viewportWidth;
}

/**
 * 像素宽转百分比宽。
 *
 * 视口宽不可用（≤ 0）时**不做换算**：原值返回的是像素值，调用方不能
 * 拿它当百分比用（那是单位混算）。视口宽不可用时调用方应沿用当前宽度。
 */
export function pxToVw(px: number, viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return px;
  }
  return (px / viewportWidth) * 100;
}

export interface DrawerWidthApi {
  /** 当前宽度（视口宽度的百分比）。 */
  widthVw: number;
  /** 改宽度：先钳位再写存储。 */
  setWidthVw: (vw: number) => void;
}

/**
 * 抽屉宽度 Hook。
 *
 * - 初始值来自 localStorage（非法值回落默认宽度），**挂载时不写存储**。
 * - 只有用户真的改了宽度才写存储。
 */
export function useDrawerWidth(): DrawerWidthApi {
  const [widthVw, setWidthState] = useState<number>(() => readStoredDrawerWidth());

  const setWidthVw = useCallback((vw: number) => {
    const clamped = clampDrawerWidth(vw);
    setWidthState(clamped);
    writeStoredDrawerWidth(clamped);
  }, []);

  return { widthVw, setWidthVw };
}

/**
 * 类名合并工具。
 *
 * - clsx 负责条件类名（数组、对象、假值）。
 * - tailwind-merge 负责同族工具类的去冲突（后者覆盖前者）。
 *
 * shadcn/ui 组件的 className 合并统一走这里，别处不要再手写拼接。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

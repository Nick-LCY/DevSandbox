/**
 * 操作提示条的文案与样式。
 *
 * 操作成功与操作失败必须一眼能分开：失败用错误样式（红色），
 * 成功用成功样式（品牌绿），不能都挂在同一种中性提示条上。
 */

/** 提示类型。 */
export type ActionKind = 'success' | 'error';

/** 一条操作提示。 */
export interface ActionMessage {
  kind: ActionKind;
  text: string;
}

/**
 * 按提示类型选提示条的样式类名。
 *
 * 类名是字面量 Tailwind 串：Tailwind 的内容扫描靠源码里的完整类名，
 * 拼接出来的类名扫不到，样式会整个丢掉。
 */
export function actionBannerClass(kind: ActionKind): string {
  return kind === 'error'
    ? 'rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive'
    : 'rounded-lg border border-primary/30 bg-accent px-3 py-2 text-[12.5px] text-primary';
}

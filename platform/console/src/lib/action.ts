/**
 * 操作提示条的文案与样式。
 *
 * 操作成功与操作失败必须一眼能分开：失败用错误样式（红色），
 * 成功用成功样式（绿色），不能都挂在同一种中性提示条上。
 */

/** 提示类型。 */
export type ActionKind = 'success' | 'error';

/** 一条操作提示。 */
export interface ActionMessage {
  kind: ActionKind;
  text: string;
}

/** 按提示类型选提示条的样式类名。 */
export function actionBannerClass(kind: ActionKind): string {
  return kind === 'error' ? 'banner banner-error' : 'banner banner-success';
}

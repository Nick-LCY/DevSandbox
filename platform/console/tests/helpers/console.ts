/**
 * 控制台页面的通用操作。
 *
 * 控制台是**单页工作台**：左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与
 * 网页终端；新建沙箱 / 沙箱详情 / 代理设置都是弹窗（不入路由）。
 *
 * 标识一律按 README 的标识表来，helper 与实现一一对应：
 * - 工作台：`#/`；
 * - 选中沙箱：`#/sandboxes/<名>`；
 * - 选中沙箱 + 终端会话：`#/sandboxes/<名>/<会话标识>`。
 */

import { expect, type Locator, type Page, type Request } from '@playwright/test';

/**
 * 打开工作台（沙箱列表在左侧边栏，右侧是空态引导块）。
 */
export async function gotoWorkbench(page: Page): Promise<void> {
  await page.goto('/#/');
  await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible();
}

/**
 * 打开新建沙箱弹窗。
 *
 * 「新建沙箱」按钮在页面上有两个挂载点（侧栏顶部 + 右侧空态引导块），
 * 取第一个即可。
 */
export async function openCreateDialog(page: Page): Promise<void> {
  await gotoWorkbench(page);
  await page.getByTestId('page-sandbox-list-create-button').first().click();
  await expect(page.getByTestId('page-sandbox-create-dialog')).toBeVisible();
}

/**
 * 打开某个沙箱的工作区（右侧显示摘要与终端会话标签）。
 */
export async function gotoDetail(page: Page, name: string): Promise<void> {
  await page.goto(`/#/sandboxes/${encodeURIComponent(name)}`);
  await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(name);
}

/**
 * 在左侧边栏里选中一个沙箱（工作区切到它的摘要与终端）。
 */
export async function selectSandbox(page: Page, name: string): Promise<void> {
  const item = page.getByTestId('page-sandbox-list-item').filter({ hasText: name });
  await expect(item).toHaveCount(1);
  await item.click();
  await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(name);
}

/**
 * 在新建弹窗里填一份完整的创建表单并提交，返回提交后等待成功提示的耗时（毫秒）。
 */
export async function fillCreateForm(
  page: Page,
  options: {
    name: string;
    image: string;
    mountHost?: string;
    mountContainer?: string;
    readOnly?: boolean;
    command?: string;
    env?: string;
  },
): Promise<number> {
  await page.getByTestId('page-sandbox-create-name-input').fill(options.name);
  await page.getByTestId('page-sandbox-create-image-select').selectOption(options.image);
  if (options.mountHost) {
    await page.getByTestId('page-sandbox-create-mount-add-button').click();
    const row = page.getByTestId('page-sandbox-create-mount-item').last();
    await row.getByTestId('page-sandbox-create-mount-host-input').fill(options.mountHost);
    await row.getByTestId('page-sandbox-create-mount-container-input').fill(
      options.mountContainer ?? '/workspace',
    );
    if (options.readOnly) {
      await row.getByTestId('page-sandbox-create-mount-readonly-checkbox').check();
    }
  }
  if (options.command !== undefined) {
    await page.getByTestId('page-sandbox-create-command-input').fill(options.command);
  }
  if (options.env !== undefined) {
    await page.getByTestId('page-sandbox-create-env-input').fill(options.env);
  }
  const started = Date.now();
  await page.getByTestId('page-sandbox-create-submit-button').click();
  await expect(page.getByTestId('page-sandbox-create-success')).toBeVisible({ timeout: 300_000 });
  return Date.now() - started;
}

/**
 * 弹窗字段的标识映射。
 *
 * 与工作区头部重名的四个字段在弹窗里换了标识（避免 Playwright 严格模式
 * 撞车）；其余字段只在弹窗里出现，标识不变。
 */
const DIALOG_FIELD_IDS: Record<string, string> = {
  state: 'page-sandbox-detail-dialog-state',
  image: 'page-sandbox-detail-dialog-image',
  'created-at': 'page-sandbox-detail-dialog-created-at',
  'updated-at': 'page-sandbox-detail-dialog-updated-at',
};

/** 详情弹窗里可读的字段名。 */
export type DetailFieldName =
  | 'state'
  | 'image'
  | 'created-at'
  | 'updated-at'
  | 'image-source'
  | 'system-user'
  | 'container-name'
  | 'network-name'
  | 'socket-path'
  | 'socket-mount-path'
  | 'workdir'
  | 'command'
  | 'subid'
  | 'network-owned'
  | 'env'
  | 'mounts'
  | 'dependencies';

/** 字段名 → 弹窗里的定位标识。 */
function dialogFieldId(field: DetailFieldName): string {
  return DIALOG_FIELD_IDS[field] ?? `page-sandbox-detail-${field}`;
}

/**
 * 打开沙箱详情弹窗（完整字段在弹窗里）。
 */
export async function openDetailDialog(page: Page): Promise<void> {
  await page.getByTestId('page-sandbox-detail-detail-button').click();
  await expect(page.getByTestId('page-sandbox-detail-dialog')).toBeVisible();
}

/**
 * 关掉沙箱详情弹窗（Esc 关闭）。
 */
export async function closeDetailDialog(page: Page): Promise<void> {
  const dialog = page.getByTestId('page-sandbox-detail-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

/** 详情弹窗里的错误横幅文案（横幅不在时是空串）。 */
async function detailErrorText(banner: Locator): Promise<string> {
  if ((await banner.count()) === 0) {
    return '';
  }
  return ((await banner.textContent()) ?? '').trim();
}

/**
 * 取沙箱详情弹窗里的某个字段文本。
 *
 * **完整字段只在详情弹窗里**：工作区头部只有状态 / 镜像 / 时间三项摘要，
 * 镜像来源、系统用户、容器名、挂载、子 ID 段等都得进弹窗读。
 *
 * 弹窗没开着就顺手打开，读完再关掉（不让弹窗挡着后面的操作）；
 * 调用方自己开着弹窗时，读完不动它。
 *
 * 字段名传字段本身（`image` / `image-source`），不传完整标识：
 * 与工作区头部重名的四个字段（状态 / 镜像 / 创建时间 / 更新时间）在弹窗里
 * 换了标识（`page-sandbox-detail-dialog-*`），映射关系只在本文件里维护。
 *
 * 等待口径是「**详情到了**」，不是「加载提示没了」：重拉时组件保留旧值、
 * 加载提示根本不渲染，等加载提示消失等于空等。改成等「字段值」或「空占位」
 * 二者之一出现，再按当前可见性选分支读值；详情接口失败时弹窗里有错误横幅，
 * 那种情况立刻判红（错误文案带进失败信息），不干等 30 秒。
 */
export async function detailField(page: Page, field: DetailFieldName): Promise<string> {
  const dialog = page.getByTestId('page-sandbox-detail-dialog');
  const opened = !(await dialog.isVisible());
  if (opened) {
    await openDetailDialog(page);
  }
  const target = dialog.getByTestId(dialogFieldId(field));
  // 列表型字段（挂载 / 环境变量 / 依赖容器）为空时渲染的是「（无…）」占位元素。
  const empty = dialog.getByTestId(`page-sandbox-detail-${field}-empty`);
  const errorBanner = dialog.getByTestId('page-sandbox-detail-dialog-error');

  // 等「字段值」「空占位」「错误横幅」三者之一出现：详情读到了才有值，没值时
  // 渲染占位；详情接口失败时弹窗里有错误横幅。
  await expect
    .poll(
      async () => {
        const valueVisible = await target.isVisible();
        const emptyVisible = await empty.isVisible();
        const errorVisible = (await errorBanner.count()) > 0;
        return valueVisible || emptyVisible || errorVisible;
      },
      { timeout: 30_000, message: '沙箱详情一直不到：字段值、空占位、错误横幅都没出现' },
    )
    .toBe(true);

  // 详情接口失败：显式断言错误横幅不在（文案带进失败信息）。
  // 横幅一出现就判红，不干等 30 秒（给 2 秒重试窗口：横幅晚于字段到的情况也能捕到）。
  await expect(errorBanner, {
    message: `读取沙箱详情失败：${await detailErrorText(errorBanner)}`,
  }).toHaveCount(0, { timeout: 2_000 });

  // 按当前可见性选分支读值：字段有值读字段，空的读占位。
  const locator = (await target.isVisible()) ? target : empty;
  const text = ((await locator.textContent()) ?? '').trim();
  if (opened) {
    await closeDetailDialog(page);
  }
  return text;
}

/**
 * 打开删除沙箱确认弹窗，返回弹窗容器。
 *
 * 回收清单要先读一遍（清单在弹窗里），所以拆成「打开」与「确认」两步。
 */
export async function openDeleteDialog(page: Page): Promise<Locator> {
  await page.getByTestId('page-sandbox-detail-delete-button').click();
  const dialog = page.getByTestId('page-sandbox-detail-delete-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * 两步确认删除：第一次点只武装，第二次才真的发删除请求。
 *
 * 这里挂上删除请求的计数：第一次点之后必须一个删除请求都没发出去，第二次点
 * 之后才发得出请求——堵住「第一击既武装又真删」的假绿。
 */
export async function confirmDeleteTwice(page: Page): Promise<void> {
  const confirm = page.getByTestId('page-sandbox-detail-delete-confirm-button');
  let deleteRequests = 0;
  const countDelete = (request: Request): void => {
    if (request.method() === 'DELETE' && request.url().includes('/api/sandboxes/')) {
      deleteRequests += 1;
    }
  };
  page.on('request', countDelete);
  try {
    await confirm.click();
    // 等一小会儿再判零：请求事件比点击晚几十毫秒落地，不留窗口就等于没数。
    await page.waitForTimeout(300);
    expect(deleteRequests, '第一次点「确认删除」不应发出任何删除请求').toBe(0);

    // 第一击只是武装：武装提示条得出现。
    await expect(page.getByTestId('page-sandbox-detail-delete-armed-hint')).toBeVisible();

    // 第二击：真删。删除请求必须发得出去。
    await confirm.click();
    await expect
      .poll(() => deleteRequests, {
        timeout: 30_000,
        message: '第二次点「确认删除」没有发出删除请求',
      })
      .toBeGreaterThanOrEqual(1);
  } finally {
    page.off('request', countDelete);
  }
}

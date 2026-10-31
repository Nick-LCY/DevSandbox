/**
 * 控制台页面的通用操作。
 *
 * 控制台是**单页工作台**：左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与
 * 网页终端；新建沙箱 / 沙箱详情 / 代理设置都是右侧滑出的抽屉（不入路由）。
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
 * 打开新建沙箱抽屉。
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
 * 等弹窗的进场动画结束（面板尺寸稳定下来）。
 *
 * 弹窗进场是 zoom-in 动画（缩放 0.95 → 1）：动画中间帧量到的是缩放后的尺寸
 * （400px 的面板在中间帧只有 380px），要量宽度必须先等动画结束。
 */
export async function waitDialogSettled(page: Page, testId: string): Promise<void> {
  const dialog = page.getByTestId(testId);
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const box = await dialog.boundingBox();
        const width = box === null ? Number.NaN : Math.round(box.width * 10) / 10;
        const stable = width === last;
        last = width;
        return stable;
      },
      { timeout: 10_000, message: `弹窗 ${testId} 的进场动画迟迟不结束` },
    )
    .toBe(true);
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
 * 等抽屉的滑入动画结束（面板位置稳定下来）。
 *
 * 抽屉是带动画滑入的：动画没结束就量位置，拿到的是动画中间帧，
 * 后面的拖拽会落在错误的坐标上。
 */
export async function waitDrawerSettled(page: Page, testId: string): Promise<void> {
  const drawer = page.getByTestId(testId);
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const box = await drawer.boundingBox();
        const x = box === null ? Number.NaN : Math.round(box.x * 10) / 10;
        const stable = x === last;
        last = x;
        return stable;
      },
      { timeout: 10_000, message: `抽屉 ${testId} 的滑入动画迟迟不结束` },
    )
    .toBe(true);
}

/**
 * 等宿主镜像列表加载完。
 *
 * **必须等列表到位再往选择器里打字**：镜像列表是异步拉回来的，
 * 列表没到时弹层里一条候选都没有，搜索自然命不中。
 *
 * 判据是「刷新镜像」按钮的文案：列表加载期间它是「正在刷新」（禁用态），
 * 加载结束才回到「刷新镜像」。
 */
export async function waitImageListLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId('page-sandbox-create-image-refresh-button')).toHaveText('刷新镜像', {
    timeout: 30_000,
  });
}

/**
 * 展开新建抽屉里的镜像选择器。
 *
 * 镜像选择器是可搜索的（Base UI Combobox）：点输入框展开弹层，
 * 弹层挂在 body 上（`page-sandbox-create-image-popup`）。
 */
export async function openImagePicker(page: Page): Promise<void> {
  await waitImageListLoaded(page);
  await page.getByTestId('page-sandbox-create-image-select').click();
  await expect(page.getByTestId('page-sandbox-create-image-popup')).toBeVisible();
}

/**
 * 在镜像选择器里搜关键字（前端本地筛选，不发请求）。
 *
 * 先清空再填：**清空输入 = 放弃当前选中**（Base UI 原语行为），筛选因此
 * 回到严格的子串匹配（关键字与当前选中值完全相同时原语会跳过筛选，
 * 列表里会混进别的镜像）。
 */
export async function searchImage(page: Page, keyword: string): Promise<void> {
  const input = page.getByTestId('page-sandbox-create-image-select');
  await input.fill('');
  await input.fill(keyword);
}

/**
 * 在新建抽屉里选一张宿主本地镜像。
 *
 * 镜像选择器是可搜索的（Base UI Combobox）：点输入框展开弹层 →
 * 输入 reference 本地筛选 → 点中命中的那条。
 */
export async function selectImage(page: Page, reference: string): Promise<void> {
  await openImagePicker(page);
  await searchImage(page, reference);
  const option = page.locator(`[data-image-reference="${reference}"]`);
  await expect(option).toHaveCount(1);
  await option.click();
  // 选中后输入框回填引用：等这一句落定才算选完。
  await expect(page.getByTestId('page-sandbox-create-image-select')).toHaveValue(reference);
}

/**
 * 在新建抽屉里填一份完整的创建表单并提交，返回提交后等待成功提示的耗时（毫秒）。
 *
 * 创建成功后的口径：**抽屉关掉 + 右上角弹一条成功 toast**（不再有成功面板）。
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
  await selectImage(page, options.image);
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
  // 成功 toast：来源 sandbox-create 的那条成功提示。
  await expect(toastItem(page, 'success', 'sandbox-create')).toContainText(
    `沙箱 ${options.name} 创建成功`,
    { timeout: 300_000 },
  );
  // 抽屉同时关掉（成功面板已退役，不再有 page-sandbox-create-success）。
  await expect(page.getByTestId('page-sandbox-create-dialog')).toBeHidden();
  return Date.now() - started;
}

/**
 * 创建成功后从左侧边栏选中新沙箱。
 *
 * 创建**不再自动选中**：列表是创建后刷新的，先等新沙箱真的出现在侧栏里再点。
 */
export async function selectCreatedSandbox(page: Page, name: string): Promise<void> {
  const item = page.getByTestId('page-sandbox-list-item').filter({ hasText: name });
  await expect(item).toHaveCount(1, { timeout: 60_000 });
  await item.click();
  await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(name);
}

/**
 * 抽屉字段的标识映射。
 *
 * 抽屉前缀覆盖四个字段：其中只有状态 / 镜像仍与工作区头部重名，靠前缀避开
 * Playwright 严格模式撞车；创建时间与更新时间同样沿用抽屉前缀（头部同名标识
 * 已退役，回退路径会失效）。
 */
const DIALOG_FIELD_IDS: Record<string, string> = {
  state: 'page-sandbox-detail-dialog-state',
  image: 'page-sandbox-detail-dialog-image',
  'created-at': 'page-sandbox-detail-dialog-created-at',
  'updated-at': 'page-sandbox-detail-dialog-updated-at',
};

/** 详情抽屉里可读的字段名。 */
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

/** 字段名 → 抽屉里的定位标识。 */
function dialogFieldId(field: DetailFieldName): string {
  return DIALOG_FIELD_IDS[field] ?? `page-sandbox-detail-${field}`;
}

/**
 * 打开沙箱详情抽屉（完整字段在抽屉里）。
 */
export async function openDetailDialog(page: Page): Promise<void> {
  await page.getByTestId('page-sandbox-detail-detail-button').click();
  await expect(page.getByTestId('page-sandbox-detail-dialog')).toBeVisible();
}

/**
 * 关掉沙箱详情抽屉（Esc 关闭）。
 */
export async function closeDetailDialog(page: Page): Promise<void> {
  const dialog = page.getByTestId('page-sandbox-detail-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

/** 详情抽屉里的失败 toast 文案（toast 不在时是空串）。 */
async function toastText(toast: Locator): Promise<string> {
  if ((await toast.count()) === 0) {
    return '';
  }
  return ((await toast.textContent()) ?? '').trim();
}

/**
 * 右上角的 toast（按类型筛，可选再按来源筛）。
 *
 * 操作结果一律走 toast：成功绿 / 失败红 / 提示蓝。
 * toast 5 秒后自动消失，断言要放在动作之后立即执行。
 *
 * `source` 用于区分同页上的多条提示：详情读取失败的失败 toast 带
 * `data-toast-source="sandbox-detail"`，前一步残留的无关失败提示不带这个来源，
 * 两者不会互相误伤。
 */
export function toastItem(
  page: Page,
  kind: 'success' | 'error' | 'info',
  source?: string,
): Locator {
  const sourceSelector = source ? `[data-toast-source="${source}"]` : '';
  return page.locator(
    `[data-testid="page-toast-item"][data-toast-kind="${kind}"]${sourceSelector}`,
  );
}

/**
 * 取沙箱详情抽屉里的某个字段文本。
 *
 * **完整字段只在详情抽屉里**：工作区头部只有状态 / 镜像两项摘要，
 * 镜像来源、系统用户、容器名、挂载、子 ID 段等都得进抽屉读。
 *
 * 抽屉没开着就顺手打开，读完再关掉（不让抽屉挡着后面的操作）；
 * 调用方自己开着抽屉时，读完不动它。
 *
 * 字段名传字段本身（`image` / `image-source`），不传完整标识：
 * 与工作区头部重名的两个字段（状态 / 镜像）在抽屉里
 * 换了标识（`page-sandbox-detail-dialog-*`），映射关系只在本文件里维护。
 *
 * 等待口径是「**详情到了**」，不是「加载提示没了」：重拉时组件保留旧值、
 * 加载提示根本不渲染，等加载提示消失等于空等。改成等「字段值」或「空占位」
 * 二者之一出现，再按当前可见性选分支读值；详情接口失败时弹窗里没有错误横幅，
 * 失败信息走右上角的失败 toast，那种情况立刻判红（错误文案带进失败信息），
 * 不干等 30 秒。
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
  // 详情读取失败：弹窗里没有错误横幅，只有一行「暂时读不到沙箱详情」。
  // 失败信息走右上角的失败 toast——而 toast 5 秒就消失，helper 晚一步看
  // 就只剩这一行。它才是「详情没到」的稳定信号，两个都盯着才不会空等 30 秒。
  const unavailable = dialog.getByTestId('page-sandbox-detail-unavailable');
  // 只认「详情读取失败」这一条（带 data-toast-source="sandbox-detail"）：
  // 前一步残留的无关失败提示不算数，否则会假红。
  const errorToast = toastItem(page, 'error', 'sandbox-detail');

  // 等「字段值」「空占位」「详情不可用」「失败 toast」四者之一出现：详情读到了才有值，
  // 没值时渲染占位；详情接口失败时弹失败 toast（或渲染「详情不可用」那一行）。
  await expect
    .poll(
      async () => {
        const valueVisible = await target.isVisible();
        const emptyVisible = await empty.isVisible();
        const unavailableVisible = await unavailable.isVisible();
        const failed = (await errorToast.count()) > 0;
        return valueVisible || emptyVisible || unavailableVisible || failed;
      },
      {
        timeout: 30_000,
        message: '沙箱详情一直不到：字段值、空占位、详情不可用、失败 toast 都没出现',
      },
    )
    .toBe(true);

  // 详情接口失败：显式断言那行「详情不可用」不在这儿（文案带进失败信息）。
  // 不干等 30 秒（给 2 秒重试窗口：toast 晚于字段到的情况也能捕到）。
  await expect(unavailable, {
    message: `读取沙箱详情失败：${await toastText(errorToast)}`,
  }).toHaveCount(0, { timeout: 2_000 });

  // 详情接口失败：显式断言没有失败 toast（文案带进失败信息）。
  // toast 一出现就判红，不干等 30 秒（给 2 秒重试窗口：toast 晚于字段到的情况也能捕到）。
  await expect(errorToast, {
    message: `读取沙箱详情失败：${await toastText(errorToast)}`,
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
 * 删除请求的计数（按页面记）。
 *
 * **计数必须先于「点删除」挂上**：请求事件只在请求发出时触发，
 * 挂晚了之前发出的请求一个都数不到（断言恒真）。
 */
interface DeleteRequestCounter {
  /** 累计删除请求数。 */
  total: number;
  /** 本次打开删除弹窗时的基线数（只数基线之后的请求）。 */
  baseline: number;
}

/** 每个页面的删除请求计数。 */
const deleteCounters = new WeakMap<Page, DeleteRequestCounter>();

/**
 * 本次打开删除弹窗之后发出的删除请求数。
 *
 * 用于「取消删除后一个请求都不该发出去」这类断言。
 */
export function deleteRequestsSinceOpen(page: Page): number {
  const counter = deleteCounters.get(page);
  return counter === undefined ? 0 : counter.total - counter.baseline;
}

/**
 * 打开删除沙箱确认弹窗，返回弹窗容器。
 *
 * 删除前不再预取回收清单，弹窗里只说后果与「不受影响」。
 *
 * 删除请求的计数器在这里就挂上（**先挂计数器再点「删除」**）：
 * 点「删除」到点「确认删除」之间发出的任何删除请求都要能数到。
 */
export async function openDeleteDialog(page: Page): Promise<Locator> {
  let counter = deleteCounters.get(page);
  if (counter === undefined) {
    const created: DeleteRequestCounter = { total: 0, baseline: 0 };
    const countDelete = (request: Request): void => {
      if (request.method() === 'DELETE' && request.url().includes('/api/sandboxes/')) {
        created.total += 1;
      }
    };
    page.on('request', countDelete);
    deleteCounters.set(page, created);
    counter = created;
  }
  // 基线取当前累计数：断言只覆盖「本次打开弹窗之后」。
  counter.baseline = counter.total;

  await page.getByTestId('page-sandbox-detail-delete-button').click();
  const dialog = page.getByTestId('page-sandbox-detail-delete-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * 一次点确认就删：点一次「确认删除」并等删除请求发出去。
 *
 * 计数由 `openDeleteDialog` 提前挂好（请求事件只在发出时触发，
 * 这里再挂就数不到之前的请求了）。点确认前留 300ms 观察窗口：
 * 这一段时间里不该冒出删除请求；点完确认则必须至少发出一条。
 */
export async function confirmDelete(page: Page): Promise<void> {
  const counter = deleteCounters.get(page);
  if (counter === undefined) {
    throw new Error('删除请求计数器没挂上：必须先调 openDeleteDialog 再调 confirmDelete');
  }
  const confirm = page.getByTestId('page-sandbox-detail-delete-confirm-button');
  // 点确认前留一个观察窗口：这段时间里不该发出删除请求。
  await page.waitForTimeout(300);
  expect(
    counter.total - counter.baseline,
    '点「确认删除」之前不应发出任何删除请求',
  ).toBe(0);

  await confirm.click();
  await expect
    .poll(() => counter.total - counter.baseline, {
      timeout: 30_000,
      message: '点「确认删除」没有发出删除请求',
    })
    .toBeGreaterThanOrEqual(1);
}

/**
 * 打开停止沙箱确认弹窗，返回弹窗容器。
 *
 * 停止是可逆操作，但「同时停止依赖容器」会连带影响别的服务，所以要逐次确认。
 */
export async function openStopDialog(page: Page): Promise<Locator> {
  await page.getByTestId('page-sandbox-detail-stop-button').click();
  const dialog = page.getByTestId('page-sandbox-detail-stop-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * 确认停止：点「确认停止」并等 `POST /api/sandboxes/<名>/stop` 真的发出去。
 */
export async function confirmStop(page: Page, name: string): Promise<void> {
  const stopped = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/sandboxes/${encodeURIComponent(name)}/stop`) &&
      response.request().method() === 'POST',
    { timeout: 60_000 },
  );
  await page.getByTestId('page-sandbox-detail-stop-confirm-button').click();
  await stopped;
}

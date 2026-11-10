/**
 * 运行期文件传输真机验收（06 轮）。
 *
 * 任务书：`docs/tasks/runtime-file-transfer/06-acceptance-and-docs.md`；
 * 需求：`docs/prds/runtime-file-transfer.md`（验收标准「验收、门禁与文档」一节）；
 * 接口契约：`apps/web/backend/API.md` 第 16 章。
 *
 * 钉的行为（主链路，正向）：
 * 一、工作区头部的「文件」按钮与「详情」「停止」**同级**（同一个操作区容器），
 *    打开**独立的文件抽屉**；
 * 二、抽屉按沙箱的容器内 workdir 起手（本 spec 用 `/workspace`），**面包屑**父级
 *    可点击（根目录 crumb 的 `data-depth="-1"`；当前层级是纯文本、不可点），
 *    点目录行即进入该目录；
 * 三、上传只能进**当前浏览目录**：面板的上传按钮 → 原生文件选择框 → 行内进度
 *    出现并走完 → 列表出现该条目（名称 / 大小列都正确）；
 * 四、**容器内校验**：上传后容器里的文件字节数与内容摘要都与本地一致，属主是
 *    **容器内的 root**（宿主侧即沙箱专属用户，这正是「平台代用户写入」的形态）；
 * 五、**下载回环**：点文件行本身即下载（没有下载按钮），取回的字节与本地
 *    逐字节一致（sha256），中文文件名的 `Content-Disposition` 也正确，
 *    响应 `Content-Length` = 探测到的字节数（API.md 16.2）；
 * 六、**同名覆盖**：同名普通文件先弹覆盖确认框；取消 → 「已跳过」且**容器内**
 *    内容不变（`sha256sum` 取证）；确认 → 成功且内容**换成新内容**（容器内摘要
 *    + 下载回环双重对账）。
 *
 * 负例：
 * 一、下载**目录** → 400 + 固定中文文案（**UI 层无此入口**：点目录行是「进入
 *    目录」，所以这条走接口直调，并顺带断言「点目录行不发下载请求」——**带一条
 *    正向对照**：先点文件行，监听器必须听到下载请求，证明监听器本身有效）；
 * 二、上传目标**是已存在目录** → 400 + 固定中文文案，**UI 就地展示后端 detail**
 *    （同名目录不弹覆盖确认框）；
 * 三、**非法路径**（相对路径）→ 400 + 固定中文文案（UI 层没有路径输入框，
 *    只能接口直调）；
 * 四、**沙箱已停止** → 上传 / 下载 / 列目录都回 409 + 固定中文文案（UI 上
 *    「上传」弹后端 detail 的失败 toast、「列目录失败」是面板就地错误态）；
 * 五、**401**：不带令牌的端点一律被拒（全局 401 口径由 `10-auth-connection`
 *    覆盖，这里只做端点级抽样，确认新端点没有漏挂令牌中间件）。
 *
 * 口径说明（容器内校验的取舍）：
 * 本 spec 用**宿主侧的 `docker exec`（沙箱守护进程里，`helpers/host.ts` 的
 * `sandboxExec`）**做容器内取证——与平台自己搬字节走的是同一条 `docker exec`
 * 通路，但不经过被测代码。这样能直接证明「容器里到底有什么」（字节数、sha256、
 * 属主），而不是只看平台自己的回话；下载回环与目录列表作为**用户视角**的证据
 * 并列保留。
 *
 * 口径说明（进度观测）：
 * 行内进度行**上传一完成就被摘掉**，本机链路上大文件也只跑零点几秒——用
 * 「轮询等进度行出现」来断言会随机器负载偶发命不中。所以**选文件之前**就用
 * `page.addInitScript` 装 MutationObserver，把上传行 / 下载进度条的出现与每
 * 一次状态变化记进 `window.__acc`，上传结束后对**记录**做断言（见
 * `installProgressObserver`）。监听器按元素留档：元素被摘掉后仍读得到它最后
 * 的属性，所以「出现 → 走完 → 被摘掉」整条链不会漏。
 *
 * 清理口径：上传的文件留在容器里没关系（容器随沙箱整体回收），**沙箱必须删**；
 * 本地临时文件在用例结束时删掉。
 *
 * 三期起后端对全部 `/api` 生效令牌认证：接口直取走 `helpers/api.ts`
 * （统一带认证头），页面侧的令牌由套件的 storageState 预置
 * （`helpers/connection.ts`）——用例本身不感知令牌。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  createSandbox,
  deleteSandbox,
  downloadSandboxFile,
  getSandbox,
  listSandboxFiles,
  sandboxFileRequest,
  stopSandbox,
  uploadSandboxFile,
  type SandboxDetailModel,
} from '../helpers/api';
import { AUTH_FAILED_DETAIL } from '../helpers/auth';
import { gotoDetail, toastItem } from '../helpers/console';
import { sandboxExec } from '../helpers/host';
import { readFixtures } from '../helpers/sandbox';

/** 平台基础镜像：宿主已构建，属平台自建镜像（`/workspace` 空目录由镜像提供）。 */
const IMAGE = 'sandbox-platform/base:0.3.0';
/** 主链路沙箱（容器内 workdir 显式给 `/workspace`，抽屉从它起手）。 */
const SANDBOX_MAIN = 'acc-files';
/** 负例沙箱（会被停掉，所以与主链路分开）。 */
const SANDBOX_NEG = 'acc-files-neg';
/** 容器内的起手目录（= 沙箱的 workdir）。 */
const WORKSPACE = '/workspace';

/**
 * 上传件的大小：**64 MiB**。
 *
 * 为什么不用小文件：行内进度是**必须看到**的一步，而本机链路上 KB 级文件几十
 * 毫秒就传完了（进度行一闪而过，断言会随机器负载偶发命不中）。实测本机
 * `docker exec` 字节泵约 300 MB/s，32 MiB 只跑 ~0.1 s——离「断言轮询间隔」太近，
 * 所以取 64 MiB（可观察窗口 ~0.2~0.6 s），同时整套用例仍在十秒量级。
 *
 * 注：进度观测已改成 MutationObserver 口径（见文件头），64 MiB 不再是「让
 * 轮询命不中」的必要条件——但它同时也是**下载侧**字节比对与 `Content-Length`
 * 核对的大样本，保留。
 */
const BIG_SIZE = 64 * 1024 * 1024;

/* ------------------------------------------------------------ 本地测试数据 */

interface Fixture {
  /** 本地文件路径（`setInputFiles` 用它）。 */
  filePath: string;
  /** 文件名（容器内的目标名）。 */
  name: string;
  /** 文件字节。 */
  bytes: Buffer;
  /** 内容摘要（与容器内 `sha256sum` 对账）。 */
  sha256: string;
}

function sha256Of(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 建一个本地临时目录（用例结束整目录删掉）。 */
function makeFixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'console-acceptance-transfer-'));
}

/** 在临时目录里写一份上传源文件。 */
function writeFixture(dir: string, name: string, bytes: Buffer): Fixture {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return { filePath, name, bytes, sha256: sha256Of(bytes) };
}

/**
 * 大小列的展示口径（**前端 `formatFileSize` 的契约副本**）。
 *
 * 故意各留一份：断言要钉「大小列 = 实际字节数」，而列表里的文本是前端格式化
 * 后的串。前端改了换算口径（例如改成 1000 进制），这条断言会红——那正是要看
 * 的信号，不是要自动同步的噪音。
 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unitIndex]}`;
}

/* ------------------------------------------------------------ 容器内取证 */

/**
 * 在沙箱容器里跑一条命令（宿主侧的 `docker exec`，与平台搬字节同一条通路）。
 *
 * 用于「容器里到底有什么」的取证：字节数、内容摘要、属主。**不经过被测接口**
 * ——否则只是让平台自证。
 */
function containerExec(
  detail: SandboxDetailModel,
  argv: string[],
): { code: number; stdout: string; stderr: string } {
  return sandboxExec(detail.system_user, detail.uid, [
    'docker',
    'exec',
    detail.container_name,
    ...argv,
  ]);
}

/* ------------------------------------------------------------ 进度观测 */

/** 页面侧观测到的一条上传行快照。 */
interface UploadSnapshot {
  /** 上传件名（`data-upload-name`）。 */
  name: string;
  /** 上传行状态（`data-state`：`queued` / `uploading`）。 */
  state: string;
  /** 进度条的 `role`（取不到为 `null`）。 */
  role: string | null;
  /** 进度条的 `aria-valuenow`（取不到为 `null`）。 */
  valuenow: number | null;
  /** 行内百分比文本（`NN%`，取不到为 `null`）。 */
  percent: number | null;
  /** 这一拍行里有没有「取消上传」按钮。 */
  hasCancel: boolean;
}

/** 页面侧观测到的一条下载进度快照。 */
interface DownloadSnapshot {
  /** 文件名（所属列表行的 `data-name`）。 */
  name: string;
  /** 进度条的 `role`（取不到为 `null`）。 */
  role: string | null;
  /** 进度条的 `aria-valuenow`（取不到为 `null`）。 */
  valuenow: number | null;
  /** 行内百分比文本（`NN%`，取不到为 `null`）。 */
  percent: number | null;
}

/** `window.__acc` 的形状（页面侧累积的观测记录）。 */
interface ProgressLog {
  uploads: UploadSnapshot[];
  downloads: DownloadSnapshot[];
}

/**
 * 页面侧的进度观测器（`page.addInitScript` 装，跑在页面脚本之前）。
 *
 * **为什么不用轮询**：行内进度行上传一完成就被摘掉，本机链路上文件几十毫秒
 * 就传完了——「轮询等进度行出现」会随机器负载偶发命不中（这是上一轮的红点）。
 * 这里在**选文件之前**就把 MutationObserver 装上，把上传行 / 下载进度条的
 * 出现与每一次状态变化记进 `window.__acc`，上传结束后对**记录**做断言。
 *
 * 三条关键设计：
 * 一、**按元素留档**（不只扫当前 DOM）：元素被摘掉后仍读得到它最后的属性，
 *    所以「上传行出现 → 走完 → 被摘掉」这一整条链不会漏；
 * 二、**去重**：同一状态不重复记（否则 64 MiB 的进度更新会记几百条）；
 * 三、**节流扫描**：MutationObserver 回调被合并到 ~16 ms 一次，避免页面上
 *    其它组件（终端等）的 DOM 变化把扫描打爆。
 *
 * 注意：这个函数会被序列化后送进浏览器，**不能引用模块作用域的任何变量**。
 */
function installProgressObserver(): void {
  type UploadRecord = {
    name: string;
    state: string;
    role: string | null;
    valuenow: number | null;
    percent: number | null;
    hasCancel: boolean;
  };
  type DownloadRecord = {
    name: string;
    role: string | null;
    valuenow: number | null;
    percent: number | null;
  };
  const log: { uploads: UploadRecord[]; downloads: DownloadRecord[] } = {
    uploads: [],
    downloads: [],
  };
  (window as unknown as { __acc: typeof log }).__acc = log;

  /** 见过的上传行元素（可能已被摘掉——摘掉后属性仍读得到）。 */
  const uploadRows: Element[] = [];
  /** 见过的下载进度条元素（同上）。 */
  const downloadBars: Element[] = [];
  const seenUploads = new Set<string>();
  const seenDownloads = new Set<string>();

  const percentOf = (text: string): number | null => {
    const matched = /(\d+)\s*%/.exec(text);
    return matched === null ? null : Number(matched[1]);
  };
  const valueOf = (element: Element | null): number | null => {
    if (element === null) {
      return null;
    }
    const raw = element.getAttribute('aria-valuenow');
    if (raw === null || raw.trim() === '') {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const recordUpload = (row: Element): void => {
    if (!uploadRows.includes(row)) {
      uploadRows.push(row);
    }
    const name = row.getAttribute('data-upload-name') ?? '';
    const state = row.getAttribute('data-state') ?? '';
    const bar = row.querySelector('[data-testid="page-file-browser-upload-progress"]');
    const role = bar === null ? null : bar.getAttribute('role');
    const valuenow = valueOf(bar);
    const percent = percentOf(row.textContent ?? '');
    const hasCancel =
      row.querySelector('[data-testid="page-file-browser-upload-cancel-button"]') !== null;
    const key = `${name}|${state}|${role}|${valuenow}|${percent}|${hasCancel}`;
    if (seenUploads.has(key)) {
      return;
    }
    seenUploads.add(key);
    log.uploads.push({ name, state, role, valuenow, percent, hasCancel });
  };

  const recordDownload = (bar: Element): void => {
    if (!downloadBars.includes(bar)) {
      downloadBars.push(bar);
    }
    const row = bar.closest('[data-testid="page-file-browser-row"]');
    const name = row === null ? '' : row.getAttribute('data-name') ?? '';
    const role = bar.getAttribute('role');
    const valuenow = valueOf(bar);
    const percent = percentOf(row === null ? '' : row.textContent ?? '');
    const key = `${name}|${role}|${valuenow}|${percent}`;
    if (seenDownloads.has(key)) {
      return;
    }
    seenDownloads.add(key);
    log.downloads.push({ name, role, valuenow, percent });
  };

  const scan = (): void => {
    document
      .querySelectorAll('[data-testid="page-file-browser-upload-row"]')
      .forEach((row) => recordUpload(row));
    document
      .querySelectorAll('[data-testid="page-file-browser-download-progress"]')
      .forEach((bar) => recordDownload(bar));
    // 已登记的元素（可能已被摘掉）也再记一次：摘掉那一刻的属性还留在元素上。
    uploadRows.forEach((row) => recordUpload(row));
    downloadBars.forEach((bar) => recordDownload(bar));
  };

  let pending = false;
  const schedule = (): void => {
    if (pending) {
      return;
    }
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 16);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-state', 'aria-valuenow', 'class', 'style'],
  });
  scan();
}

/** 读回页面侧累积的进度观测记录。 */
async function readProgressLog(page: Page): Promise<ProgressLog> {
  return page.evaluate(() => {
    const log = (window as unknown as { __acc?: ProgressLog }).__acc;
    return log ?? { uploads: [], downloads: [] };
  });
}

/* ------------------------------------------------------------ 页面操作 */

/** 打开文件抽屉（等列表容器到位）。 */
async function openFileBrowser(page: Page): Promise<void> {
  await page.getByTestId('page-sandbox-detail-files-button').click();
  await expect(page.getByTestId('page-file-browser-dialog')).toBeVisible();
  await expect(page.getByTestId('page-file-browser-list')).toBeVisible();
}

/**
 * 走面板的上传入口传一个本地文件：点「上传」→ 原生文件选择框 → 选定文件。
 *
 * 上传按钮点的是真按钮（`page-file-browser-upload-button`），文件落在**隐藏的
 * 原生 `<input type="file">`** 上（`page-file-browser-file-input`）。
 */
async function uploadFromPanel(page: Page, filePath: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('page-file-browser-upload-button').click();
  await (await chooser).setFiles(filePath);
}

/** 列表里某个条目（按 `data-name` 筛）。 */
function fileRow(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator(`[data-testid="page-file-browser-row"][data-name="${name}"]`);
}

/** 行内上传行（按 `data-upload-name` 筛）。 */
function uploadRow(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator(`[data-testid="page-file-browser-upload-row"][data-upload-name="${name}"]`);
}

/** 面包屑（各级 crumb）。 */
function crumbs(page: Page): ReturnType<Page['locator']> {
  return page.getByTestId('page-file-browser-crumb');
}

/**
 * 文件面板的 toast（按类型 + 来源 + 文案筛）。
 *
 * 按文案再筛一层：面板同一时刻只留最新一条 toast，但顶替时旧条会退场一小会儿，
 * DOM 里可能短暂有两条——只按类型 / 来源筛会撞上「上一条还在退场」。
 */
function fileToast(
  page: Page,
  kind: 'success' | 'error' | 'info',
  text: string,
): ReturnType<Page['locator']> {
  return toastItem(page, kind, 'file-browser').filter({ hasText: text });
}

/** 容器内某文件的字节数（`stat -c %s`；取不到为 `-1`）。 */
function containerFileSize(detail: SandboxDetailModel, target: string): number {
  const result = containerExec(detail, ['stat', '-c', '%s', target]);
  if (result.code !== 0) {
    return -1;
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

/* ------------------------------------------------------------------ 用例 */

test.describe('运行期文件传输', () => {
  test.beforeAll(async () => {
    readFixtures();
    // **不复用残留沙箱**：上一轮中断留下的容器里可能有上传件（`/workspace`
    // 非空），而本用例第一条断言就是「起手目录是空的」——残留必红。
    // 所以统一「先删再建」：容器从干净状态开始（幂等 ≠ 复用容器）。
    await deleteSandbox(SANDBOX_MAIN).catch(() => undefined);
    await createSandbox({
      name: SANDBOX_MAIN,
      image: IMAGE,
      command: 'sleep infinity',
      // 显式给 workdir：抽屉按它起手，起手目录是确定的（不依赖镜像默认值）
      workdir: WORKSPACE,
    });
  });

  test.afterAll(async () => {
    // 沙箱必须清理（上传件随容器整体回收，不需要单独删）
    await deleteSandbox(SANDBOX_MAIN).catch(() => undefined);
    await deleteSandbox(SANDBOX_NEG).catch(() => undefined);
  });

  test('上传 → 容器内校验 → 下载回环 → 同名覆盖（取消 / 确认）→ 目录导航', async ({ page }) => {
    const dir = makeFixtureDir();
    const big = writeFixture(dir, 'acc-transfer-big.bin', crypto.randomBytes(BIG_SIZE));
    // 同名覆盖用的第二版：内容与大小都变（覆盖后能一眼看出「换成了新的」）
    const version2Dir = makeFixtureDir();
    const version2 = writeFixture(
      version2Dir,
      big.name,
      Buffer.from(`ACC_FILE_TRANSFER_V2_${crypto.randomBytes(8).toString('hex')}\n`, 'utf-8'),
    );
    // 中文文件名：`Content-Disposition` 的 `filename*` 必须正确
    const chineseDir = makeFixtureDir();
    const chinese = writeFixture(
      chineseDir,
      '验收报告-运行期传输.txt',
      Buffer.from(`ACC_FILE_TRANSFER_中文_${crypto.randomBytes(6).toString('hex')}\n`, 'utf-8'),
    );
    // 隐藏文件（`.` 开头）：列表必须照常显示
    const hidden = writeFixture(dir, '.env-acc', Buffer.from('ACC_HIDDEN_FILE\n', 'utf-8'));
    // 接口直传（raw body 通道）的样本
    const raw = writeFixture(
      dir,
      'acc-raw-upload.bin',
      Buffer.from(`ACC_RAW_UPLOAD_${crypto.randomBytes(8).toString('hex')}\n`, 'utf-8'),
    );
    const target = `${WORKSPACE}/${big.name}`;
    const chineseTarget = `${WORKSPACE}/${chinese.name}`;
    const rawTarget = `${WORKSPACE}/${raw.name}`;

    try {
      // **进度观测器必须在选文件之前装上**（`addInitScript` 跑在页面脚本之前，
      // 所以要早于第一次导航）。
      await page.addInitScript(installProgressObserver);

      await gotoDetail(page, SANDBOX_MAIN);
      // ── ① 「文件」入口与「详情」「停止」同级（同一个操作区容器里，三个都在）
      const filesButton = page.getByTestId('page-sandbox-detail-files-button');
      const detailButton = page.getByTestId('page-sandbox-detail-detail-button');
      const stopButton = page.getByTestId('page-sandbox-detail-stop-button');
      await expect(filesButton).toBeVisible();
      await expect(detailButton).toBeVisible();
      await expect(stopButton).toBeVisible();
      // 同级 = **同一个父容器**（不只是「三个都在页面上」）
      const sameParent = await page.evaluate(() => {
        const ids = [
          'page-sandbox-detail-files-button',
          'page-sandbox-detail-detail-button',
          'page-sandbox-detail-stop-button',
        ];
        const parents = ids.map(
          (id) => document.querySelector(`[data-testid="${id}"]`)?.parentElement ?? null,
        );
        return parents.every((parent) => parent !== null && parent === parents[0]);
      });
      expect(sameParent, '「文件」「详情」「停止」必须同级（同一个父容器）').toBe(true);
      // 再钉一层：三个按钮在同一行（纵向坐标相近）
      const boxes = await Promise.all([
        filesButton.boundingBox(),
        detailButton.boundingBox(),
        stopButton.boundingBox(),
      ]);
      const ys = boxes.map((box) => box?.y ?? Number.NaN);
      expect(
        Math.max(...ys) - Math.min(...ys),
        '「文件」「详情」「停止」不在同一行（纵向坐标相差过大）',
      ).toBeLessThan(8);

      await openFileBrowser(page);
      // 抽屉从沙箱的 workdir 起手：根 crumb（depth=-1）+ `workspace`（depth=0）
      await expect(crumbs(page)).toHaveCount(2);
      await expect(crumbs(page).nth(1)).toHaveText('workspace');
      await expect(crumbs(page).nth(1)).toHaveAttribute('aria-current', 'page');
      // 空目录就绪（列表读完且确实为空）——上传前列表快照是可信用来判同名的
      await expect(page.getByTestId('page-file-browser-empty')).toBeVisible();

      // 下载请求 / 响应的监听器：**必须挂在任何一次点击之前**（请求事件只在
      // 请求发出时触发，挂晚了数不到）。
      const downloadRequests: string[] = [];
      const downloadResponses: Array<{ url: string; contentLength: string | null }> = [];
      page.on('request', (request) => {
        if (request.url().includes('/files/download')) {
          downloadRequests.push(request.url());
        }
      });
      page.on('response', (response) => {
        if (response.url().includes('/files/download')) {
          downloadResponses.push({
            url: response.url(),
            contentLength: response.headers()['content-length'] ?? null,
          });
        }
      });

      // ── ② 上传：行内进度出现 → 走完 → 列表出现该条目
      await uploadFromPanel(page, big.filePath);
      // 首次上传没有同名文件：不该弹覆盖确认框
      await expect(page.getByTestId('page-file-browser-overwrite-dialog')).toHaveCount(0);
      // 上传完成的判据是**成功 toast**（行内进度行一完成就被摘掉，不能拿它
      // 当「进行中」的凭据）。
      await expect(
        fileToast(page, 'success', `已上传 ${big.name}`),
        '上传没有走完（没有成功提示）',
      ).toBeVisible({ timeout: 180_000 });
      // 上传完成后上传行收掉、取消按钮消失（完成态的后置条件，不是竞态轮询）
      await expect(uploadRow(page, big.name), '上传完成后上传行没有收掉').toHaveCount(0);
      await expect(
        page.getByTestId('page-file-browser-upload-cancel-button'),
        '上传完成后取消按钮没有消失',
      ).toHaveCount(0);

      // 进度观测：**对记录**断言，不再对 DOM 轮询（见文件头「口径说明（进度观测）」）
      const log = await readProgressLog(page);
      const bigUploads = log.uploads.filter((item) => item.name === big.name);
      expect(
        bigUploads.length,
        `没有观测到上传行出现：${JSON.stringify(log.uploads)}`,
      ).toBeGreaterThan(0);
      expect(
        bigUploads.some((item) => (item.valuenow ?? 0) > 0 || (item.percent ?? 0) > 0),
        `上传进度行没有走到过非零进度：${JSON.stringify(bigUploads)}`,
      ).toBe(true);
      expect(
        bigUploads.some((item) => item.hasCancel),
        '上传行里没有「取消上传」按钮',
      ).toBe(true);
      expect(
        bigUploads.some((item) => item.state === 'queued' || item.state === 'uploading'),
        `上传行没有出现过 queued / uploading 状态：${JSON.stringify(bigUploads)}`,
      ).toBe(true);
      expect(
        bigUploads.some((item) => item.role === 'progressbar'),
        `上传行缺少进度条（role=progressbar）：${JSON.stringify(bigUploads)}`,
      ).toBe(true);

      const bigRow = fileRow(page, big.name);
      await expect(bigRow).toHaveCount(1, { timeout: 60_000 });
      await expect(bigRow.getByTestId('page-file-browser-row-name')).toHaveText(big.name);
      await expect(bigRow.getByTestId('page-file-browser-row-size')).toHaveText(
        formatFileSize(big.bytes.length),
      );
      await expect(bigRow).toHaveAttribute('data-kind', 'file');

      // ── ③ 容器内校验：字节数 / 内容摘要 / 属主（宿主侧 docker exec 取证）
      const detail = await getSandbox(SANDBOX_MAIN);
      const stat = containerExec(detail, ['stat', '-c', '%U %G %s', target]);
      expect(stat.code, `容器内 stat 失败：${stat.stderr}`).toBe(0);
      // **口径钉子**：属主是**容器内的 `root`**（宿主侧即沙箱专属用户——这正是
      // 「平台代用户写入」的形态）。钉的是 `docker exec` 的**默认用户**口径：
      // 若实现改成 `docker exec -u <uid>` 之类，这条断言必须同步改。
      expect(
        stat.stdout.trim(),
        '容器内文件的属主或字节数不对（上传没把整份字节写对，或没按沙箱用户写入）',
      ).toBe(`root root ${big.bytes.length}`);
      const sum = containerExec(detail, ['sha256sum', target]);
      expect(sum.code, `容器内 sha256sum 失败：${sum.stderr}`).toBe(0);
      expect(sum.stdout.split(/\s+/)[0], '容器内文件内容与上传源不一致').toBe(big.sha256);
      test.info().annotations.push({
        type: '容器内取证',
        description: `${target} → stat「${stat.stdout.trim()}」，sha256 ${big.sha256}`,
      });

      // ── ④ raw body 通道（接口直传）：钉「上传端点吃的就是裸字节流」
      //    证据链与正向上传同强度：接口直传 → 容器内 `sha256sum` 取证。
      const rawResult = await uploadSandboxFile(SANDBOX_MAIN, rawTarget, raw.bytes);
      expect(rawResult.path).toBe(rawTarget);
      expect(rawResult.bytes, '接口直传的写入字节数不对').toBe(raw.bytes.length);
      const rawSum = containerExec(detail, ['sha256sum', rawTarget]);
      expect(rawSum.code, `容器内 sha256sum 失败：${rawSum.stderr}`).toBe(0);
      expect(
        rawSum.stdout.split(/\s+/)[0],
        '接口直传的 raw 上传在容器里的内容与源不一致',
      ).toBe(raw.sha256);

      // 目录列表（接口口径）与界面对得上：名称 / 类型 / 字节数
      const listed = (await listSandboxFiles(SANDBOX_MAIN, WORKSPACE)).find(
        (entry) => entry.name === big.name,
      );
      expect(listed, '目录列表里没有刚上传的文件').toBeTruthy();
      expect(listed!.kind).toBe('file');
      expect(listed!.size).toBe(big.bytes.length);

      // ── ⑤ 下载回环：点行即下载（没有下载按钮），字节逐一致
      const downloadPromise = page.waitForEvent('download');
      await bigRow.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename(), '下载文件名不是原文件名').toBe(big.name);
      const savedPath = path.join(dir, `downloaded-${big.name}`);
      await download.saveAs(savedPath);
      const savedBytes = fs.readFileSync(savedPath);
      expect(savedBytes.length, '下载到的字节数与上传的不一致').toBe(big.bytes.length);
      expect(sha256Of(savedBytes), '下载到的内容与上传的不一致').toBe(big.sha256);
      await expect(fileToast(page, 'success', `已下载 ${big.name}`)).toBeVisible();

      // **正向对照**：点文件行确实发出了下载请求（监听器本身有效的证据）
      expect(
        downloadRequests.length,
        '点文件行没有发出下载请求（监听器可能失效，后面的「零增量」断言会恒真）',
      ).toBeGreaterThan(0);
      // 下载响应的 `Content-Length` = **探测到的字节数**（API.md 16.2）
      expect(downloadResponses.length, '没有观测到下载响应').toBeGreaterThan(0);
      const probedSize = containerFileSize(detail, target);
      expect(probedSize, '容器内取不到文件字节数（探测值）').toBe(big.bytes.length);
      const lastContentLength = downloadResponses[downloadResponses.length - 1].contentLength;
      expect(lastContentLength, '下载响应没有 Content-Length 头').not.toBeNull();
      expect(
        Number(lastContentLength),
        '下载响应的 Content-Length 与容器内探测到的字节数不一致',
      ).toBe(probedSize);

      // 下载行内进度条出现过（同一个 MutationObserver 口径）
      const logAfterDownload = await readProgressLog(page);
      expect(
        logAfterDownload.downloads.some((item) => item.name === big.name),
        `下载行内进度条没有出现过：${JSON.stringify(logAfterDownload.downloads)}`,
      ).toBe(true);
      expect(
        logAfterDownload.downloads.some((item) => item.role === 'progressbar'),
        `下载行内进度条缺少 role=progressbar：${JSON.stringify(logAfterDownload.downloads)}`,
      ).toBe(true);

      // ── ⑥ 同名覆盖：先取消（内容不变），再确认（内容换成新版本）
      await uploadFromPanel(page, version2.filePath);
      const overwrite = page.getByTestId('page-file-browser-overwrite-dialog');
      await expect(overwrite, '同名文件没有弹覆盖确认框').toBeVisible({ timeout: 30_000 });
      await expect(overwrite).toContainText(`「${big.name}」已存在，确认覆盖？`);
      await page.getByTestId('page-file-browser-overwrite-cancel-button').click();
      await expect(overwrite).toBeHidden();
      await expect(fileToast(page, 'info', `已跳过 ${big.name}`)).toBeVisible();
      // 取消 = 什么都没发生：**容器内取证**（与正向对账同强度，不靠被测接口自证）
      const afterCancel = containerExec(detail, ['sha256sum', target]);
      expect(afterCancel.code, `容器内 sha256sum 失败：${afterCancel.stderr}`).toBe(0);
      expect(
        afterCancel.stdout.split(/\s+/)[0],
        '取消覆盖之后容器内的内容变了',
      ).toBe(big.sha256);
      // 用户视角的旁证：下载回来的还是第一版
      const afterCancelDownload = await downloadSandboxFile(SANDBOX_MAIN, target);
      expect(sha256Of(afterCancelDownload.bytes), '取消覆盖之后下载回来的内容变了').toBe(
        big.sha256,
      );

      await uploadFromPanel(page, version2.filePath);
      await expect(overwrite, '第二次同名上传没有弹覆盖确认框').toBeVisible({
        timeout: 30_000,
      });
      await page.getByTestId('page-file-browser-overwrite-confirm-button').click();
      await expect(overwrite).toBeHidden();
      await expect(fileToast(page, 'success', `已上传 ${big.name}`)).toBeVisible();
      // 确认覆盖 = 内容换成新的（列表大小列与容器内摘要都跟着变）
      await expect(bigRow.getByTestId('page-file-browser-row-size')).toHaveText(
        formatFileSize(version2.bytes.length),
        { timeout: 60_000 },
      );
      const afterOverwrite = containerExec(detail, ['sha256sum', target]);
      expect(afterOverwrite.code).toBe(0);
      expect(afterOverwrite.stdout.split(/\s+/)[0], '覆盖之后容器内还是旧内容').toBe(
        version2.sha256,
      );
      const overwritten = await downloadSandboxFile(SANDBOX_MAIN, target);
      expect(sha256Of(overwritten.bytes), '覆盖之后下载回来的是旧内容').toBe(version2.sha256);

      // ── ⑦ 中文文件名：列表 / 下载文件名 / Content-Disposition 都对
      await uploadFromPanel(page, chinese.filePath);
      const chineseRow = fileRow(page, chinese.name);
      await expect(chineseRow).toHaveCount(1, { timeout: 60_000 });
      const chineseDownloadPromise = page.waitForEvent('download');
      await chineseRow.click();
      const chineseDownload = await chineseDownloadPromise;
      expect(chineseDownload.suggestedFilename(), '中文文件名在下载时被改了').toBe(chinese.name);
      const chineseSaved = path.join(dir, 'downloaded-chinese.txt');
      await chineseDownload.saveAs(chineseSaved);
      expect(sha256Of(fs.readFileSync(chineseSaved)), '中文名文件的内容对不上').toBe(
        chinese.sha256,
      );
      const chineseApi = await downloadSandboxFile(SANDBOX_MAIN, chineseTarget);
      const disposition = chineseApi.contentDisposition ?? '';
      expect(disposition).toContain("filename*=UTF-8''");
      expect(
        decodeURIComponent(disposition.split("filename*=UTF-8''")[1]),
        'Content-Disposition 里的中文文件名不对',
      ).toBe(chinese.name);

      // ── ⑧ 隐藏文件（`.` 开头）照常显示在列表里
      await uploadFromPanel(page, hidden.filePath);
      const hiddenRow = fileRow(page, '.env-acc');
      await expect(hiddenRow, '隐藏文件（. 开头）没有出现在列表里').toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(hiddenRow.getByTestId('page-file-browser-row-name')).toHaveText('.env-acc');

      // ── ⑨ 面包屑导航：回根目录 → 点目录行回到 /workspace（点目录行是「进入目录」）
      // **正向对照（先）**：点一次文件行，监听器必须听到下载请求——否则后面
      // 「点目录行零增量」这条负向断言会恒真（监听器根本没在工作）。
      const controlBefore = downloadRequests.length;
      const controlDownload = page.waitForEvent('download');
      await chineseRow.click();
      await controlDownload;
      expect(
        downloadRequests.length - controlBefore,
        '正向对照失败：点文件行没有发出下载请求（监听器可能失效）',
      ).toBeGreaterThan(0);
      const controlContentLength =
        downloadResponses[downloadResponses.length - 1]?.contentLength ?? null;
      expect(controlContentLength, '下载响应没有 Content-Length 头').not.toBeNull();
      expect(
        Number(controlContentLength),
        '下载响应的 Content-Length 与文件字节数不一致',
      ).toBe(chinese.bytes.length);

      const dirBefore = downloadRequests.length;
      await crumbs(page).first().click();
      await expect(crumbs(page)).toHaveCount(1);
      await expect(crumbs(page).first()).toHaveAttribute('aria-current', 'page');
      const workspaceRow = fileRow(page, 'workspace');
      await expect(workspaceRow).toHaveCount(1, { timeout: 60_000 });
      await expect(workspaceRow).toHaveAttribute('data-kind', 'dir');
      await workspaceRow.click();
      await expect(crumbs(page)).toHaveCount(2);
      await expect(crumbs(page).nth(1)).toHaveText('workspace');
      await expect(bigRow).toHaveCount(1, { timeout: 60_000 });
      expect(
        downloadRequests.length - dirBefore,
        '点目录行不该发下载请求（目录行的语义是进入目录）',
      ).toBe(0);

      // ── ⑩ 列表排序：文件夹在前（隐藏文件照常参与排序）
      // 先在容器里造一个子目录（宿主侧 docker exec，不经被测接口）：
      // 「/workspace 下有子目录」这个前提不成立的话，排序口径无从断言。
      const mkdir = containerExec(detail, ['mkdir', '-p', `${WORKSPACE}/acc-subdir`]);
      expect(mkdir.code, `容器内造子目录失败：${mkdir.stderr}`).toBe(0);
      // 重开抽屉 → 列表重读（抽屉每次打开都回到起手目录并重读列表）
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('page-file-browser-dialog')).toBeHidden();
      await openFileBrowser(page);
      const allRows = page.locator('[data-testid="page-file-browser-row"]');
      await expect(allRows.first()).toBeVisible({ timeout: 60_000 });
      const kinds: string[] = [];
      const rowCount = await allRows.count();
      for (let index = 0; index < rowCount; index += 1) {
        kinds.push((await allRows.nth(index).getAttribute('data-kind')) ?? '');
      }
      const dirCount = kinds.filter((kind) => kind === 'dir').length;
      if (dirCount === 0) {
        // 没有子目录就跳过（并留痕）：排序口径此时无从断言。
        test.info().annotations.push({
          type: '跳过',
          description: '/workspace 下没有子目录，「文件夹在前」这条无从断言',
        });
      } else {
        expect(kinds[0], '文件夹必须排在列表最前').toBe('dir');
        const firstNonDir = kinds.findIndex((kind) => kind !== 'dir');
        expect(
          kinds.lastIndexOf('dir'),
          '所有文件夹都必须排在所有文件之前',
        ).toBeLessThan(firstNonDir);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(version2Dir, { recursive: true, force: true });
      fs.rmSync(chineseDir, { recursive: true, force: true });
    }
  });

  test('面包屑回根后根 crumb 变静态：不可点、不触发重读，列表不清空', async ({ page }) => {
    await gotoDetail(page, SANDBOX_MAIN);
    await openFileBrowser(page);
    // 起手是 /workspace（根 crumb + workspace 一级）
    await expect(crumbs(page)).toHaveCount(2);
    await expect(crumbs(page).nth(1)).toHaveText('workspace');

    // 列目录请求 / 响应的监听器：**必须在第一次点击之前挂上**
    // （请求只在发出时触发，响应只在其回来时触发）。
    const listRequests: string[] = [];
    const listResponses: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/files/list')) {
        listRequests.push(request.url());
      }
    });
    page.on('response', (response) => {
      if (response.url().includes('/files/list')) {
        listResponses.push(response.url());
      }
    });

    // 点根 crumb → 回根目录（列表里出现 workspace 目录条目）
    await crumbs(page).first().click();
    await expect(crumbs(page)).toHaveCount(1);
    await expect(crumbs(page).first()).toHaveAttribute('aria-current', 'page');
    await expect(fileRow(page, 'workspace')).toHaveCount(1, { timeout: 60_000 });
    // 列表已经渲染出来 ⇒ 第一轮列目录的**响应**已经回来（基线取响应数）。
    const beforeReload = listResponses.length;
    const beforeReloadRequests = listRequests.length;
    expect(beforeReload, '点根 crumb 没有跑出列目录响应').toBeGreaterThan(0);

    // 当前已是根目录 ⇒ 根 crumb 就是**当前层级**：静态元素（span）——
    // 不可点、无 hover、无下划线 ⇒ 再点它**不会**触发列目录请求，
    // 列表也不会被清空（不再有「同路径强制重读」这条交互路径）。
    await expect(crumbs(page).first()).toHaveJSProperty('tagName', 'SPAN');
    await crumbs(page).first().click();
    expect(
      listResponses.length,
      '静态根 crumb 不该触发新的列目录响应',
    ).toBe(beforeReload);
    expect(
      listRequests.length,
      '静态根 crumb 不该触发新的列目录请求',
    ).toBe(beforeReloadRequests);
    // 列表没被清空。
    await expect(fileRow(page, 'workspace'), '点静态根 crumb 后列表被清空了').toHaveCount(1);
    await expect(page.getByTestId('page-file-browser-empty')).toHaveCount(0);
  });

  test('负例：下载目录 400 / 上传到目录 400 / 非法路径 400 / 沙箱停止 409 / 无令牌 401', async ({
    page,
  }) => {
    const dir = makeFixtureDir();
    // 与容器内 `/workspace` 同名的本地文件：往根目录上传它就等于「上传到已存在目录」
    const collision = writeFixture(dir, 'workspace', Buffer.from('not a directory\n', 'utf-8'));
    try {
      // 与主链路同理：**先删再建**，容器从干净状态开始（残留文件会让
      // 「根目录里有 workspace 目录」这条判据失真）。
      await deleteSandbox(SANDBOX_NEG).catch(() => undefined);
      await createSandbox({
        name: SANDBOX_NEG,
        image: IMAGE,
        command: 'sleep infinity',
      });

      await gotoDetail(page, SANDBOX_NEG);
      await openFileBrowser(page);
      // 起手目录是根（没给 workdir）：等列表读完（`/workspace` 目录一定在）
      await expect(fileRow(page, 'workspace')).toHaveCount(1, { timeout: 60_000 });

      // ── ① 下载**目录** → 400 + 固定中文文案（UI 层无入口，走接口直调）
      const dirDownload = await sandboxFileRequest(SANDBOX_NEG, 'download', WORKSPACE);
      expect(dirDownload.status, '下载目录没有回 400').toBe(400);
      expect(dirDownload.detail).toBe(`目标是目录：${WORKSPACE}`);

      // ── ② 上传目标**是已存在目录** → 400，且 UI 就地展示后端 detail
      //    同名目录不弹覆盖确认框（直接交给服务端拒）
      const dirUpload = await sandboxFileRequest(SANDBOX_NEG, 'upload', WORKSPACE, {
        body: Buffer.from('x'),
      });
      expect(dirUpload.status, '上传到目录没有回 400').toBe(400);
      expect(dirUpload.detail).toBe(`目标是一个目录，不能作为上传目标：${WORKSPACE}`);

      await uploadFromPanel(page, collision.filePath);
      // 先等失败 toast（说明服务端已经拒了），**再**断言「全程没弹过覆盖确认框」
      await expect(
        fileToast(page, 'error', `目标是一个目录，不能作为上传目标：${WORKSPACE}`),
        '上传到目录失败没有弹后端 detail',
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByTestId('page-file-browser-overwrite-dialog'),
        '同名目录不该弹覆盖确认框',
      ).toHaveCount(0);
      // 失败后不留残骸：上传行收掉，列表里也没有多出东西
      await expect(uploadRow(page, collision.name)).toHaveCount(0);

      // ── ③ 非法路径（相对路径）→ 400 + 固定中文文案（UI 层没有路径输入框）
      const relative = 'relative-file.txt';
      for (const action of ['upload', 'download', 'list'] as const) {
        const result = await sandboxFileRequest(SANDBOX_NEG, action, relative, {
          body: action === 'upload' ? Buffer.from('x') : undefined,
        });
        expect(result.status, `${action} 传相对路径没有回 400`).toBe(400);
        expect(result.detail).toBe(`容器内路径必须是绝对路径：${relative}`);
      }

      // ── ④ 无令牌 → 401（端点级抽样：新端点没有漏挂令牌中间件）
      //    **只抽 download / list（不带 body 的两条）**：带 body 的 upload 在
      //    令牌被拒时，服务端会在读完请求体之前就断开连接，客户端常常拿到
      //    ECONNRESET 而不是 401（连状态码都拿不到，断言就只能靠猜）。
      //    401 的口径由无 body 的端点钉住即可。
      for (const action of ['download', 'list'] as const) {
        const result = await sandboxFileRequest(SANDBOX_NEG, action, WORKSPACE, {
          withToken: false,
        });
        expect(result.status, `${action} 不带令牌没有回 401`).toBe(401);
        expect(result.detail).toBe(AUTH_FAILED_DETAIL);
      }

      // ── ⑤ 沙箱已停止 → 409 + 固定中文文案
      await stopSandbox(SANDBOX_NEG);
      // 界面侧：面板还开着（列表快照可用），此时上传 → 后端 detail 的失败 toast
      await uploadFromPanel(page, collision.filePath);
      await expect(
        fileToast(page, 'error', '沙箱已停止，无法传输文件'),
        '沙箱停止后上传没有回 409 的固定文案',
      ).toBeVisible({ timeout: 60_000 });

      // 重开抽屉：列目录失败是**面板就地错误态**（不弹 toast），展示后端 detail
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('page-file-browser-dialog')).toBeHidden();
      await openFileBrowser(page);
      await expect(page.getByTestId('page-file-browser-error')).toContainText(
        '沙箱已停止，无法传输文件',
        { timeout: 60_000 },
      );

      // 接口侧：上传 / 下载都 409（同一句固定文案；后端在它后面接用户给的容器内路径）
      const stoppedUpload = await sandboxFileRequest(SANDBOX_NEG, 'upload', `${WORKSPACE}/x.txt`, {
        body: Buffer.from('x'),
      });
      expect(stoppedUpload.status, '沙箱停止后上传没有回 409').toBe(409);
      expect(stoppedUpload.detail).toContain('沙箱已停止，无法传输文件');
      const stoppedDownload = await sandboxFileRequest(SANDBOX_NEG, 'download', WORKSPACE);
      expect(stoppedDownload.status, '沙箱停止后下载没有回 409').toBe(409);
      expect(stoppedDownload.detail).toContain('沙箱已停止，无法传输文件');
    } finally {
      await deleteSandbox(SANDBOX_NEG).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

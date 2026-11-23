/**
 * 文件注入副本的**手动刷新**验收（运行中沙箱、不停机）。
 *
 * 这一份用例只验一件事：**用户在详情抽屉里逐条点「刷新副本」之后，托管副本
 * 真的换成了宿主源的新内容，而容器与终端会话原样活着**。单文件原位覆盖、
 * 目录递归镜像（新增 / 更新 / 删除 / 空目录保留）、源缺失时副本不被清空并可
 * 重试，这四类都在这里用**宿主侧 `docker exec` 取证**（不经过被测接口读正文，
 * 否则只是让平台自证）。
 *
 * 取证口径（与 08 / 12 / 17 同款）：
 *
 * - **容器内事实**走沙箱守护进程里的 `docker exec`（`helpers/host.ts` 的
 *   `sandboxExec`）：文件内容、目录清单、空目录、只读写入失败、容器 id 与
 *   启动时间——这些都是「容器里到底有什么」的硬证据；
 * - **终端会话不中断**由两条并列证据钉住：会话表里的 `session_id` /
 *   `host_pid` / `created_at` 前后不变，且同一 shell 里 `export` 的哨兵变量
 *   在刷新后仍然回显（`$VAR` 的展开值只可能来自那个活着的 shell）；
 * - **「刷新详情」是读操作**：点它只该有 GET，用请求侦听断言期间**零** POST
 *   到刷新端点（PRD 明确写了读 / 写不可混为一谈）；
 * - **源不整**的负例：把宿主源目录暂时挪走 → 刷新被拒（预检类），副本清单
 *   一字不变；挪回来再点一次即可成功（用户手动重试）。
 *
 * 用例造数据的方式：沙箱与两条注入声明（一条文件、一条目录）用接口一次建好
 * （`POST /api/sandboxes` 带 `files`）——这是**夹具**，不是被测动作；被测动作
 * （逐条点「刷新副本」、点「刷新详情」）全部在真实浏览器里完成。宿主源是本轮
 * 新建的临时目录（`/tmp` 下），收尾连沙箱一起清掉，只碰验收前缀的资源。
 *
 * 平台数据根：本机 `SANDBOX_PLATFORM_HOME` 未重定向（`/var/lib/sandbox-platform`，
 * 本地开发根）。**刻意不把数据根指到临时目录**：镜像代理是宿主上的**单例容器**，
 * 它的绑定挂载跟着数据根走——换根会让 `ensure_running` 判定「挂载不一致」并
 * **重建那台共享代理**，波及既有沙箱。本用例改用 `acc-` 前缀的唯一沙箱名，
 * 只碰自己这条，跑完删干净。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  backendBaseUrl,
  clearTerminalSessions,
  deleteSandbox,
  listTerminalSessions,
  type SandboxDetailModel,
} from '../helpers/api';
import { authHeaders } from '../helpers/auth';
import {
  closeDetailDialog,
  gotoDetail,
  openDetailDialog,
  toastItem,
} from '../helpers/console';
import { sandboxExec, type CommandResult } from '../helpers/host';
import { readFixtures } from '../helpers/sandbox';
import {
  expectTerminalConnected,
  expectTerminalText,
  openTerminal,
  typeInTerminal,
} from '../helpers/terminal';

/** 验收沙箱名（`acc-` 前缀：收尾清理只碰这个前缀）。 */
const SANDBOX_NAME = 'acc-inj-refresh';
/** 平台基础镜像（宿主已有）：只关心文件与容器事实，不依赖个人镜像。 */
const IMAGE = 'sandbox-platform/base:0.3.0';
/** 注入副本在容器内的落点（一条文件、一条目录）。 */
const FILE_CONTAINER = '/run/injected/secret.txt';
const DIR_CONTAINER = '/run/injected/bundle';
/** 刷新端点（只按条目标识定位；响应 204 / 400 都在这里看）。 */
const REFRESH_ENDPOINT = `/api/sandboxes/${SANDBOX_NAME}/injections/`;
/** 预检类失败文案（源缺失 / 源不合规时后端回这句）。 */
const PRECHECK_DETAIL = '刷新前置校验未通过，副本未改动';

/* ------------------------------------------------------------ 夹具类型 */

/** 沙箱详情里的注入条目（与后端 `InjectionInfo` 同形；只读元数据）。 */
interface InjectionModel {
  entry_id: string;
  source_path: string;
  container_path: string;
  kind: 'file' | 'directory';
  read_only: boolean;
  can_refresh: boolean;
}

/** 本轮造出来的宿主源（一条文件 + 一棵目录树）。 */
interface Sources {
  root: string;
  file: string;
  dir: string;
}

/** 每轮随机后缀：内容标记不重复，屏幕上不会命中上一轮的字样。 */
const TOKEN = crypto.randomBytes(4).toString('hex');

/** 文件注入的内容（刷新前 / 刷新后）。 */
const FILE_V1 = `ACC_INJECT_FILE_V1_${TOKEN}`;
const FILE_V2 = `ACC_INJECT_FILE_V2_${TOKEN}`;

/** 目录镜像里各个成员的内容（刷新前 / 刷新后）。 */
const KEEP_V1 = `keep-v1-${TOKEN}`;
const KEEP_V2 = `keep-v2-${TOKEN}`;
const DEEP_V1 = `deep-v1-${TOKEN}`;
const DEEP_V2 = `deep-v2-${TOKEN}`;
const GONE_V1 = `gone-v1-${TOKEN}`;
const OLD_IN_EMPTY = `old-in-empty-${TOKEN}`;
const NEW_FILE = `new-file-${TOKEN}`;
const ADDED_DEEP = `added-deep-${TOKEN}`;
const RETRY_FILE = `retry-after-fix-${TOKEN}`;

/** 模块级夹具：用例之间共享同一个沙箱（workers=1、串行）。 */
let sandbox: SandboxDetailModel;
let injections: InjectionModel[] = [];
let sources: Sources;
let sessionId = '';

/* ------------------------------------------------------------ 宿主源 */

/** 写一个内容不带换行的文件并锁权限（内容在容器里 `cat` 出来一字不差）。 */
function writeSourceFile(file: string, content: string, mode = 0o600): void {
  fs.writeFileSync(file, content, 'utf-8');
  fs.chmodSync(file, mode);
}

/** 造宿主源：一条 0600 文件 + 一棵目录树（含空目录 / 将被删的成员）。 */
function createSources(): Sources {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-acc-inj-refresh-'));
  fs.chmodSync(root, 0o755);

  const file = path.join(root, 'secret.txt');
  writeSourceFile(file, FILE_V1);

  const dir = path.join(root, 'bundle');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
  writeSourceFile(path.join(dir, 'keep.txt'), KEEP_V1, 0o644);
  writeSourceFile(path.join(dir, 'gone.txt'), GONE_V1, 0o644);
  writeSourceFile(path.join(dir, 'sub', 'deep.txt'), DEEP_V1, 0o644);
  writeSourceFile(path.join(dir, 'empty', 'old.txt'), OLD_IN_EMPTY, 0o644);
  return { root, file, dir };
}

/**
 * 把源改成「第二代」：文件换内容；目录树里新增 / 更新 / 删除各一，且把
 * `empty/` 里的旧成员删掉（源里真实存在的空目录，刷新后必须保留为空目录）。
 */
function updateSources(workspace: Sources): void {
  writeSourceFile(workspace.file, FILE_V2);
  writeSourceFile(path.join(workspace.dir, 'keep.txt'), KEEP_V2, 0o644);
  writeSourceFile(path.join(workspace.dir, 'new.txt'), NEW_FILE, 0o644);
  writeSourceFile(path.join(workspace.dir, 'sub', 'deep.txt'), DEEP_V2, 0o644);
  writeSourceFile(path.join(workspace.dir, 'sub', 'added.txt'), ADDED_DEEP, 0o644);
  fs.rmSync(path.join(workspace.dir, 'gone.txt'));
  fs.rmSync(path.join(workspace.dir, 'empty', 'old.txt'));
}

/** 源目录树清单（递归）——用来断言刷新不碰宿主原件。 */
function sourceSnapshot(root: string): string {
  const entries: string[] = [];
  const walk = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current, { bigint: true });
    const mode = Number(stat.mode & 0o777n).toString(8);
    if (stat.isDirectory()) {
      entries.push(`${relative || '.'}|d|${mode}|${stat.uid}|${stat.gid}|${stat.mtimeNs}`);
      for (const name of fs.readdirSync(current).sort()) {
        walk(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex');
    entries.push(
      `${relative}|f|${mode}|${stat.uid}|${stat.gid}|${stat.size}|${stat.mtimeNs}|${digest}`,
    );
  };
  walk(root, '');
  return entries.join('\n');
}

/* ------------------------------------------------------------ 容器取证 */

/** 沙箱容器里跑一条命令（宿主侧 `docker exec`；不经过被测接口）。 */
function containerExec(detail: SandboxDetailModel, argv: string[]): CommandResult {
  return sandboxExec(detail.system_user, detail.uid, [
    'docker',
    'exec',
    detail.container_name,
    ...argv,
  ]);
}

/** 沙箱容器里跑一段 shell（取证用的复合命令）。 */
function containerShell(detail: SandboxDetailModel, script: string): CommandResult {
  return containerExec(detail, ['sh', '-c', script]);
}

/** 读容器内文件（失败直接判红：拿不到正文就没法证明刷新生效）。 */
function containerRead(detail: SandboxDetailModel, target: string): string {
  const result = containerExec(detail, ['cat', target]);
  expect(result.code, `容器内读不到 ${target}：${result.stderr}`).toBe(0);
  return result.stdout;
}

/** 容器内某目录的递归清单（类型 + 相对路径，按路径排序）。 */
function containerListing(detail: SandboxDetailModel, root: string): string[] {
  const result = containerShell(detail, `find ${root} -mindepth 1 -printf '%y %P\\n' | LC_ALL=C sort`);
  expect(result.code, `容器内列不出 ${root}：${result.stderr}`).toBe(0);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 容器 id + 启动时间：刷新不该重建容器，这两个值必须前后一致。 */
function containerIdentity(detail: SandboxDetailModel): string {
  const result = sandboxExec(detail.system_user, detail.uid, [
    'docker',
    'inspect',
    '--format',
    '{{.Id}}|{{.State.StartedAt}}',
    detail.container_name,
  ]);
  expect(result.code, `取不到容器身份：${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

/** 容器内路径可访问（目录仍在 / 挂载根没被删）。 */
function containerPathExists(detail: SandboxDetailModel, target: string, flag: '-d' | '-f'): boolean {
  return containerShell(detail, `test ${flag} ${target}`).code === 0;
}

/** 断言容器内写注入路径失败（只读挂载仍然生效）。 */
function expectReadOnly(detail: SandboxDetailModel, target: string): void {
  const result = containerShell(detail, `printf x > ${target}`);
  expect(result.code, `容器内写入 ${target} 竟然成功了：只读挂载没生效`).not.toBe(0);
  expect(result.stderr, `写入 ${target} 的失败原因不是只读文件系统`).toContain(
    'Read-only file system',
  );
}

/* ------------------------------------------------------------ 接口夹具 */

/** 建沙箱（带两条注入声明：一条文件、一条目录）。 */
async function createSandboxWithInjections(files: string[]): Promise<SandboxDetailModel> {
  const response = await fetch(`${backendBaseUrl()}/api/sandboxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      name: SANDBOX_NAME,
      image: IMAGE,
      image_source: 'host',
      command: 'sleep infinity',
      files,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`创建带注入的沙箱失败（HTTP ${response.status}）：${text}`);
  }
  return (JSON.parse(text) as { metadata: SandboxDetailModel }).metadata;
}

/** 详情里的注入条目（旧实例没有该字段时按空列表处理）。 */
function injectionsOf(detail: SandboxDetailModel): InjectionModel[] {
  const extended = detail as SandboxDetailModel & { injections?: InjectionModel[] };
  return extended.injections ?? [];
}

/** 某条注入的屏幕元素（按 `data-entry-id` 定位，不靠行序）。 */
function injectionItem(page: Page, entryId: string) {
  return page.locator(
    `[data-testid="page-sandbox-detail-injection-item"][data-entry-id="${entryId}"]`,
  );
}

/** 点某条注入的「刷新副本」，并等这次 POST 的响应（状态码由调用方断言）。 */
async function clickRefresh(page: Page, entryId: string): Promise<number> {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/injections/${entryId}/refresh`),
    { timeout: 180_000 },
  );
  await injectionItem(page, entryId)
    .getByTestId('page-sandbox-detail-injection-refresh')
    .click();
  return (await pending).status();
}

/** 等终端里的哨兵变量展开值上屏（命令回显里只有 `$变量名`，值只可能来自活 shell）。 */
async function expectSentinel(
  page: Page,
  id: string,
  label: string,
  variableName: string,
  variableValue: string,
): Promise<void> {
  await typeInTerminal(page, id, `echo "${label}=$${variableName}"`);
  await expectTerminalText(page, id, `${label}=${variableValue}`, 30_000);
}

/* ------------------------------------------------------------ 用例 */

test.describe('注入副本手动刷新', () => {
  test.beforeAll(async () => {
    readFixtures();
    sources = createSources();
    // 上一轮残留先收掉：同名沙箱与它的终端会话记录都只属于验收前缀。
    await deleteSandbox(SANDBOX_NAME).catch(() => undefined);
    await clearTerminalSessions(SANDBOX_NAME);
    sandbox = await createSandboxWithInjections([
      `${sources.file}:${FILE_CONTAINER}`,
      `${sources.dir}:${DIR_CONTAINER}`,
    ]);
    injections = injectionsOf(sandbox);
    expect(injections, '详情里没有两条注入声明').toHaveLength(2);
    expect(injections.map((item) => item.kind).sort()).toEqual(['directory', 'file']);
  });

  test.afterAll(async () => {
    await deleteSandbox(SANDBOX_NAME).catch(() => undefined);
    await clearTerminalSessions(SANDBOX_NAME).catch(() => undefined);
    if (sources) {
      fs.rmSync(sources.root, { recursive: true, force: true });
    }
  });

  test('运行中逐条刷新：文件原位新值、目录递归镜像、只读与容器 / 会话不变', async ({ page }) => {
    const fileEntry = injections.find((item) => item.kind === 'file')!;
    const dirEntry = injections.find((item) => item.kind === 'directory')!;

    await gotoDetail(page, SANDBOX_NAME);
    sessionId = await openTerminal(page);
    await expectTerminalConnected(page);

    // 同一个活 shell 里的哨兵：刷新之后仍能展开成原值，才算会话没断。
    const sentinelValue = `ACC_INJECT_ALIVE_${TOKEN}`;
    await typeInTerminal(page, sessionId, `export ACC_INJECT_SENTINEL=${sentinelValue}`);
    await expectSentinel(page, sessionId, 'SENTINEL_SET', 'ACC_INJECT_SENTINEL', sentinelValue);

    // ── ① 源换代（宿主侧改，容器里还是创建时的快照）
    updateSources(sources);
    const sourceBefore = sourceSnapshot(sources.root);
    const identityBefore = containerIdentity(sandbox);
    const sessionsBefore = await listTerminalSessions(SANDBOX_NAME);
    const sessionBefore = sessionsBefore.find((item) => item.session_id === sessionId);
    expect(sessionBefore, '终端会话记录不在会话表里').toBeTruthy();

    // 刷新前容器里是旧快照（正向对照：不刷新就看不到新内容）
    expect(containerRead(sandbox, FILE_CONTAINER)).toBe(FILE_V1);
    expect(containerListing(sandbox, DIR_CONTAINER)).toEqual([
      'd empty',
      'd sub',
      'f empty/old.txt',
      'f gone.txt',
      'f keep.txt',
      'f sub/deep.txt',
    ]);

    // ── ② 详情抽屉：两条注入各一行，带 kind / entry_id，只显示元数据
    await openDetailDialog(page);
    await expect(page.getByTestId('page-sandbox-detail-injection-item')).toHaveCount(2);
    await expect(
      page.locator('[data-testid="page-sandbox-detail-injection-item"][data-kind="file"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="page-sandbox-detail-injection-item"][data-kind="directory"]'),
    ).toHaveCount(1);
    await expect(injectionItem(page, fileEntry.entry_id)).toHaveAttribute(
      'data-entry-id',
      fileEntry.entry_id,
    );
    await expect(injectionItem(page, dirEntry.entry_id)).toContainText(DIR_CONTAINER);
    // 界面只显示元数据：正文 / 内容标记一个字都不该出现。
    await expect(page.getByTestId('page-sandbox-detail-injections')).not.toContainText(FILE_V2);
    await expect(page.getByTestId('page-sandbox-detail-injections')).not.toContainText(NEW_FILE);

    test.info().annotations.push({
      type: '注入条目',
      description: `${fileEntry.entry_id}（文件）/ ${dirEntry.entry_id}（目录）`,
    });

    // ── ③ 刷新单文件：成功 toast + 容器内读到新值（原位覆盖，容器不重建）
    expect(await clickRefresh(page, fileEntry.entry_id), '单文件刷新没有回 204').toBe(204);
    await expect(toastItem(page, 'success', 'injection-refresh').last()).toContainText('副本已刷新');
    expect(containerRead(sandbox, FILE_CONTAINER)).toBe(FILE_V2);
    // 另一条注入不受影响：目录副本仍是创建时的旧快照
    expect(containerListing(sandbox, DIR_CONTAINER)).toContain('f gone.txt');
    expect(containerRead(sandbox, `${DIR_CONTAINER}/keep.txt`)).toBe(KEEP_V1);

    // ── ④ 刷新目录：新增 / 更新 / 删除 / 空目录保留，挂载根本身不消失
    expect(await clickRefresh(page, dirEntry.entry_id), '目录刷新没有回 204').toBe(204);
    await expect(toastItem(page, 'success', 'injection-refresh').last()).toContainText('副本已刷新');
    expect(containerPathExists(sandbox, DIR_CONTAINER, '-d'), '目录挂载根被删了').toBe(true);
    expect(containerListing(sandbox, DIR_CONTAINER)).toEqual([
      'd empty',
      'd sub',
      'f keep.txt',
      'f new.txt',
      'f sub/added.txt',
      'f sub/deep.txt',
    ]);
    expect(containerRead(sandbox, `${DIR_CONTAINER}/keep.txt`)).toBe(KEEP_V2);
    expect(containerRead(sandbox, `${DIR_CONTAINER}/new.txt`)).toBe(NEW_FILE);
    expect(containerRead(sandbox, `${DIR_CONTAINER}/sub/deep.txt`)).toBe(DEEP_V2);
    expect(containerRead(sandbox, `${DIR_CONTAINER}/sub/added.txt`)).toBe(ADDED_DEEP);
    // 真实空目录：本身保留、子项被清空
    expect(containerPathExists(sandbox, `${DIR_CONTAINER}/empty`, '-d'), '空目录被删了').toBe(true);
    expect(
      containerShell(sandbox, `find ${DIR_CONTAINER}/empty -mindepth 1 -print`).stdout.trim(),
      '空目录里还留着旧成员',
    ).toBe('');
    // 单文件那条同样没有被目录刷新带跑
    expect(containerRead(sandbox, FILE_CONTAINER)).toBe(FILE_V2);

    // ── ⑤ 只读仍然生效（文件与目录写都撞 EROFS）
    expectReadOnly(sandbox, FILE_CONTAINER);
    expectReadOnly(sandbox, `${DIR_CONTAINER}/probe.txt`);

    // ── ⑥ 宿主原件零接触：权限 / 属主 / 大小 / mtime / 内容全一致
    expect(sourceSnapshot(sources.root), '刷新动了宿主原件').toBe(sourceBefore);
    expect(fs.statSync(sources.file).mode & 0o777, '宿主原件权限被改了').toBe(0o600);
    expect(fs.readFileSync(sources.file, 'utf-8'), '宿主原件内容被改了').toBe(FILE_V2);

    // ── ⑦ 容器与终端会话都没重启：id / StartedAt / host_pid / created_at 不变
    expect(containerIdentity(sandbox), '刷新把容器重建了').toBe(identityBefore);
    const sessionsAfterRefresh = await listTerminalSessions(SANDBOX_NAME);
    const sessionAfterRefresh = sessionsAfterRefresh.find((item) => item.session_id === sessionId);
    expect(sessionAfterRefresh, '刷新后终端会话记录没了').toBeTruthy();
    expect(sessionAfterRefresh!.host_pid, '刷新后终端会话的主进程换了').toBe(
      sessionBefore!.host_pid,
    );
    expect(sessionAfterRefresh!.created_at, '刷新后终端会话被重建了').toBe(
      sessionBefore!.created_at,
    );
    expect(sessionAfterRefresh!.state).toBe('running');

    // 同一个活 shell 里哨兵仍可展开（与 host_pid 不变并列的第二条证据）
    await closeDetailDialog(page);
    await expectSentinel(page, sessionId, 'SENTINEL_ALIVE', 'ACC_INJECT_SENTINEL', sentinelValue);

    // ── ⑧ 页面刷新后：副本仍可见、仍只读，终端挂回原会话
    await page.reload();
    await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(SANDBOX_NAME);
    // 页面刷新后路由里仍带着会话标识：面板按路由自动挂回**原会话**（不点标签，
    // 点标签在这条路径上反而会变成空操作，见 `selectTerminal` 的前置检查）。
    await expect(
      page.locator(
        `[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`,
      ),
    ).toHaveCount(1, { timeout: 60_000 });
    await expectTerminalConnected(page);
    await expectSentinel(page, sessionId, 'SENTINEL_RELOAD', 'ACC_INJECT_SENTINEL', sentinelValue);

    await openDetailDialog(page);
    await expect(page.getByTestId('page-sandbox-detail-injection-item')).toHaveCount(2);
    await expect(injectionItem(page, fileEntry.entry_id)).toContainText(FILE_CONTAINER);
    await expect(injectionItem(page, fileEntry.entry_id)).toContainText('只读');
    await expect(injectionItem(page, dirEntry.entry_id)).toContainText(DIR_CONTAINER);
    await expect(injectionItem(page, dirEntry.entry_id)).toContainText('只读');
    await expect(injectionItem(page, fileEntry.entry_id)).toHaveAttribute('data-kind', 'file');
    await expect(injectionItem(page, dirEntry.entry_id)).toHaveAttribute('data-kind', 'directory');
    // 页面刷新只是一次 GET：容器身份与终端会话仍与刷新前一致
    expect(containerIdentity(sandbox), '页面刷新后容器身份变了').toBe(identityBefore);
    const sessionAfterReload = (await listTerminalSessions(SANDBOX_NAME)).find(
      (item) => item.session_id === sessionId,
    );
    expect(sessionAfterReload, '页面刷新后终端会话记录没了').toBeTruthy();
    expect(sessionAfterReload!.host_pid).toBe(sessionBefore!.host_pid);
  });

  test('源缺失负例：副本不被清空，修正后手动重试成功；刷新详情只发 GET', async ({ page }) => {
    const dirEntry = injections.find((item) => item.kind === 'directory')!;

    await gotoDetail(page, SANDBOX_NAME);

    // ── ① 「刷新详情」是读操作：点它期间刷新端点一个 POST 都不该出现
    const posts: string[] = [];
    const recordPost = (request: { method: () => string; url: () => string }): void => {
      if (request.method() === 'POST' && request.url().includes(REFRESH_ENDPOINT)) {
        posts.push(request.url());
      }
    };
    page.on('request', recordPost);
    const detailGet = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url() ===
          `${backendBaseUrl()}/api/sandboxes/${encodeURIComponent(SANDBOX_NAME)}`,
      { timeout: 60_000 },
    );
    await page.getByTestId('page-sandbox-detail-refresh-button').click();
    await detailGet;
    // 观察窗口：详情页会定时轮询 GET，这段时间里也不该冒出刷新 POST。
    await page.waitForTimeout(2_000);
    page.off('request', recordPost);
    expect(posts, '「刷新详情」发出了刷新副本的 POST（读操作写了）').toEqual([]);

    // ── ② 把宿主源目录挪走：预检失败，副本一个字节都不动
    await openDetailDialog(page);
    expect(injectionItem(page, dirEntry.entry_id)).toHaveCount(1);
    const listingBefore = containerListing(sandbox, DIR_CONTAINER);
    expect(listingBefore, '负例前置：目录副本里应已有刷新后的成员').toContain('f keep.txt');

    const hidden = `${sources.dir}.missing`;
    fs.renameSync(sources.dir, hidden);
    expect(await clickRefresh(page, dirEntry.entry_id), '源缺失时刷新竟然成功了').toBe(400);
    await expect(toastItem(page, 'error', 'injection-refresh').last()).toContainText(
      PRECHECK_DETAIL,
    );
    // 副本未被清空：清单与失败前一模一样，挂载根仍在
    expect(containerListing(sandbox, DIR_CONTAINER), '源缺失的刷新把副本清空了').toEqual(
      listingBefore,
    );
    expect(containerPathExists(sandbox, DIR_CONTAINER, '-d'), '负例之后目录挂载根不见了').toBe(true);
    expect(containerPathExists(sandbox, `${DIR_CONTAINER}/empty`, '-d')).toBe(true);

    // ── ③ 修正源（挪回来 + 再放一个新成员）→ 用户手动重试成功
    fs.renameSync(hidden, sources.dir);
    writeSourceFile(path.join(sources.dir, 'retry.txt'), RETRY_FILE, 0o644);
    const sourceBeforeRetry = sourceSnapshot(sources.root);
    expect(await clickRefresh(page, dirEntry.entry_id), '修正后重试没有回 204').toBe(204);
    await expect(toastItem(page, 'success', 'injection-refresh').last()).toContainText('副本已刷新');
    expect(containerRead(sandbox, `${DIR_CONTAINER}/retry.txt`)).toBe(RETRY_FILE);
    expect(containerListing(sandbox, DIR_CONTAINER)).toContain('f retry.txt');
    // 重试同样不碰宿主原件
    expect(sourceSnapshot(sources.root), '重试动了宿主原件').toBe(sourceBeforeRetry);
  });
});

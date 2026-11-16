/**
 * 镜像缓存清单（端点 + 注入 + cached-images 命令）真机验收。
 *
 * 需求：`docs/prds/registry-cache-manifest.md`「验收标准」B（端点与鉴权矩阵
 * PRD 8~11）、C（注入链路的端到端 PRD 21）、E（console 视图 PRD 27/28）；
 * 任务：`docs/tasks/registry-cache-manifest/06-acceptance-and-docs.md`。
 * 01~05 已分别钉住扫描器、端点单测、注入管线与镜像内命令——本 spec 在
 * **真浏览器 + 真沙箱 + 真缓存**上钉住它们的合流：
 *
 * 一、**端到端（PRD 21）**：console 抽屉创建沙箱（`base:0.4.2`，容器自带
 *    `cached-images` 与平台注入的 `SANDBOX_IMAGE_CACHE_URL` / `…_TOKEN`
 *    两个 env）→ 网页终端里读出注入 URL（宿主非回环 IPv4 + 实际端口的
 *    探测兜底形态，PRD 18）→ **spec 侧起一条 TCP 转发**（同一端口绑到注入
 *    地址、逐字节透传给回环上的真后端——验收后端按既有 setup 绑 `127.0.0.1`，
 *    沙箱不可直达；转发只补网络可达性，不改被测服务的绑定与代码，端点数据
 *    仍出自同一个服务进程。生产部署绑 `0.0.0.0` 时不需要它）→ 容器内跑
 *    `cached-images`（stdout/stderr 重定向进 `/workspace`，经文件通道取回
 *    全量字节——表格虽短仍走同一通道保持全量字节比对）→ 与端点
 *    `?format=text&tags=only` 比对：同一服务、同一份 TTL 缓存，**表格本体
 *    全等**（0.4.2 输出清理：服务端表格仅表体——轻表头行（内嵌生成时间）
 *    与 SIZE 尾注行已去，命令正常态也不再追加引导行——输出里没有任何动态
 *    生成行，跨过 60 秒 TTL 也无需归一化），退出码 0；
 * 二、**端点两格式（PRD 9/10）**：`?format=json`（缺省同）200 +
 *    `application/json`，`generated_at` + 条目五字段 + 三计数齐全；
 *    `?format=text` 200 + `text/plain`，表头 / 条目 / 尾注两则（缺省 text
 *    零改动，仍是 PRD 验收 10 的载体）；`tags=only` 补断言（json 只留标签
 *    非空条目 + text 表格仅表体的正反两钉：首行即列头、无轻表头/尾注行）；
 * 三、**端点负例（PRD 8/11）**：无凭据 401、错误令牌 401（同一句固定文案
 *    「访问令牌无效或缺失」原文断言、两种响应逐字节一致）；非法 format 422
 *    （固定文案原文断言）；
 * 四、**console 视图冒烟（PRD 27/28）**：设置抽屉「代理」tab 的「缓存镜像清单」
 *    表格数据态（IMAGE / ID / SIZE / CACHED TIME 四列 + 生成时间脚注）、本地
 *    搜索过滤（纯本地，不发请求）、手动刷新后数据仍在（60 秒 TTL 内刷新拿
 *    同一份缓存，属预期）。
 *
 * 镜像：显式 pin `sandbox-platform/base:0.4.2`（0.4.1：`cached-images` 消费
 * `tags=only` 表格视图随它发布；0.4.2：输出仅表体、正常态零追加随它发布；
 * 既有 spec 各钉各自轮次的版本、不回改，
 * 14/15 钉 0.3.1 同款惯例）。
 * 清理：spec 创建的沙箱用例后必删（`acc-` 前缀，按名清理；setup/teardown 收尾另按 `acc-` 前缀自动兜底清扫）。
 * 空态与失败态的字段细节由前端单测覆盖（`SettingsDialog.test.tsx`），这里
 * 只冒烟真机数据态——真缓存在本机非空。
 */

import * as net from 'node:net';

import { expect, test } from '@playwright/test';

import {
  backendBaseUrl,
  clearTerminalSessions,
  deleteSandbox,
  downloadSandboxFile,
} from '../helpers/api';
import { AUTH_FAILED_DETAIL, authHeaders, bearerHeaders } from '../helpers/auth';
import {
  fillCreateForm,
  gotoDetail,
  openCreateDialog,
  openSettingsDrawer,
  selectCreatedSandbox,
} from '../helpers/console';
import { readFixtures } from '../helpers/sandbox';
import {
  expectTerminalConnected,
  expectTerminalRow,
  expectTerminalText,
  openTerminal,
  terminalRows,
  typeInTerminal,
} from '../helpers/terminal';

/** 本轮 base image（0.4.2：`cached-images` 输出仅表体、正常态零追加随它发布）。 */
const IMAGE = 'sandbox-platform/base:0.4.2';
/** 主链路沙箱（console 抽屉创建，用例后必删）。 */
const SANDBOX = 'acc-cache-images';
/** 容器内输出文件（stdout / stderr 分开，文件通道取回全量字节）。 */
const OUTPUT = '/workspace/acc-cached-images.txt';
const OUTPUT_ERR = '/workspace/acc-cached-images.err';

/** 服务端 text 渲染（默认视图）的表头首行（契约副本，故意各留一份：改了要红）。 */
const TEXT_HEADER = '镜像缓存清单（收录拉取过的镜像：manifest 在缓存即条目）';
/** 尾注两则的识别前缀（同上，契约副本）。 */
const TEXT_NOTE_TOTAL = '说明：total_size_bytes';
const TEXT_NOTE_DUP = '注记：同一镜像可能出现';
/** tag-only 表格的列头行关键词（0.4.1 轮新增视图，契约副本）。 */
const TABLE_COLUMN_HEADER = 'IMAGE';
/** tag-only 表格首条数据行的 repo:tag 钉（真缓存按 repo 排序后的首行，契约副本）。 */
const TABLE_FIRST_DATA_ROW = 'astral-sh/uv:0.13.7';
/** tag-only 表格的轻表头关键词（0.4.2 起退役——否定钉用）。 */
const TABLE_LIGHT_HEADER_RETIRED = '已缓存镜像';
/** tag-only 表格尾注整行（0.4.2 起退役——否定钉用）。 */
const TABLE_FOOTER_RETIRED = 'SIZE 为拉取该条所需链字节，条目间共享 blob，不可求和当缓存占用';
/** `cached-images` 旧正常态尾部追加的引导语（0.4.2 起退役——否定钉用）。 */
const GUIDE_LINE_RETIRED =
  '提示：拉依赖镜像前先查缓存镜像清单，可接受的版本集合中优先选已缓存版本（未命中再回退正常拉取）。';
/** format 非法值的 422 固定文案（`routes/proxy.py` 的 `CACHE_FORMAT_INVALID_DETAIL` 契约副本）。 */
const FORMAT_422_DETAIL = 'format 取值非法（只支持 json 或 text）';

/** spec 内起的 TCP 转发器（让注入地址在绑回环的验收形态下可达），用例后关掉。 */
let forwarder: net.Server | null = null;
/** 转发器的存活连接名册（client + upstream 两侧）：afterAll 闭环清理用。 */
const forwarderSockets = new Set<net.Socket>();

/**
 * 起一条 TCP 转发：绑 `listenHost:listenPort`，逐字节透传给回环上的真后端。
 *
 * 为什么要在 spec 里做这一层：验收后端按既有 setup 绑 `127.0.0.1`（`helpers/
 * server.ts` 的惯例，不改），而注入给沙箱的可达地址是**宿主非回环 IPv4 +
 * 实际端口**（`injection.py` 的探测兜底）——沙箱去连那个地址会撞上「没绑」。
 * 部署绑回环时沙箱侧失效是**已接受的部署前提**（PRD 30）；这条转发只在为
 * 让端到端可验：它不改被测服务的绑定与代码，端点数据仍出自同一个服务进程
 * （同一份 60 秒 TTL 缓存），「输出与端点 text 一致」的同源断言不受影响。
 */
function startForwarder(listenHost: string, listenPort: number, backendPort: number): Promise<void> {
  if (listenHost === '127.0.0.1' || listenHost === 'localhost' || listenHost === '::1') {
    throw new Error(
      `注入地址 ${listenHost} 是回环地址（部署绑回环形态，沙箱侧本就失效，PRD 30）：
       本 spec 的端到端需要宿主非回环 IPv4 的部署形态（生产绑 0.0.0.0 的形态）`,
    );
  }
  const server = net.createServer((client) => {
    const upstream = net.connect(backendPort, '127.0.0.1');
    // 登记存活连接（两侧都记）：close() 只停收新连接，存量连接的闭环清理
    // 靠这份名册（net.Server 没有 http.Server 的 closeAllConnections）。
    forwarderSockets.add(client);
    forwarderSockets.add(upstream);
    client.once('close', () => forwarderSockets.delete(client));
    upstream.once('close', () => forwarderSockets.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
    const teardown = (): void => {
      upstream.destroy();
      client.destroy();
    };
    client.on('error', teardown);
    upstream.on('error', teardown);
  });
  forwarder = server;
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      // listen 成功后补常驻 error 监听：转发器存活期内 server 层再出错时记
      // 日志降级，而不是变成 uncaught exception 击穿整个 worker 进程。
      server.on('error', (err: Error) =>
        console.warn(`[16-cache-images] 转发器 error（降级不抛）: ${err.message}`),
      );
      resolve();
    });
  });
}

/** 直取缓存清单端点（同 `helpers/api.request` 口径：带认证头、返回原始响应）。 */
async function fetchCacheImages(
  query: string,
  headers: Record<string, string> = authHeaders(),
): Promise<{ status: number; body: string; contentType: string; wwwAuthenticate: string | null }> {
  const response = await fetch(`${backendBaseUrl()}/api/proxy/cache/images${query}`, { headers });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
    wwwAuthenticate: response.headers.get('www-authenticate'),
  };
}

/**
 * 0.4.2 输出清理说明：此前的跨 TTL 归一化助手（按「生成时间：」前缀滤行）
 * 已删除——不再需要。原因：tags=only 表格仅表体（轻表头行内嵌的「清单生成
 * 时间」与命令尾部的引导行都已去），输出里没有任何随扫描时间漂移的行；
 * 两次取跨过 60 秒 TTL 时，只要缓存在两扫之间没变，正文依然逐字一致。
 * 条目集在两扫之间变化属并发拉镜像的已知边界（与旧口径同）。
 */

test.describe('镜像缓存清单（端点 / 注入 / cached-images）', () => {
  test.beforeAll(async () => {
    readFixtures();
    // 「先删再建」：同名残留会让 console 创建直接失败。
    await deleteSandbox(SANDBOX).catch(() => undefined);
  });

  test.afterAll(async () => {
    forwarder?.close();
    // close() 只停收新连接、不等存量连接断开；net.Server 没有 http.Server 的
    // closeAllConnections()（Node 22 运行时与 @types 均无，可选链只会静默空转），
    // 转发器自己登记了存活连接，这里逐个销毁完成闭环。
    for (const socket of forwarderSockets) {
      socket.destroy();
    }
    forwarderSockets.clear();
    forwarder = null;
    await deleteSandbox(SANDBOX).catch((error: unknown) => {
      // 清理失败不抛（不该炸整个报告），但必须可见：留痕进报告注记。
      // afterAll 钩子跑在末条用例的 After Hooks 内，注记会落在报告里。
      test.info().annotations.push({
        type: '清理失败',
        description: `沙箱 ${SANDBOX} 收尾删除失败：${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });

  // 终端会话是宿主侧持久资源：清场让「读注入 env」的行定位不受残留会话干扰。
  test.beforeEach(async () => {
    await clearTerminalSessions(SANDBOX);
  });

  test('端到端（PRD 21）：console 创建的沙箱内 cached-images 输出与端点 text 同源一致，退出码 0', async ({
    page,
  }) => {
    // ── ① console 抽屉创建沙箱（镜像选择器里选 base:0.4.2）
    await openCreateDialog(page);
    await fillCreateForm(page, {
      name: SANDBOX,
      image: IMAGE,
      command: 'sleep infinity',
    });
    await selectCreatedSandbox(page, SANDBOX);

    // ── ② 注入在场：网页终端里读出平台注入的两个 env（URL 全文 + 令牌前缀）
    await gotoDetail(page, SANDBOX);
    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);
    await typeInTerminal(page, sessionId, `printf 'ACC_URL=%s\\n' "$SANDBOX_IMAGE_CACHE_URL"`);
    // 匹配锚定完整 URL：命令回显行里是 `ACC_URL=%s`，不会撞上。
    let injectedUrl = '';
    await expect
      .poll(
        async () => {
          const row = (await terminalRows(page, sessionId)).find((line) =>
            /^ACC_URL=http:\/\//.test(line.trim()),
          );
          injectedUrl = row?.trim().slice('ACC_URL='.length) ?? '';
          return injectedUrl;
        },
        { timeout: 30_000, message: '终端里没读到注入的 SANDBOX_IMAGE_CACHE_URL' },
      )
      .toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
    await typeInTerminal(
      page,
      sessionId,
      `printf 'ACC_TOKEN_PREFIX=%s\\n' "\${SANDBOX_IMAGE_CACHE_TOKEN:0:5}"`,
    );
    // 受限令牌前缀 `sbxr_`（auth.py 的 CACHE_TOKEN_PREFIX 契约）——端到端再钉一次。
    await expectTerminalRow(page, sessionId, 'ACC_TOKEN_PREFIX=sbxr_');

    // ── ③ 转发器：让注入地址可达（绑同端口，透传回环上的真后端）
    const injected = new URL(injectedUrl);
    const { port: backendPort } = readFixtures();
    await startForwarder(injected.hostname, Number(injected.port), backendPort);

    // ── ④ 同刻端点 text（tags=only 表格视图，命令消费的就是这个 URL）。
    //    0.4.2 起输出仅表体、无动态生成行，取端点与跑命令无需同挤一个 TTL 窗口；
    //    先取端点文本，紧跟着跑命令，仍是同一份数据的最短窗口。
    const expected = await fetchCacheImages('?format=text&tags=only');
    expect(expected.status, '端点 text 应 200').toBe(200);

    // ── ⑤ 容器内跑 cached-images：stdout/stderr 落文件（29 条目清单远超终端视口），
    //    退出码回显进终端
    await typeInTerminal(
      page,
      sessionId,
      `cached-images > ${OUTPUT} 2> ${OUTPUT_ERR}; printf 'ACC_RC=%s\\n' "$?"`,
    );
    await expectTerminalRow(page, sessionId, 'ACC_RC=0');

    // ── ⑥ 文件通道取回全量字节，与端点 text 比对（同数据源）
    const output = (await downloadSandboxFile(SANDBOX, OUTPUT)).bytes.toString('utf-8');
    const outputErr = (await downloadSandboxFile(SANDBOX, OUTPUT_ERR)).bytes.toString('utf-8');
    expect(outputErr, '正常态 stderr 应为空（没有降级提示）').toBe('');
    // 主断言：表格本体全等（输出 = 端点正文，0.4.2 起命令零追加、服务端
    // 仅表体——轻表头行内嵌的生成时间与尾注已去，正文里没有任何动态行，
    // 故不需要旧的跨 TTL 归一化分支；两扫之间条目集变化属并发拉镜像的
    // 已知边界，与旧口径同）。
    expect(output, '输出应与端点 tags=only 正文逐字全等（命令零追加、服务端仅表体）').toBe(
      expected.body,
    );
    // 退役形态的否定钉（契约副本逐字）：旧的前后缀说明行一个都不能回来。
    expect(output, '正常态不得再追加引导行').not.toContain(GUIDE_LINE_RETIRED);
    expect(output, '表格不得再带轻表头行').not.toContain(TABLE_LIGHT_HEADER_RETIRED);
    expect(output, '表格不得再带 SIZE 尾注行').not.toContain(TABLE_FOOTER_RETIRED);

    // ── ⑦ 可见旁证：网页终端里直接跑（不重定向），列头行与首条数据行在屏幕上
    //    （数据行的 ID/时间是动态值，整行相等不可用；用整屏包含钉关键词）
    await typeInTerminal(page, sessionId, 'cached-images | head -n 2');
    await expectTerminalText(page, sessionId, TABLE_COLUMN_HEADER);
    // head -n 2 的第二行即首条数据行（真缓存按 repo 排序，astral-sh/uv 首行）。
    await expectTerminalText(page, sessionId, TABLE_FIRST_DATA_ROW);
  });

  test('端点两格式：json（缺省同）字段齐全、text 预渲染表头尾注（PRD 9/10）', async () => {
    // ── ?format=json：200 + application/json + generated_at + 条目五字段 + 三计数
    const json = await fetchCacheImages('?format=json');
    expect(json.status).toBe(200);
    expect(json.contentType).toContain('application/json');
    const payload = JSON.parse(json.body) as {
      generated_at: string;
      images: {
        repo: string;
        tags: string[];
        digest: string;
        total_size_bytes: number;
        cached_at: string;
      }[];
      total_files: number;
      blob_files: number;
      skipped_files: number;
    };
    expect(payload.generated_at, '生成时间戳应非空').not.toBe('');
    expect(Array.isArray(payload.images)).toBe(true);
    expect(payload.images.length, '本机真缓存应有条目（空缓存部署由单测钉空态）').toBeGreaterThan(0);
    const first = payload.images[0];
    expect(first.repo).not.toBe('');
    expect(Array.isArray(first.tags)).toBe(true);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Number.isFinite(first.total_size_bytes)).toBe(true);
    expect(first.cached_at).not.toBe('');
    expect(Number.isFinite(payload.total_files)).toBe(true);
    expect(Number.isFinite(payload.blob_files)).toBe(true);
    expect(Number.isFinite(payload.skipped_files)).toBe(true);

    // ── 缺省（不带 query）与 json 同格式
    const defaulted = await fetchCacheImages('');
    expect(defaulted.status).toBe(200);
    expect(defaulted.contentType).toContain('application/json');

    // ── ?format=text：200 + text/plain + 表头 + 生成时间 + 尾注两则
    const text = await fetchCacheImages('?format=text');
    expect(text.status).toBe(200);
    expect(text.contentType).toContain('text/plain');
    expect(text.body.startsWith(TEXT_HEADER), 'text 应以表头首行开头').toBe(true);
    expect(text.body).toContain('生成时间：');
    expect(text.body).toContain(TEXT_NOTE_TOTAL);
    expect(text.body).toContain(TEXT_NOTE_DUP);
    // json 与 text 共享同一份扫描结果：同一生成时间戳（同一 TTL 窗口内两次取）。
    expect(text.body).toContain(`生成时间：${payload.generated_at}`);

    // ── tags=only（0.4.1 轮）：json 只留标签非空条目（同参数同语义）
    const tagged = await fetchCacheImages('?format=json&tags=only');
    expect(tagged.status).toBe(200);
    expect(tagged.contentType).toContain('application/json');
    const taggedPayload = JSON.parse(tagged.body) as {
      generated_at: string;
      images: { tags: string[] }[];
    };
    expect(Array.isArray(taggedPayload.images)).toBe(true);
    expect(
      taggedPayload.images.length,
      'tags=only 条目数应不多于默认视图（同一次扫描结果过滤）',
    ).toBeLessThanOrEqual(payload.images.length);
    for (const image of taggedPayload.images) {
      expect(image.tags.length, 'tags=only 每条都应有非空标签').toBeGreaterThan(0);
    }
    expect(
      taggedPayload.images.length,
      '本机真缓存应有带标签条目（python 3.11-slim/3.12-slim、uv 0.13.7）',
    ).toBeGreaterThan(0);

    // ── tags=only 的 text：docker images 风格表格，仅表体（0.4.2 输出清理：
    //    首行即列头，无轻表头行 / 无 SIZE 尾注行；缺省 text 与 json 不受影响）
    const table = await fetchCacheImages('?format=text&tags=only');
    expect(table.status).toBe(200);
    expect(table.contentType).toContain('text/plain');
    const tableFirstLine = table.body.split('\n')[0] ?? '';
    expect(tableFirstLine.startsWith(TABLE_COLUMN_HEADER), '表格应以列头行开头（仅表体）').toBe(true);
    expect(tableFirstLine).not.toContain('清单生成时间：');
    expect(table.body).toContain('CACHED TIME');
    // 0.4.2 退役形态否定钉：轻表头 / SIZE 尾注 / 缺省 text 的两行现象注都不在。
    expect(table.body).not.toContain(TABLE_LIGHT_HEADER_RETIRED);
    expect(table.body).not.toContain(TABLE_FOOTER_RETIRED);
    // 「两行现象」注在 tag-only 视图不适用（无标签行已被滤除），不再渲染。
    expect(table.body).not.toContain(TEXT_NOTE_DUP);
  });

  test('端点负例：无凭据 401 / 错误令牌 401（同一句固定文案原文）/ 非法 format 422（PRD 8/11）', async () => {
    // ── 无凭据 401：固定文案 + WWW-Authenticate 挑战头
    const anonymous = await fetchCacheImages('?format=text', {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.wwwAuthenticate).toBe('Bearer');
    expect(anonymous.body, '无凭据 401 的 detail 原文').toContain(AUTH_FAILED_DETAIL);

    // ── 错误令牌 401：与无凭据**逐字节同一份响应**（缺失与错误不区分）
    const wrong = await fetchCacheImages('?format=text', bearerHeaders('sbx_not_the_right_token'));
    expect(wrong.status).toBe(401);
    expect(wrong.body).toBe(anonymous.body);
    expect(wrong.wwwAuthenticate).toBe('Bearer');

    // ── 非法 format 422：固定文案原文（合法令牌、只有 format 不对）
    const invalid = await fetchCacheImages('?format=xml');
    expect(invalid.status).toBe(422);
    expect(invalid.body, '非法 format 的 422 detail 原文').toContain(FORMAT_422_DETAIL);
  });

  test('console 视图冒烟：缓存镜像清单表格渲染 + 搜索过滤 + 手动刷新（PRD 27/28）', async ({ page }) => {
    await openSettingsDrawer(page);

    // 打开抽屉即加载一次：等加载结束（刷新按钮回到可用态）再看数据。
    const refresh = page.getByTestId('page-settings-cache-images-refresh-button');
    await expect(refresh, '缓存清单加载应结束（刷新按钮回到可用态）').toBeEnabled({
      timeout: 30_000,
    });

    // 数据态（本机真缓存非空）：表格在场，行按 (repo, tag) 排序。
    const rows = page.getByTestId('page-settings-cache-images-row');
    await expect(rows, '本机真缓存应有条目（空态由前端单测钉）').not.toHaveCount(0);
    const first = rows.first();
    const image = ((await first.getByTestId('page-settings-cache-images-image').textContent()) ?? '').trim();
    expect(image, 'IMAGE 列应是 repo:tag').toMatch(/^[^\s]+:[^\s]+$/);
    // ID 列：去 sha256: 前缀后的前 12 位十六进制（完整 digest 挂 title）。
    await expect(first.getByTestId('page-settings-cache-images-id')).toHaveText(/^[0-9a-f]{12}$/);
    // SIZE 列：**十进制**人读大小（1000 进制，不是二进制 KiB/MiB）。
    await expect(first.getByTestId('page-settings-cache-images-size')).toHaveText(
      /^\d+(\.\d+)?(B|kB|MB|GB|TB)$/,
    );
    // CACHED TIME 列：UTC 口径 YYYY-MM-DD HH:mm:ss。
    await expect(first.getByTestId('page-settings-cache-images-time')).toHaveText(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    // 生成时间戳随数据一起展示。
    await expect(page.getByTestId('page-settings-cache-images-generated-at')).toContainText(
      '清单生成时间：',
    );

    // 搜索过滤：**纯本地**，不发请求。按完整 repo:tag 搜 → 只剩命中的行。
    const total = await rows.count();
    const search = page.getByTestId('page-settings-cache-images-search-input');
    await search.fill(image);
    await expect(rows).not.toHaveCount(0);
    expect(await rows.count(), '按 repo:tag 搜索后行数应变少').toBeLessThan(total);
    for (const text of await rows.allTextContents()) {
      expect(text, '命中的行都该含搜索关键字').toContain(image);
    }

    // 搜索无命中：另一种空态（与「清单本身为空」分开）。
    await search.fill('zzz-没有这个镜像');
    await expect(page.getByTestId('page-settings-cache-images-search-empty')).toBeVisible();
    await expect(rows).toHaveCount(0);

    // 清空 → 全部回来。
    await search.fill('');
    await expect(rows).toHaveCount(total);

    // 表格内部滚动、**表头吸顶**：代理 tab 顶部的状态区不跟着滚。
    const head = page.getByTestId('page-settings-cache-images-head');
    const headTopBefore = (await head.boundingBox())!.y;
    const statusTopBefore = (await page.getByTestId('page-settings-cache-size').boundingBox())!.y;
    await page.getByTestId('page-settings-cache-images-table').evaluate((table) => {
      const scroller = table.parentElement;
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    await page.waitForTimeout(200);
    expect((await head.boundingBox())!.y, '表头没有吸顶').toBeCloseTo(headTopBefore, 0);
    expect(
      (await page.getByTestId('page-settings-cache-size').boundingBox())!.y,
      '顶部状态区跟着表格滚了',
    ).toBeCloseTo(statusTopBefore, 0);

    // 手动刷新：仍在的数据态（60 秒 TTL 内刷新拿同一份缓存，属预期）。
    await refresh.click();
    await expect(refresh, '刷新应完成（按钮回到可用态）').toBeEnabled({ timeout: 30_000 });
    await expect(rows).not.toHaveCount(0);
    await expect(page.getByTestId('page-settings-cache-images-generated-at')).toContainText(
      '清单生成时间：',
    );
  });
});

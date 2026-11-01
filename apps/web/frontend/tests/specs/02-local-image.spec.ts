/**
 * 本地构建镜像验收：宿主现场构建一个「不存在于任何仓库」的镜像，
 * 验证它能出现在网页的镜像下拉里、选中后能创建出沙箱（注入路径走通）。
 */

import fs from 'node:fs';
import { expect, test } from '@playwright/test';

import { getSandbox, listImages } from '../helpers/api';
import {
  fillCreateForm,
  openCreateDialog,
  openImagePicker,
  searchImage,
  selectCreatedSandbox,
} from '../helpers/console';
import { sandboxExec, userUid } from '../helpers/host';
import { RUNTIME_DIR } from '../helpers/paths';
import { readFixtures } from '../helpers/sandbox';

const SANDBOX_NAME = 'acc-localimg';

test.describe('本地构建镜像（不存在于任何仓库）', () => {
  test('镜像出现在下拉里，选中后创建成功，且沙箱守护进程里确实拿到了它', async ({ page }) => {
    const fixtures = readFixtures();
    const reference = fixtures.localImage.reference;
    test.info().annotations.push({
      type: '测试镜像',
      description: `${reference} · ${(fixtures.localImage.sizeBytes / 1024 / 1024).toFixed(1)} MB · 构建耗时 ${fixtures.localImage.buildMs} 毫秒 · 镜像 ID ${fixtures.localImage.imageId.slice(7, 19)}`,
    });

    // ── ① 镜像确实不在任何仓库（构建时已探测过，这里再留一次证据）
    let registryProbe = '未探测（宿主无外网）';
    try {
      const manifest = await page.request.fetch(
        `https://registry-1.docker.io/v2/${reference.split(':')[0]}/manifests/${reference.split(':')[1]}`,
        { timeout: 30_000 },
      );
      registryProbe = `直接探测仓库 HTTP ${manifest.status()}`;
    } catch (error) {
      registryProbe = `直接探测仓库失败：${(error as Error).message.split('\n')[0]}`;
    }
    test.info().annotations.push({
      type: '仓库探测',
      description: `${fixtures.localImage.manifestProbe}；${registryProbe}`,
    });

    // ── ② 新建抽屉的镜像选择器里能搜到它
    await openCreateDialog(page);
    await openImagePicker(page);
    await searchImage(page, reference);
    // 前端本地筛选：只留下命中的这一条。
    await expect(page.getByTestId('page-sandbox-create-image-option')).toHaveCount(1);
    await expect(page.locator(`[data-image-reference="${reference}"]`)).toHaveCount(1);
    const images = await listImages();
    expect(images.some((item) => item.reference === reference)).toBe(true);

    // ── ③ 选中它创建沙箱
    await fillCreateForm(page, {
      name: SANDBOX_NAME,
      image: reference,
      command: 'sleep infinity',
    });
    // 创建成功不再自动选中：从侧栏选中新沙箱。
    await selectCreatedSandbox(page, SANDBOX_NAME);
    await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();

    // 工作区头部摘要里就是这个镜像（不是详情弹窗）
    await expect(page.getByTestId('page-sandbox-detail-image')).toHaveText(reference);

    const detail = await getSandbox(SANDBOX_NAME);
    expect(detail.image).toBe(reference);
    expect(detail.image_source).toBe('host');

    // ── ④ 注入路径走通：沙箱守护进程里有这个镜像
    //    （这个镜像任何仓库里都没有，守护进程能拿到只可能是宿主注入的产物）
    const uid = userUid(detail.system_user);
    const inspect = sandboxExec(detail.system_user, uid, [
      'docker',
      'image',
      'inspect',
      reference,
      '--format',
      '{{.Id}}',
    ]);
    expect(inspect.code, `沙箱守护进程里没有镜像 ${reference}：${inspect.stderr}`).toBe(0);
    expect(inspect.stdout.trim()).not.toBe('');

    // ── ⑤ 服务日志里能看到「按强制从宿主注入模式准备镜像」
    const logFile = `${RUNTIME_DIR}/server.log`;
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
    expect(log, '服务日志里没有宿主注入镜像的记录').toContain('按强制从宿主注入模式准备镜像');
    expect(log).toContain(reference);
  });

  test('宿主上没有的镜像不能被网页选用（报错说人话）', async ({ page }) => {
    await openCreateDialog(page);
    // 前端只允许选搜索得到的镜像；这里直接绕过前端校验，
    // 用「宿主不存在的镜像」调接口，确认后端按契约报错而不是降级直连
    const response = await page.request.post('/api/sandboxes', {
      data: {
        name: 'acc-nohost',
        image: 'sandbox-console-acceptance/does-not-exist:0.1.0',
        image_source: 'host',
      },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { detail?: string };
    expect(body.detail ?? '').toContain('宿主上没有镜像');

    // 选择器里搜这个不存在的镜像：一个都没命中，弹层里给的是空态说明。
    await openImagePicker(page);
    await searchImage(page, 'sandbox-console-acceptance/does-not-exist:0.1.0');
    await expect(page.getByTestId('page-sandbox-create-image-no-match')).toBeVisible();
    await expect(page.getByTestId('page-sandbox-create-image-option')).toHaveCount(0);
    await expect(
      page.locator('[data-image-reference="sandbox-console-acceptance/does-not-exist:0.1.0"]'),
    ).toHaveCount(0);
  });
});

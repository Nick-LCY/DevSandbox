/**
 * 删除复验：按一期回收清单逐项核对平台资源已回收，
 * 并确认用户声明挂载的外部目录原样存在、内容未变。
 */

import { expect, test } from '@playwright/test';

import { getSandbox, reclaimPlan, type DeleteResultModel } from '../helpers/api';
import { authHeaders } from '../helpers/auth';
import {
  confirmDelete,
  fillCreateForm,
  gotoWorkbench,
  openCreateDialog,
  openDeleteDialog,
  selectCreatedSandbox,
  selectSandbox,
} from '../helpers/console';
import {
  daemonProcessesForUid,
  dirExists,
  hostContainerExists,
  platformMetadataExists,
  sandboxExec,
  subidEntryExists,
  userExists,
  userUid,
} from '../helpers/host';
import { createWorkspace, fingerprintDir, removeWorkspace } from '../helpers/workspace';

const SANDBOX_NAME = 'acc-reclaim';
const IMAGE = 'sandbox-platform/base:0.2.0';

test.describe('删除回收复验', () => {
  test('回收清单里的平台资源全部回收，用户挂载目录原样保留', async ({ page }) => {
    const workspace = createWorkspace('/workspace');
    const fingerprintBefore = fingerprintDir(workspace.path);

    try {
      // ── ① 建沙箱（带一条用户声明挂载）
      await openCreateDialog(page);
      await fillCreateForm(page, {
        name: SANDBOX_NAME,
        image: IMAGE,
        mountHost: workspace.path,
        mountContainer: workspace.containerPath,
        command: 'sleep infinity',
      });
      await selectCreatedSandbox(page, SANDBOX_NAME);
      await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();

      const detail = await getSandbox(SANDBOX_NAME);
      const systemUser = detail.system_user;
      const uid = userUid(systemUser);
      const containerName = detail.container_name;
      const networkName = detail.network_name;
      const home = detail.home;

      // ── ② 模拟 agent 事后自己起的依赖容器（删除前实时扫描必须能列出来）
      const dependency = `${containerName}-dep`;
      const runDep = sandboxExec(systemUser, uid, [
        'docker',
        'run',
        '-d',
        '--name',
        dependency,
        '--network',
        networkName,
        '--entrypoint',
        'sleep',
        IMAGE,
        'infinity',
      ]);
      expect(runDep.code, `依赖容器启动失败：${runDep.stderr}`).toBe(0);
      const depState = sandboxExec(systemUser, uid, [
        'docker',
        'inspect',
        '--format',
        '{{.State.Status}}',
        dependency,
      ]);
      expect(depState.stdout.trim()).toBe('running');

      // ── ③ 删除前的回收清单
      const plan = await reclaimPlan(SANDBOX_NAME);
      expect(plan.untouched_note).toBe('用户挂载的宿主机目录不受影响');
      expect(plan.user_mounts).toEqual([workspace.path]);
      expect(plan.incomplete).toBe(false);
      const planText = plan.items.join('\n');
      test.info().annotations.push({
        type: '回收清单',
        description: `${plan.items.length} 项：${plan.items.join('；')}`,
      });
      expect(planText).toContain(containerName);
      expect(planText).toContain(dependency);
      expect(planText).toContain(networkName);
      expect(planText).toContain(systemUser);
      expect(planText).toContain(home);
      expect(planText).toContain('平台元数据');

      // ── ④ 经工作台删除：侧栏选中 → 头部「删除」→ 弹窗里点一次确认
      await gotoWorkbench(page);
      await selectSandbox(page, SANDBOX_NAME);
      const dialog = await openDeleteDialog(page);
      await expect(page.getByTestId('page-sandbox-detail-delete-untouched-note')).toHaveText(
        '用户挂载的宿主机目录不受影响',
      );
      // 弹窗只说后果与「不受影响」：不再列回收清单。
      await expect(dialog).toContainText('此操作不可撤销');
      await expect(dialog).not.toContainText(containerName);
      await expect(dialog).not.toContainText(dependency);

      const deleted = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/sandboxes/${SANDBOX_NAME}`) &&
          response.request().method() === 'DELETE',
      );
      // 一次点确认即删除
      await confirmDelete(page);
      const response = await deleted;
      expect(response.status()).toBe(200);
      const result = (await response.json()) as DeleteResultModel;
      expect(result.existed).toBe(true);
      expect(result.failed, `有资源没回收干净：${result.failed.join('；')}`).toEqual([]);

      const removedText = result.removed.join('\n');
      expect(removedText).toContain(`容器 ${containerName}`);
      expect(removedText).toContain(`容器 ${dependency}`);
      expect(removedText).toContain(`网络 ${networkName}`);

      // ── ⑤ 逐项核对：平台资源都已回收
      expect(userExists(systemUser), `系统用户 ${systemUser} 还在`).toBe(false);
      expect(dirExists(home), `家目录 ${home} 还在`).toBe(false);
      expect(subidEntryExists(systemUser, 'uid'), '/etc/subuid 条目还在').toBe(false);
      expect(subidEntryExists(systemUser, 'gid'), '/etc/subgid 条目还在').toBe(false);
      expect(platformMetadataExists(SANDBOX_NAME), '平台元数据还在').toBe(false);
      expect(
        daemonProcessesForUid(uid),
        `uid ${uid} 名下还有守护进程：${daemonProcessesForUid(uid).join('；')}`,
      ).toEqual([]);
      // 沙箱容器在免 root 守护进程的私有命名空间里，宿主 root 守护进程里不该有同名容器
      expect(hostContainerExists(containerName), '宿主 root 守护进程里出现了沙箱容器').toBe(false);
      expect(hostContainerExists(dependency), '宿主 root 守护进程里出现了依赖容器').toBe(false);

      // ── ⑥ 用户声明挂载的外部目录原样存在、内容未变
      expect(dirExists(workspace.path), '用户挂载目录被删了').toBe(true);
      expect(fingerprintDir(workspace.path)).toBe(fingerprintBefore);
    } finally {
      removeWorkspace(workspace);
    }
  });

  test('重复删除同一沙箱是幂等的（返回不存在，不报错）', async ({ page }) => {
    const response = await page.request.delete(`/api/sandboxes/${SANDBOX_NAME}`, {
      // 直调接口要带令牌（后端对全部 `/api` 生效令牌认证）。
      headers: authHeaders(),
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as DeleteResultModel;
    expect(body.existed).toBe(false);
    expect(body.failed).toEqual([]);
  });
});

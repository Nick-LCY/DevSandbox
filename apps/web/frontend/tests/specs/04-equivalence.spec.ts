/**
 * 等价性复验：网页触发的沙箱操作与一期命令行对同一沙箱产生等价状态。
 *
 * 三层核对：
 * 一、同一沙箱，网页看到的与命令行看到的必须一致（列表字段、挂载清单）；
 * 二、同一沙箱，网页停 / 命令行启，两边看到的容器状态必须一致；
 * 三、同一沙箱，网页的回收清单与命令行的回收清单必须逐项一致。
 *
 * 另加一层：参数相同的两个沙箱（一个网页建、一个命令行建），
 * 挂载清单与状态流转必须等价。
 *
 * 三期起后端对全部 `/api` 生效令牌认证：**网页侧**的接口直调走
 * `helpers/api.ts`（统一带认证头），页面侧的令牌由套件的 storageState 预置
 * （`helpers/connection.ts`）；**命令行侧**走核心包、不经控制台 API，
 * 因此不涉及令牌（等价的另一半仍然是「没令牌时的老样子」）。
 */

import { expect, test } from '@playwright/test';

import { getSandbox, listSandboxes, reclaimPlan } from '../helpers/api';
import { sandboxctl, sandboxctlMetadata } from '../helpers/cli';
import {
  detailField,
  fillCreateForm,
  gotoDetail,
  gotoWorkbench,
  openCreateDialog,
  openStopDialog,
  confirmStop,
  selectCreatedSandbox,
} from '../helpers/console';
import { sandboxContainerState, sandboxExec, userUid } from '../helpers/host';
import { createWorkspace, removeWorkspace } from '../helpers/workspace';

const IMAGE = 'sandbox-platform/base:0.2.0';

interface CliMetadata {
  name: string;
  state: string;
  image: string;
  created_at: string;
  system_user: string;
  uid: number;
  home: string;
  container_name: string;
  network_name: string;
  subid_start: number;
  subid_length: number;
  socket_path: string;
  socket_mount_path: string;
  image_source: string;
  mounts: { host_path: string; container_path: string; read_only: boolean; role: string }[];
}

/** 取命令行的回收清单条目（只打印清单，不执行删除）。 */
function cliReclaimItems(name: string): string[] {
  // 非交互环境：命令行打印完清单后会因「必须显式加 --yes」而退出，不会真删
  const result = sandboxctl(['delete', name]);
  const lines = result.stdout.split('\n');
  const start = lines.findIndex((line) => line.includes('平台将回收以下资源'));
  if (start < 0) {
    throw new Error(`命令行没有打印回收清单：\n${result.output}`);
  }
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      break;
    }
    if (!trimmed.startsWith('- ')) {
      continue;
    }
    items.push(trimmed.slice(2).trim());
  }
  return items;
}

/** 状态码到中文标签（命令行 JSON 里只有 state，没有 state_label）。 */
const STATE_LABELS: Record<string, string> = { running: '运行中', stopped: '已停止' };

test.describe('网页与命令行的等价性', () => {
  test('同一沙箱：网页与命令行看到的列表字段、挂载清单、容器状态、回收清单都一致', async ({ page }) => {
    const name = 'acc-equiv';
    const workspace = createWorkspace('/workspace');
    try {
      // ── 网页建一个沙箱（带一条用户声明挂载）
      await openCreateDialog(page);
      await fillCreateForm(page, {
        name,
        image: IMAGE,
        mountHost: workspace.path,
        mountContainer: workspace.containerPath,
        command: 'sleep infinity',
      });
      await selectCreatedSandbox(page, name);
      await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();

      // ① 列表字段：网页（接口）与命令行逐字段一致
      const webList = (await listSandboxes()).find((item) => item.name === name);
      const cliList = sandboxctlMetadata(name) as unknown as CliMetadata;
      expect(webList).toBeTruthy();
      expect(cliList).toBeTruthy();
      expect(webList?.name).toBe(cliList.name);
      expect(webList?.state).toBe(cliList.state);
      expect(webList?.state_label).toBe(STATE_LABELS[cliList.state]);
      expect(webList?.image).toBe(cliList.image);
      expect(webList?.created_at).toBe(cliList.created_at);

      // 挂载清单：网页详情与命令行元数据逐项一致
      const webDetail = await getSandbox(name);
      const webMounts = webDetail.mounts.map((mount) => ({
        host_path: mount.host_path,
        container_path: mount.container_path,
        read_only: mount.read_only,
        role: mount.role,
      }));
      expect(webMounts).toEqual(cliList.mounts);
      expect(webMounts).toHaveLength(1);
      expect(webMounts[0].host_path).toBe(workspace.path);

      // ② 状态流转：网页停 → 命令行看到已停 → 命令行启 → 网页看到运行中
      const uid = userUid(webDetail.system_user);
      await openStopDialog(page);
      await confirmStop(page, name);
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('已停止');
      const cliAfterWebStop = sandboxctlMetadata(name) as unknown as CliMetadata;
      expect(cliAfterWebStop.state).toBe('stopped');
      expect(sandboxContainerState(webDetail.system_user, uid, webDetail.container_name)).toBe(
        'exited',
      );

      const cliStart = sandboxctl(['start', name]);
      expect(cliStart.code, cliStart.output).toBe(0);
      await page.getByTestId('page-sandbox-detail-refresh-button').click();
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
      const cliAfterCliStart = sandboxctlMetadata(name) as unknown as CliMetadata;
      expect(cliAfterCliStart.state).toBe('running');
      expect(sandboxContainerState(webDetail.system_user, uid, webDetail.container_name)).toBe(
        'running',
      );
      // 网页与命令行此刻看到的字段仍然一致
      const webListNow = (await listSandboxes()).find((item) => item.name === name);
      expect(webListNow?.state).toBe(cliAfterCliStart.state);
      expect(webListNow?.image).toBe(cliAfterCliStart.image);

      // ③ 回收清单：网页接口与命令行逐项一致（同一个沙箱，应当一字不差）
      const webPlan = await reclaimPlan(name);
      const cliPlan = cliReclaimItems(name);
      expect(cliPlan.length).toBeGreaterThan(0);
      expect(webPlan.items).toEqual(cliPlan);
      expect(webPlan.untouched_note).toBe('用户挂载的宿主机目录不受影响');
      expect(webPlan.user_mounts).toEqual([workspace.path]);
      // 清单只是预览：沙箱还在
      expect(sandboxctlMetadata(name)).toBeTruthy();
    } finally {
      removeWorkspace(workspace);
    }
  });

  test('参数相同的两个沙箱（网页建 / 命令行建）挂载与状态流转等价', async ({ page }) => {
    const webName = 'acc-webeq';
    const cliName = 'acc-clieq';
    const workspace = createWorkspace('/workspace');
    try {
      // 网页建
      await openCreateDialog(page);
      await fillCreateForm(page, {
        name: webName,
        image: IMAGE,
        mountHost: workspace.path,
        mountContainer: workspace.containerPath,
        command: 'sleep infinity',
      });
      await selectCreatedSandbox(page, webName);
      await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();

      // 命令行建（同样的镜像、同样的挂载、同样的启动命令）
      const cliCreate = sandboxctl([
        'create',
        cliName,
        '--image',
        IMAGE,
        '--command',
        'sleep infinity',
        '--mount',
        `${workspace.path}:${workspace.containerPath}`,
      ]);
      expect(cliCreate.code, cliCreate.output).toBe(0);

      const webDetail = await getSandbox(webName);
      const cliDetail = sandboxctlMetadata(cliName) as unknown as CliMetadata;

      // 列表字段：除名字与创建时间外完全一致
      const webList = (await listSandboxes()).find((item) => item.name === webName);
      const cliList = (await listSandboxes()).find((item) => item.name === cliName);
      expect(webList?.state).toBe(cliList?.state);
      expect(webList?.state_label).toBe(cliList?.state_label);
      expect(webList?.image).toBe(cliList?.image);
      expect(webList?.created_at).not.toBe(cliList?.created_at);

      // 挂载清单完全一致
      expect(webDetail.mounts.map((mount) => mount.host_path)).toEqual(
        cliDetail.mounts.map((mount) => mount.host_path),
      );
      expect(webDetail.mounts.map((mount) => mount.container_path)).toEqual(
        cliDetail.mounts.map((mount) => mount.container_path),
      );
      expect(webDetail.mounts.map((mount) => mount.read_only)).toEqual(
        cliDetail.mounts.map((mount) => mount.read_only),
      );

      // 容器名、网络名、子 ID 段长度等派生字段按同一规则生成
      expect(webDetail.container_name).toBe(`sandbox-${webName}`);
      expect(cliDetail.container_name).toBe(`sandbox-${cliName}`);
      expect(webDetail.network_name).toBe(`${webName}-net`);
      expect(cliDetail.network_name).toBe(`${cliName}-net`);
      expect(webDetail.subid_length).toBe(cliDetail.subid_length);

      // 两个沙箱里跑起来的是同一个镜像（同一个镜像 ID）：网页与命令行两条路都落到宿主注入
      const webImageId = sandboxExec(webDetail.system_user, webDetail.uid, [
        'docker',
        'image',
        'inspect',
        IMAGE,
        '--format',
        '{{.Id}}',
      ]);
      const cliImageId = sandboxExec(cliDetail.system_user, cliDetail.uid, [
        'docker',
        'image',
        'inspect',
        IMAGE,
        '--format',
        '{{.Id}}',
      ]);
      expect(webImageId.stdout.trim()).not.toBe('');
      expect(webImageId.stdout.trim()).toBe(cliImageId.stdout.trim());
      test.info().annotations.push({
        type: '镜像来源口径',
        description: `网页建 image_source=${webDetail.image_source}；命令行建 image_source=${cliDetail.image_source}（命令行不传该字段，保持一期行为）；两边的镜像 ID 相同：${webImageId.stdout.trim().slice(7, 19)}`,
      });

      // 状态流转等价：网页停 → 命令行起 → 两者都回到运行中
      await openStopDialog(page);
      await confirmStop(page, webName);
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('已停止');
      expect((sandboxctlMetadata(webName) as unknown as CliMetadata).state).toBe('stopped');

      const cliStart = sandboxctl(['start', webName]);
      expect(cliStart.code, cliStart.output).toBe(0);
      // 绕一圈回到详情页：确认页面重新拉取后看到的是命令行启动后的状态
      await gotoWorkbench(page);
      await gotoDetail(page, webName);
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
      expect((sandboxctlMetadata(webName) as unknown as CliMetadata).state).toBe('running');

      // 网页展示的字段与命令行一致
      expect(await detailField(page, 'system-user')).toBe(
        (sandboxctlMetadata(webName) as unknown as CliMetadata).system_user,
      );
    } finally {
      removeWorkspace(workspace);
    }
  });
});

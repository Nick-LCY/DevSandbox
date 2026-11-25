/**
 * web 形态的端口转发区验收（三期）。
 *
 * **Playwright 就是 web 形态**：浏览器里没有 Tauri 注入的
 * `window.__TAURI_INTERNALS__`，前端据此判定「不是桌面形态」
 * （`src/lib/connection.ts` 的 `isDesktopRuntime`）——所以本文件验的
 * 正是产品上 **web 形态**的那条分支（端口转发是两种形态唯一能端到端
 * 验到的形态：桌面形态的完整管理要 Tauri IPC，网页上验不了）。
 *
 * 钉的行为（决策 C，口径见 `apps/web/frontend/README.md`「端口转发」节）：
 * 一、端口转发区**只有一张说明卡 + 一个「安装桌面端」链接**；
 * 二、说明卡写明「网页形态无法管理端口转发，请使用桌面端」；
 * 三、「安装桌面端」是指向 GitHub Releases 的新标签链接；
 * 四、**零管理元素**：表格 / 行 / 新建表单 / 「转发」按钮一个都不渲染
 *    （web 形态给了管理能力就等于给出「建了却连不上」的半截功能——
 *    本机端口的监听由桌面端持有）；
 * 五、web 形态**连转发记录都不读**（面板不渲染行就没有读它的理由，
 *    读取在工作台层且仅桌面形态执行）。
 *
 * 口径来源：
 * - 形态差异：`apps/web/frontend/src/components/workbench/PortForwardPanel.tsx`
 *   的 web 分支（`if (!desktop)`）；
 * - 标识：`apps/web/frontend/README.md` 的标识表（`page-forward-*`），不另造名字；
 * - 决策：ADR 0014（端口转发机制选型）、ADR 0015（桌面壳与连接配置抽象）。
 *
 * 三期起后端对全部 `/api` 生效令牌认证：接口直调走 `helpers/api.ts`
 * （统一带认证头），页面侧的令牌由套件的 storageState 预置
 * （`helpers/connection.ts`）——用例本身不感知令牌，页面一打开就在工作台里。
 */

import { expect, test } from '@playwright/test';

import { createSandbox, listSandboxes } from '../helpers/api';
import { gotoDetail, openDetailDialog } from '../helpers/console';
import { readFixtures } from '../helpers/sandbox';

/** 验收沙箱名（收尾清理只碰 `acc-` 前缀，不动别人的沙箱）。 */
const SANDBOX_NAME = 'acc-fwdweb';
/** 平台基础镜像：宿主已构建，属平台自建镜像，宿主导出注入即可。 */
const IMAGE = 'sandbox-platform/base:0.2.0';
/** 工作台的合并轮询周期（与前端 `Workbench.tsx` 的 DETAIL_POLL_INTERVAL 对齐）。 */
const POLL_INTERVAL_MS = 10_000;

test.describe('web 形态的端口转发区', () => {
  test.beforeAll(async () => {
    readFixtures();
    // 用例失败后 worker 会重启，beforeAll 会重跑：建沙箱必须幂等
    const existing = (await listSandboxes()).find((item) => item.name === SANDBOX_NAME);
    if (!existing) {
      await createSandbox({
        name: SANDBOX_NAME,
        image: IMAGE,
        command: 'sleep infinity',
      });
    }
  });

  test('只有说明卡与安装入口：管理元素一个都没有，转发记录也不读', async ({ page }) => {
    // 转发接口的请求清单：**web 形态不该读转发记录**（计数要在动作之前挂上）。
    const forwardRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/forwards')) {
        forwardRequests.push(request.url());
      }
    });

    await gotoDetail(page, SANDBOX_NAME);
    await openDetailDialog(page);

    // ── ① 说明卡在，文案说清「网页形态无法管理端口转发」
    const notice = page.getByTestId('page-forward-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('网页形态无法管理端口转发');
    await expect(notice).toContainText('桌面端');

    // ── ② 「安装桌面端」链接在（唯一的入口）
    await expect(page.getByTestId('page-forward-install-button')).toBeVisible();

    // ── ③ 零管理元素：桌面形态的整块管理区不渲染
    await expect(page.getByTestId('page-forward-panel')).toHaveCount(0);
    // 表格 / 行 / 新建表单 / 「转发」按钮一个都不在（queryByTestId 为 null）。
    await expect(page.getByTestId('page-forward-table')).toHaveCount(0);
    await expect(page.getByTestId('page-forward-row')).toHaveCount(0);
    await expect(page.getByTestId('page-forward-create-container-port-input')).toHaveCount(0);
    await expect(page.getByTestId('page-forward-create-local-port-input')).toHaveCount(0);
    await expect(page.getByTestId('page-forward-create-submit-button')).toHaveCount(0);

    // ── ④ 跨过一个合并轮询周期：web 形态**连转发记录都不读**
    //    （开抽屉那一拍会立刻合并刷一次，之后每 10 秒一拍；两端都不该发转发请求）
    await page.waitForTimeout(POLL_INTERVAL_MS + 2_000);
    expect(forwardRequests, 'web 形态不该请求转发记录').toEqual([]);
  });

  test('「安装桌面端」是 GitHub Releases 的新标签链接', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);
    await openDetailDialog(page);
    await expect(page.getByTestId('page-forward-notice')).toBeVisible();

    const link = page.getByTestId('page-forward-install-button');
    await expect(link).toHaveRole('link');
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/Nick-LCY/DevSandbox/releases',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

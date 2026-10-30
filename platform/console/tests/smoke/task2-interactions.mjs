/**
 * 任务二交互冒烟：路由、弹窗、两步确认、主题切换、标签关闭确认。
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'artifacts', 'task2-smoke');
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8123';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', (err) => problems.push(String(err)));

// ── 侧栏点选 → 路由与工作区跟着走
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="page-sandbox-detail-empty"]');
await page.getByTestId('page-sandbox-list-item').filter({ hasText: 'base-2' }).click();
await page.waitForSelector('[data-testid="page-sandbox-detail-title"]');
console.log('route-after-select:', new URL(page.url()).hash);
console.log('header-title:', await page.getByTestId('page-sandbox-detail-title').textContent());

// ── 终端标签：点 × 弹确认（运行中 → 关闭并移除），取消不发请求
await page.getByTestId('page-sandbox-detail-terminal-new-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-terminal-tab"]', { timeout: 30000 });
const tab = page.locator('[data-testid="page-sandbox-detail-terminal-tab"]').last();
const sessionId = await tab.getAttribute('data-session-id');
await tab.getByTestId('page-sandbox-detail-terminal-tab-close').click();
const closeDialog = page.getByTestId('page-sandbox-detail-terminal-remove-confirm');
await closeDialog.waitFor();
console.log('close-dialog-title:', await closeDialog.locator('h2').textContent());
console.log('close-dialog-button:', await page.getByTestId('page-sandbox-detail-terminal-remove-confirm-button').textContent());
await page.getByTestId('page-sandbox-detail-terminal-remove-cancel-button').click();
await closeDialog.waitFor({ state: 'detached' });

// ── 深链接：路由带会话标识 → 该标签直接是选中态
await page.goto(`${BASE}/#/sandboxes/base-2/${sessionId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="page-sandbox-detail-terminal-tab"]', { timeout: 30000 });
const deepTab = page.locator(`[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`);
await deepTab.waitFor();
console.log('deep-link-tab-active:', await deepTab.getAttribute('data-active'));

// ── 删除弹窗：Esc 可关；两步确认 5 秒后自动解除武装
await page.getByTestId('page-sandbox-detail-delete-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-delete-dialog"]');
await page.keyboard.press('Escape');
await page.waitForSelector('[data-testid="page-sandbox-detail-delete-dialog"]', { state: 'detached' });
console.log('delete-dialog-esc-close: ok');

await page.getByTestId('page-sandbox-detail-delete-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-delete-dialog"]');
await page.getByTestId('page-sandbox-detail-delete-confirm-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-delete-armed-hint"]');
console.log('armed-button-text:', await page.getByTestId('page-sandbox-detail-delete-confirm-button').textContent());
await page.waitForTimeout(6000);
console.log('armed-hint-after-6s:', await page.getByTestId('page-sandbox-detail-delete-armed-hint').count());
console.log('button-after-6s:', await page.getByTestId('page-sandbox-detail-delete-confirm-button').textContent());
await page.getByTestId('page-sandbox-detail-delete-cancel-button').click();

// ── 主题切换按钮
await page.getByTestId('page-layout-theme-toggle').click();
await page.waitForTimeout(300);
console.log('theme-after-toggle:', await page.evaluate(() => document.documentElement.dataset.theme));

// ── 代理设置弹窗能开
await page.getByTestId('page-layout-proxy-button').click();
await page.waitForSelector('[data-testid="page-settings-dialog"]');
console.log('proxy-dialog: ok');
await page.keyboard.press('Escape');

console.log('page-errors:', JSON.stringify(problems));
await browser.close();

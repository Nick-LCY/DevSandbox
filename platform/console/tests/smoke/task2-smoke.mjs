/**
 * 任务二浏览器冒烟：亮 / 暗两主题下截图核对工作台观感。
 *
 * 跑法（后端已起在 8123 端口并托管 dist）：
 *   cd platform/console && node tests/smoke/task2-smoke.mjs
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'artifacts', 'task2-smoke');
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8123';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    errors.push(msg.text());
  }
});
page.on('pageerror', (err) => errors.push(String(err)));

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('shot:', name);
}

async function setTheme(theme) {
  await page.evaluate((value) => {
    window.localStorage.setItem('sandbox-console-theme', value);
  }, theme);
  await page.reload({ waitUntil: 'networkidle' });
}

// ── 亮色：工作台（选中沙箱）
await page.goto(`${BASE}/#/sandboxes/base-1`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="page-sandbox-detail-title"]');
await setTheme('light');
await page.waitForSelector('[data-testid="page-sandbox-list-item"]');
await shot('01-light-workbench');

// 选中态：只有背景高亮，没有左侧竖线
const selected = page.locator('[data-testid="page-sandbox-list-item"]').first();
const box = await selected.boundingBox();
const style = await selected.evaluate((el) => {
  const cs = getComputedStyle(el);
  return {
    background: cs.backgroundColor,
    boxShadow: cs.boxShadow,
    borderLeft: cs.borderLeftWidth,
  };
});
console.log('selected-item-style:', JSON.stringify({ box, ...style }));

// ── 亮色：弹窗
await page.getByTestId('page-sandbox-list-create-button').first().click();
await page.waitForSelector('[data-testid="page-sandbox-create-dialog"]');
await shot('02-light-create-dialog');
await page.keyboard.press('Escape');

await page.getByTestId('page-sandbox-detail-detail-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-dialog"]');
await shot('03-light-detail-dialog');
await page.keyboard.press('Escape');

await page.getByTestId('page-layout-proxy-button').click();
await page.waitForSelector('[data-testid="page-settings-dialog"]');
await shot('04-light-proxy-dialog');
await page.keyboard.press('Escape');

await page.getByTestId('page-sandbox-detail-delete-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-delete-dialog"]');
await page.getByTestId('page-sandbox-detail-delete-confirm-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-delete-armed-hint"]');
await shot('05-light-delete-dialog-armed');
await page.getByTestId('page-sandbox-detail-delete-cancel-button').click();

// ── 亮色：终端会话
await page.getByTestId('page-sandbox-detail-terminal-new-button').click();
await page.waitForSelector('[data-testid="page-sandbox-detail-terminal-tab"]', { timeout: 30000 });
await page.waitForTimeout(3000);
await shot('06-light-terminal');
const surface = page.locator('[data-testid="page-sandbox-detail-terminal-surface"]');
const surfaceStyle = await surface.evaluate((el) => {
  const cs = getComputedStyle(el);
  return { background: cs.backgroundColor, color: cs.color };
});
console.log('terminal-surface-style:', JSON.stringify(surfaceStyle));

// ── 暗色
await setTheme('dark');
await page.waitForSelector('[data-testid="page-sandbox-detail-terminal-tab"]');
await shot('07-dark-workbench');
await shot('08-dark-terminal');
const darkSurface = await page
  .locator('[data-testid="page-sandbox-detail-terminal-surface"]')
  .evaluate((el) => {
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, color: cs.color };
  });
console.log('dark-terminal-surface-style:', JSON.stringify(darkSurface));

await page.getByTestId('page-sandbox-list-create-button').first().click();
await page.waitForSelector('[data-testid="page-sandbox-create-dialog"]');
await shot('09-dark-create-dialog');
await page.keyboard.press('Escape');

// ── 空态
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="page-sandbox-detail-empty"]');
await shot('10-dark-empty-state');
await setTheme('light');
await page.waitForSelector('[data-testid="page-sandbox-detail-empty"]');
await shot('11-light-empty-state');

console.log('console-errors:', JSON.stringify(errors));
await browser.close();

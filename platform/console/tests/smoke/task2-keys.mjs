/**
 * 终端快捷键拦截冒烟：
 * - Ctrl+C 必须能到 pty（打断容器里跑着的进程）；
 * - 浏览器保留键（Ctrl+N / Ctrl+S）不拦（defaultPrevented 为 false）；
 * - 其余带 Ctrl/Meta/Alt 的组合一律拦下（defaultPrevented 为 true）。
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'artifacts', 'task2-smoke');
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8123';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/#/sandboxes/base-1`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="page-sandbox-detail-terminal-tab"]', { timeout: 30000 });

const surface = page.locator('[data-testid="page-sandbox-detail-terminal-surface"]').first();
await surface.click();
const textarea = surface.locator('textarea').first();
await textarea.focus();

// ── Ctrl+C 必须到 pty：打断 sleep 之后提示符立刻回来
await page.keyboard.type('sleep 120');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
await page.keyboard.press('Control+c');
await page.waitForTimeout(1200);

const rows = surface.locator('.xterm-rows');
const text = (await rows.textContent()) ?? '';
const interrupted = /sleep 120[\s\S]*#/.test(text) || /\^C/.test(text);
console.log('ctrl-c-reached-pty:', interrupted);
console.log('terminal-tail:', JSON.stringify(text.slice(-160)));

// ── 快捷键拦截口径
const probe = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="page-sandbox-detail-terminal-surface"] textarea');
  if (!el) {
    return null;
  }
  const check = (init) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return {
    ctrlN: check({ key: 'n', code: 'KeyN', ctrlKey: true }),
    ctrlShiftN: check({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }),
    ctrlS: check({ key: 's', code: 'KeyS', ctrlKey: true }),
    ctrlP: check({ key: 'p', code: 'KeyP', ctrlKey: true }),
    ctrlT: check({ key: 't', code: 'KeyT', ctrlKey: true }),
    ctrlW: check({ key: 'w', code: 'KeyW', ctrlKey: true }),
    ctrlQ: check({ key: 'q', code: 'KeyQ', ctrlKey: true }),
    ctrlTab: check({ key: 'Tab', code: 'Tab', ctrlKey: true }),
    f5: check({ key: 'F5', code: 'F5' }),
    f11: check({ key: 'F11', code: 'F11' }),
    f12: check({ key: 'F12', code: 'F12' }),
    altF4: check({ key: 'F4', code: 'F4', altKey: true }),
    ctrlA: check({ key: 'a', code: 'KeyA', ctrlKey: true }),
    ctrlC: check({ key: 'c', code: 'KeyC', ctrlKey: true }),
    metaA: check({ key: 'a', code: 'KeyA', metaKey: true }),
    altB: check({ key: 'b', code: 'KeyB', altKey: true }),
    plainA: check({ key: 'a', code: 'KeyA' }),
  };
});
console.log('shortcut-probe:', JSON.stringify(probe, null, 2));

await browser.close();

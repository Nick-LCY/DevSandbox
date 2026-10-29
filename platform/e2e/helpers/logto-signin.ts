/**
 * Logto 登录页交互helper。
 *
 * 为什么这里不用 data-testid：
 *   Logto 的登录页是第三方页面，我们控制不了它的 DOM，没法加 data-testid。
 *   平台约定的「唯一定位入口是 getByTestId()」针对的是**被测应用自己的页面**；
 *   第三方页面的定位集中在这一个文件里，由契约断言脚本显式豁免并公示，
 *   便于审计（见 tools/assert-testid-only.sh 的 THIRD_PARTY_ALLOWLIST）。
 */

import type { Page } from '@playwright/test';

/** Logto 登录页的用户名输入框（Logto 用 identifier 命名）。 */
const IDENTIFIER_INPUT = 'input[name="identifier"]';
/** Logto 登录页的口令输入框。 */
const PASSWORD_INPUT = 'input[name="password"]';
/** Logto 登录页的提交按钮。 */
const SUBMIT_BUTTON = 'button[type="submit"]';

/**
 * 在 Logto 真实登录页上完成登录。
 *
 * 流程：等登录页出现 → 填用户名与口令 → 提交 → 等回调落地。
 *
 * 说明：示例应用只申请 openid profile email 三个基础权限，
 * Logto 默认的登录体验不会多问一次授权同意，因此这里不做同意页处理。
 */
export async function signInWithLogto(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.waitForSelector(IDENTIFIER_INPUT, { state: 'visible', timeout: 45_000 });
  await page.fill(IDENTIFIER_INPUT, username);
  await page.fill(PASSWORD_INPUT, password);
  await page.click(SUBMIT_BUTTON);

  // 登录完成后 Logto 会 302 回应用的回调地址。
  await page.waitForURL(/\/auth\/callback/, { timeout: 45_000 });
}

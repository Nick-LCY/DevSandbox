/**
 * 验收用的访问令牌。
 *
 * 三期起后端对**全部 `/api`** 生效令牌认证（契约见 `apps/web/backend/API.md`
 * 第 14 章）：请求头 `Authorization: Bearer <令牌>`，失败回 401
 * `{"detail": "访问令牌无效或缺失"}`。
 *
 * 验收链路上有三处要用令牌，口径必须一致，所以令牌只在这里定义一次
 * （**单一来源**）：
 * 1. **后端进程**：`helpers/server.ts` 启动时用环境变量 `SANDBOX_CONSOLE_TOKEN`
 *    注入这份固定令牌（注入优先 = **后端不落盘**令牌文件：不写平台数据根下的
 *    `console-token.json`）；
 * 2. **脚本直调**：`helpers/api.ts` 与用例里的 `page.request.*` 都带
 *    `Authorization` 头；
 * 3. **页面侧**：`helpers/connection.ts` 把同一份令牌预置进 localStorage 的
 *    连接配置里，页面一打开就是「已配置」态。
 *
 * 「不落盘」的准确口径：**指后端那个令牌文件**（`console-token.json`），不是
 * 「磁盘上没有令牌」——验收侧的 `.runtime/storage-state.json` 里确实带着这份
 * 固定令牌（页面预置要用它），该目录已被 `.gitignore` 忽略（只在本机验收环境
 * 里存在，不进版本库）。
 *
 * 令牌值是**固定的常量**（不是每次运行随机生成）：页面预置、服务进程注入、
 * 直调请求头三处要在同一次运行里对上，随机值就得在运行期传递；
 * 固定值只在本机验收环境里用，不是任何环境的真实凭据，
 * **禁止把它复制到任何真实部署**（真部署走自己的令牌文件 / 环境变量注入）。
 */

/** 验收用的固定访问令牌。 */
export const TEST_TOKEN = 'sbx_acc_acceptance_test_token_20261104';

/** 令牌注入用的环境变量名（与后端 `sandbox_console.auth.TOKEN_ENV_VAR` 对齐）。 */
export const TOKEN_ENV_VAR = 'SANDBOX_CONSOLE_TOKEN';

/**
 * 认证失败的固定文案（后端 `AUTH_FAILED_DETAIL`）。
 *
 * 这是**后端常量的契约副本**：验收脚本是独立的 TypeScript 工程，跑在 Node
 * 侧，跟后端的 Python 虚拟环境不沾边，没有「import 后端常量」这条路
 * （后端常量在 `sandbox_console.auth` 里，是 Python 侧的模块级常量）。
 * 这里**故意不 import**：文案的真源在后端，两侧各留一份、靠
 * `apps/web/backend/API.md` 第 14 章对齐；后端改了文案，这条断言会红——
 * 那正是要看的信号（契约漂移），不是要去「自动同步」的噪音。
 */
export const AUTH_FAILED_DETAIL = '访问令牌无效或缺失';

/** 带认证头的请求头（直调接口用）。 */
export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

/** 带指定令牌的请求头（错令牌等负向用例用）。 */
export function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

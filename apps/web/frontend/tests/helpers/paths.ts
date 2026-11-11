/**
 * 路径常量。
 *
 * 验收脚本落在 `apps/web/frontend/tests/`，向上依次是前端目录、web 目录、
 * 应用工作区根（apps）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/** 网页控制台前端目录（apps/web/frontend）。 */
export const CONSOLE_DIR = path.resolve(TESTS_DIR, '..');
/** web 目录（apps/web）：前端与后端同级。 */
export const WEB_DIR = path.resolve(CONSOLE_DIR, '..');
/** 应用工作区根（apps）：核心包、服务端包、命令行都在这下面。 */
export const APPS_DIR = path.resolve(WEB_DIR, '..');

/** 运行产物：截图、trace、报告。 */
export const ARTIFACTS_DIR = path.join(TESTS_DIR, 'artifacts');
/** 运行期状态：服务进程信息、临时工作目录。 */
export const RUNTIME_DIR = path.join(TESTS_DIR, '.runtime');
/**
 * 预置连接配置的 storageState 文件。
 *
 * `global-setup.ts` 按测试服务的实际端口写它，`playwright.config.ts` 的
 * `use.storageState` 读它——页面一打开就是「已配置」态（口径见
 * `helpers/connection.ts`）。
 */
export const STORAGE_STATE_FILE = path.join(RUNTIME_DIR, 'storage-state.json');

/** 命令行入口（apps/cli/sandboxctl.py，单文件薄壳）。 */
export const CLI_PATH = path.join(APPS_DIR, 'cli', 'sandboxctl.py');
/** 核心包所在的 uv 项目（apps/core）：命令行用它的环境跑。 */
export const CORE_PROJECT_DIR = path.join(APPS_DIR, 'core');
/** 服务端所在的 uv 项目（apps/web/backend）：控制台服务用它起。 */
export const BACKEND_PROJECT_DIR = path.join(WEB_DIR, 'backend');
/** 前端构建产物目录（由独立静态源伺服它，见 `helpers/static.ts`）。 */
export const CONSOLE_DIST_DIR = path.join(CONSOLE_DIR, 'dist');

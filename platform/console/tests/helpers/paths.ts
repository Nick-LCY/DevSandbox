/**
 * 路径常量。
 *
 * 验收脚本落在 `platform/console/tests/`，向上依次是前端目录、平台目录、仓库根。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CONSOLE_DIR = path.resolve(TESTS_DIR, '..');
export const PLATFORM_DIR = path.resolve(CONSOLE_DIR, '..');
export const REPO_DIR = path.resolve(PLATFORM_DIR, '..');

/** 运行产物：截图、trace、报告。 */
export const ARTIFACTS_DIR = path.join(TESTS_DIR, 'artifacts');
/** 运行期状态：服务进程信息、临时工作目录。 */
export const RUNTIME_DIR = path.join(TESTS_DIR, '.runtime');

/** 一期命令行入口。 */
export const CLI_PATH = path.join(PLATFORM_DIR, 'cli', 'sandboxctl.py');
/** 平台包所在目录（`uv run` 的项目根）。 */
export const PLATFORM_PYPROJECT = PLATFORM_DIR;

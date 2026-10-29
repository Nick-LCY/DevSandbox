/**
 * 端到端测试基建 —— 配置装载。
 *
 * 依赖清单数据驱动：默认读 `config/dependencies.json`，
 * 也可用环境变量 `E2E_DEPENDENCIES_FILE` 指向别的清单文件。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 单个依赖的健康判据类型。 */
export type DependencyType = 'postgres' | 'http';

/** 一个依赖的声明。 */
export interface DependencySpec {
  /** 依赖名：失败时必须打印它。 */
  name: string;
  /** 判据类型。 */
  type: DependencyType;
  /** 连接串：一律用容器名寻址，不用本机回环地址。 */
  url: string;
  /** 环境变量名：存在时优先于 `url`，用于临时改指向。 */
  urlEnv?: string;
  /** 人类可读判据描述：失败时必须打印它。 */
  criterion: string;
  /** 超时上限（秒），不得超过 120。 */
  timeoutSeconds: number;
  /** HTTP 判据：响应体必须包含的片段。 */
  bodyIncludes?: string;
}

/** 依赖清单文件结构。 */
export interface DependencyManifest {
  dependencies: DependencySpec[];
}

/** 规定的单依赖等待超时上限（秒）。 */
export const MAX_DEPENDENCY_TIMEOUT_SECONDS = 120;

/** 模板库名：用例库由它克隆而来。 */
export function templateDatabase(): string {
  return process.env.E2E_TEMPLATE_DB ?? 'e2e_template';
}

/** 用例库名前缀（并行隔离与残留清理都按它识别）。 */
export function testDatabasePrefix(): string {
  return process.env.E2E_TEST_DB_PREFIX ?? 'e2e_test_';
}

/** 基建根目录：优先环境变量，其次向上找 `playwright.config.ts`。 */
export function e2eRoot(): string {
  const fromEnv = process.env.E2E_ROOT_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, 'playwright.config.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** 产物目录（截图、trace、报告），落在用户声明挂载的代码目录内。 */
export function artifactsDir(): string {
  return path.join(e2eRoot(), 'artifacts');
}

/** 读依赖清单并做校验。 */
export function loadDependencies(): DependencySpec[] {
  const explicit = process.env.E2E_DEPENDENCIES_FILE;
  const file = explicit
    ? path.resolve(e2eRoot(), explicit)
    : path.join(e2eRoot(), 'config', 'dependencies.json');
  if (!fs.existsSync(file)) {
    throw new Error(`依赖清单文件不存在：${file}`);
  }
  let manifest: DependencyManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as DependencyManifest;
  } catch (error) {
    throw new Error(`依赖清单文件解析失败：${file}（${(error as Error).message}）`);
  }
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length === 0) {
    throw new Error(`依赖清单为空：${file}`);
  }
  for (const dep of manifest.dependencies) {
    if (!dep.name) throw new Error(`依赖清单存在无名依赖：${file}`);
    if (dep.timeoutSeconds > MAX_DEPENDENCY_TIMEOUT_SECONDS) {
      throw new Error(
        `依赖 ${dep.name} 的超时上限 ${dep.timeoutSeconds} 秒超过规定的 ${MAX_DEPENDENCY_TIMEOUT_SECONDS} 秒`,
      );
    }
  }
  return manifest.dependencies.map((dep) => {
    const override = dep.urlEnv ? process.env[dep.urlEnv] : undefined;
    return { ...dep, url: override && override.length > 0 ? override : dep.url };
  });
}

/** 找 postgres 依赖（迁移、种子、模板库都走它）。 */
export function postgresDependency(dependencies: DependencySpec[]): DependencySpec {
  const dep = dependencies.find((item) => item.type === 'postgres');
  if (!dep) throw new Error('依赖清单里没有 postgres 依赖，无法执行迁移与种子');
  return dep;
}

/** 把连接串里的库名换成另一个（连接串其余部分保持不变）。 */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** 用例库连接串：以 postgres 依赖的连接串为底，换库名。 */
export function databaseUrl(dependencies: DependencySpec[], database: string): string {
  return withDatabase(postgresDependency(dependencies).url, database);
}

/** 管理连接串（连到 postgres 库本身，用于建库删库）。 */
export function adminUrl(dependencies: DependencySpec[]): string {
  return databaseUrl(dependencies, 'postgres');
}

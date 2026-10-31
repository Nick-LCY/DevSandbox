/**
 * 启动模板的纯逻辑：占位符替换、挂载解析、表单合并与反向收集。
 *
 * 模板是一份「沙箱启动配置」：镜像、挂载声明、启动命令、工作目录、
 * 环境变量、网桥网络。核心口径有两条，落地都在本文件里：
 *
 * - **合并语义**：模板里**出现**的字段整体替换表单值（挂载是整组替换，
 *   不是逐条并入；环境变量也是整组替换），**缺失**的字段保持表单现状。
 *   「出现」用 `hasOwnProperty` 判断——`{"image": null}`（填了空值）与
 *   缺 image 字段（没填过）是两回事，不能混同。
 * - **`{name}` 占位符**：模板配置的任意字符串位置都可以写 `{name}`，
 *   加载模板时替换成当前沙箱名；**沙箱名为空时保留占位符原样**
 *   （替换成空串会把配置改写成不可用的形态）。
 *
 * 本文件不碰网络与界面：数据进、结果出，方便单测。
 */

/** 沙箱名占位符。 */
export const NAME_PLACEHOLDER = '{name}';

/**
 * 模板配置体（六项全选填）。
 *
 * 字段可以整个不出现（用户没填过），也可以出现且取值为空
 * （用户填了空值）：两种语义在合并时不一样。
 */
export interface TemplateConfig {
  image?: string | null;
  mounts?: string[];
  command?: string | null;
  workdir?: string | null;
  env?: Record<string, string>;
  network?: string | null;
}

/** 模板里的一条挂载声明解析出来的表格行。 */
export interface TemplateMountRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

/**
 * 新建沙箱抽屉的表单状态（模板合并的落点）。
 *
 * 与界面上的表单一一对应：镜像、挂载行、启动命令、工作目录、
 * 环境变量、网桥网络。环境变量在这里是字典（不是多行文本），
 * 文本与字典之间的来回转换在 `lib/env.ts` 里做。
 */
export interface TemplateFormState {
  image: string;
  mounts: TemplateMountRow[];
  command: string;
  workdir: string;
  env: Record<string, string>;
  network: string | null;
}

/** 宽松解析挂载声明的结果。 */
export interface ParsedTemplateMounts {
  /** 解析成功的挂载行（按声明顺序）。 */
  rows: TemplateMountRow[];
  /** 解析不了、一条都没采用的声明条数。 */
  skipped: number;
}

/** 应用模板后的结果。 */
export interface ApplyTemplateResult {
  /** 合并后的表单状态。 */
  form: TemplateFormState;
  /** 模板里解析不了的挂载声明条数（已跳过）。 */
  skippedDeclarations: number;
}

/** 判断字段在配置里「出现」了没有（区分缺失与空值）。 */
function has(config: TemplateConfig, field: keyof TemplateConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config, field);
}

/**
 * 把文本里的 `{name}` 替换成沙箱名。
 *
 * 沙箱名为空时**保留占位符原样**：替换成空串会让挂载路径、命令一类
 * 配置变成不可用的形态（例如宿主路径直接变成 `/data/`）。
 */
export function substituteNamePlaceholder(text: string, sandboxName: string): string {
  if (sandboxName === '') {
    return text;
  }
  return text.split(NAME_PLACEHOLDER).join(sandboxName);
}

/**
 * 宿主路径是否是「可以拿去用」的形态。
 *
 * 绝对路径（`/data/x`）与家目录写法（`~`、`~/data/x`）都算；
 * `~other`（别人的家目录）不算——后端不展开它，核心包也会当非法路径拒掉。
 */
function isUsableHostPath(hostPath: string): boolean {
  return (
    hostPath.startsWith('/') || hostPath === '~' || hostPath.startsWith('~/')
  );
}

/**
 * 宽松解析模板里的挂载声明：宿主路径:容器路径[:ro]。
 *
 * 与 `lib/mounts.ts` 的严格解析器不同，这里**不要求宿主路径已存在**、
 * **不查宿主敏感目录**：模板是别人机器上写下的配置，本机未必有那些目录，
 * 敏感目录与路径存在性交由提交时的既有校验与后端兜底。
 *
 * 解析不了的声明（段数不对、路径形态非法、挂载模式不认识）**整条跳过**，
 * 条数报给调用方，不让一条畸形声明把整份模板废掉。
 */
export function parseTemplateMounts(declarations: readonly string[]): ParsedTemplateMounts {
  const rows: TemplateMountRow[] = [];
  let skipped = 0;

  for (const raw of declarations) {
    const declaration = raw.trim();
    if (declaration === '') {
      skipped += 1;
      continue;
    }

    const parts = declaration.split(':');
    if (parts.length !== 2 && parts.length !== 3) {
      skipped += 1;
      continue;
    }

    const hostPath = parts[0].trim();
    const containerPath = parts[1].trim();
    const mode = parts.length === 3 ? parts[2].trim() : '';

    if (!isUsableHostPath(hostPath) || !containerPath.startsWith('/')) {
      skipped += 1;
      continue;
    }
    if (mode !== '' && mode !== 'ro' && mode !== 'rw') {
      skipped += 1;
      continue;
    }
    if (hostPath.includes(',')) {
      // Docker 挂载参数以逗号分段，路径里带逗号一定挂不上。
      skipped += 1;
      continue;
    }

    rows.push({ hostPath, containerPath, readOnly: mode === 'ro' });
  }

  return { rows, skipped };
}

/** 把一条挂载行还原成后端要的声明文本。 */
export function formatTemplateMount(row: TemplateMountRow): string {
  const suffix = row.readOnly ? ':ro' : '';
  return `${row.hostPath}:${row.containerPath}${suffix}`;
}

/**
 * 把模板配置合并进表单。
 *
 * 合并口径：**config 里出现的字段整体替换表单值**（挂载列表整组替换、
 * 环境变量整组替换），**没出现的字段保持表单现状**。
 *
 * 挂载占位符替换作用在**整条声明文本**上：宿主路径与容器路径里的
 * `{name}` 都会被换成沙箱名，`:ro` 后缀不受影响。
 */
export function applyTemplateConfig(
  form: TemplateFormState,
  config: TemplateConfig,
  sandboxName: string,
): ApplyTemplateResult {
  const next: TemplateFormState = {
    image: form.image,
    mounts: form.mounts.map((row) => ({ ...row })),
    command: form.command,
    workdir: form.workdir,
    env: { ...form.env },
    network: form.network,
  };
  let skippedDeclarations = 0;

  if (has(config, 'image')) {
    // 填了空值（null）也是「出现」：清掉表单里的镜像选择。
    next.image = config.image ?? '';
  }

  if (has(config, 'mounts')) {
    const declarations = (config.mounts ?? []).map((item) =>
      substituteNamePlaceholder(item, sandboxName),
    );
    const parsed = parseTemplateMounts(declarations);
    next.mounts = parsed.rows;
    skippedDeclarations = parsed.skipped;
  }

  if (has(config, 'command')) {
    next.command =
      config.command === null || config.command === undefined
        ? ''
        : substituteNamePlaceholder(config.command, sandboxName);
  }

  if (has(config, 'workdir')) {
    next.workdir =
      config.workdir === null || config.workdir === undefined
        ? ''
        : substituteNamePlaceholder(config.workdir, sandboxName);
  }

  if (has(config, 'env')) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env ?? {})) {
      env[key] = substituteNamePlaceholder(value, sandboxName);
    }
    next.env = env;
  }

  if (has(config, 'network')) {
    next.network =
      config.network === null || config.network === undefined
        ? null
        : substituteNamePlaceholder(config.network, sandboxName);
  }

  return { form: next, skippedDeclarations };
}

/**
 * 从表单收集一份模板配置。
 *
 * **只写有值的字段**：镜像 / 命令 / 工作目录 / 网络为空，挂载列表为空，
 * 环境变量为空，一律不进配置对象（空配置会让「出现即替换」的语义
 * 变成「清空用户填的东西」）。
 */
export function collectTemplateConfig(form: TemplateFormState): TemplateConfig {
  const config: TemplateConfig = {};

  if (form.image.trim() !== '') {
    config.image = form.image.trim();
  }
  if (form.mounts.length > 0) {
    config.mounts = form.mounts.map(formatTemplateMount);
  }
  if (form.command.trim() !== '') {
    config.command = form.command.trim();
  }
  if (form.workdir.trim() !== '') {
    config.workdir = form.workdir.trim();
  }
  if (Object.keys(form.env).length > 0) {
    config.env = { ...form.env };
  }
  if (form.network !== null && form.network.trim() !== '') {
    config.network = form.network.trim();
  }

  return config;
}

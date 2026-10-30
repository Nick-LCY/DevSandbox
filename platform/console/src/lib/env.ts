/**
 * 环境变量声明的前端解析。
 *
 * 文本按行写 `键=值`，键名走与后端一致的白名单（`^[A-Za-z_][A-Za-z0-9_]*$`）。
 */

export type EnvParseResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string };

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析多行 `键=值` 文本。空行忽略，`#` 开头的行忽略。 */
export function parseEnvLines(text: string): EnvParseResult {
  const env: Record<string, string> = {};
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      return { ok: false, error: `环境变量格式非法（应为 键=值）：${line}` };
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      return { ok: false, error: `环境变量名不合法：${key}` };
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      return { ok: false, error: `环境变量名重复：${key}` };
    }
    env[key] = value;
  }

  return { ok: true, env };
}

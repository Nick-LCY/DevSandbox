import { describe, expect, it } from 'vitest';

import { parseEnvLines } from './env';

describe('parseEnvLines', () => {
  it('解析多条 键=值', () => {
    const result = parseEnvLines('FOO=bar\nBAZ=qux');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    }
  });

  it('空行与注释行忽略', () => {
    const result = parseEnvLines('\n# 注释\nFOO=bar\n\n');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toEqual({ FOO: 'bar' });
    }
  });

  it('值里可以带等号', () => {
    const result = parseEnvLines('URL=http://host:3128/?a=b');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.URL).toBe('http://host:3128/?a=b');
    }
  });

  it('缺等号报错', () => {
    const result = parseEnvLines('FOO');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('键=值');
    }
  });

  it('键名不合白名单报错', () => {
    const result = parseEnvLines('1FOO=bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不合法');
    }
  });

  it('键名重复报错', () => {
    const result = parseEnvLines('FOO=1\nFOO=2');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('重复');
    }
  });
});

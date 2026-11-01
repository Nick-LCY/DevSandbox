import { describe, expect, it } from 'vitest';

import { validateImageSelection, validateSandboxName } from './validate';

describe('validateSandboxName', () => {
  it('合法名字通过', () => {
    expect(validateSandboxName('demo-01')).toBeNull();
    expect(validateSandboxName('demo_01')).toBeNull();
    expect(validateSandboxName('a')).toBeNull();
  });

  it('空名报错', () => {
    expect(validateSandboxName('  ')).toContain('请填写');
  });

  it('大写字母与非法字符报错', () => {
    expect(validateSandboxName('Demo')).toContain('小写字母');
    expect(validateSandboxName('demo 01')).toContain('小写字母');
    expect(validateSandboxName('-demo')).toContain('小写字母');
  });

  it('超过 24 位报错', () => {
    expect(validateSandboxName('a'.repeat(25))).toContain('24');
    expect(validateSandboxName('a'.repeat(24))).toBeNull();
  });
});

describe('validateImageSelection', () => {
  it('必须选镜像', () => {
    expect(validateImageSelection('')).toContain('请选择');
    expect(validateImageSelection('alpine:3')).toBeNull();
  });
});

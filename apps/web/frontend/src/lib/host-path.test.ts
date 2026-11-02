import { describe, expect, it } from 'vitest';

import { isUnderPath, normalizeHostPath } from './host-path';

describe('normalizeHostPath', () => {
  it('折叠 . 与 ..', () => {
    expect(normalizeHostPath('/tmp/./data/../data/secret')).toBe('/tmp/data/secret');
    expect(normalizeHostPath('/tmp/../etc/passwd')).toBe('/etc/passwd');
    expect(normalizeHostPath('/..')).toBe('/');
  });

  it('压平前导多斜杠', () => {
    expect(normalizeHostPath('//etc/passwd')).toBe('/etc/passwd');
    expect(normalizeHostPath('///etc/passwd')).toBe('/etc/passwd');
    expect(normalizeHostPath('//etc/../shadow')).toBe('/shadow');
  });

  it('家目录写法（~）不动', () => {
    expect(normalizeHostPath('~')).toBe('~');
    expect(normalizeHostPath('~/data')).toBe('~/data');
  });
});

describe('isUnderPath', () => {
  it('等于 base 或落在 base 之下都算命中', () => {
    expect(isUnderPath('/etc', '/etc')).toBe(true);
    expect(isUnderPath('/etc/passwd', '/etc')).toBe(true);
    expect(isUnderPath('/etcetera', '/etc')).toBe(false);
  });

  it('归一化之后才比（.. 与前导多斜杠都算命中）', () => {
    expect(isUnderPath('/tmp/../etc/passwd', '/etc')).toBe(true);
    expect(isUnderPath('//etc/passwd', '/etc')).toBe(true);
    expect(isUnderPath('/tmp/../data/x', '/etc')).toBe(false);
  });

  it('base 是根目录时任何绝对路径都在其下', () => {
    expect(isUnderPath('/data/x', '/')).toBe(true);
    expect(isUnderPath('data/x', '/')).toBe(false);
  });
});

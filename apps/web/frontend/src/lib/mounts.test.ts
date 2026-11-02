import { describe, expect, it } from 'vitest';

import {
  formatMountDeclaration,
  isSensitiveHostPath,
  parseMountDeclaration,
  validateMountDeclarations,
} from './mounts';

describe('parseMountDeclaration', () => {
  it('解析 宿主路径:容器路径', () => {
    const result = parseMountDeclaration('/data/project:/workspace');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.declaration).toEqual({
        hostPath: '/data/project',
        containerPath: '/workspace',
        readOnly: false,
      });
    }
  });

  it('解析只读后缀 :ro', () => {
    const result = parseMountDeclaration('/data/project:/workspace:ro');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.declaration.readOnly).toBe(true);
    }
  });

  it('空声明报空', () => {
    const result = parseMountDeclaration('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('段数不对报格式非法', () => {
    const result = parseMountDeclaration('/a:/b:/c:/d');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('格式非法');
    }
  });

  it('宿主路径必须绝对（或以 ~/ 开头）', () => {
    const result = parseMountDeclaration('relative/path:/workspace');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('绝对路径');
    }
  });

  it('宿主路径允许家目录写法（~ 与 ~/…）', () => {
    const result = parseMountDeclaration('~/data/project:/workspace');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.declaration.hostPath).toBe('~/data/project');
    }

    const bare = parseMountDeclaration('~:/workspace');
    expect(bare.ok).toBe(true);
  });

  it('~other（别人的家目录）不放过', () => {
    const result = parseMountDeclaration('~other/data:/workspace');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('绝对路径');
    }
  });

  it('容器路径必须绝对', () => {
    const result = parseMountDeclaration('/data:workspace');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('绝对路径');
    }
  });

  it('路径含逗号一律拒绝', () => {
    const result = parseMountDeclaration('/data/a,b:/workspace');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('逗号');
    }
  });

  it('挂载模式只认 ro 与 rw', () => {
    const result = parseMountDeclaration('/data:/workspace:xx');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('ro');
    }
  });

  it('宿主敏感目录一律拒绝', () => {
    const result = parseMountDeclaration('/etc:/host-etc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('敏感清单');
    }
  });

  it('宿主路径先归一化再判敏感清单（.. 绕不过去）', () => {
    const result = parseMountDeclaration('/tmp/../etc/passwd:/host-passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('敏感清单');
    }
  });

  it('宿主路径先归一化再判敏感清单（前导多斜杠绕不过去）', () => {
    const result = parseMountDeclaration('//etc:/host-etc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('敏感清单');
    }
  });
});

describe('isSensitiveHostPath', () => {
  it('命中敏感目录及其子目录', () => {
    expect(isSensitiveHostPath('/etc')).toBe(true);
    expect(isSensitiveHostPath('/etc/passwd')).toBe(true);
    expect(isSensitiveHostPath('/proc/1')).toBe(true);
    expect(isSensitiveHostPath('/var/run/docker.sock')).toBe(true);
  });

  it('普通目录不算敏感', () => {
    expect(isSensitiveHostPath('/data/project')).toBe(false);
    expect(isSensitiveHostPath('/etcetera')).toBe(false);
  });

  it('非绝对路径（家目录写法）不算敏感', () => {
    expect(isSensitiveHostPath('~/data/project')).toBe(false);
    expect(isSensitiveHostPath('~')).toBe(false);
  });

  it('归一化之后才判（.. 与前导多斜杠都算命中）', () => {
    expect(isSensitiveHostPath('/tmp/../etc/passwd')).toBe(true);
    expect(isSensitiveHostPath('//etc/passwd')).toBe(true);
    expect(isSensitiveHostPath('/tmp/../data/project')).toBe(false);
  });
});

describe('formatMountDeclaration', () => {
  it('可读写不带后缀，只读带 :ro', () => {
    expect(
      formatMountDeclaration({ hostPath: '/data', containerPath: '/workspace', readOnly: false }),
    ).toBe('/data:/workspace');
    expect(
      formatMountDeclaration({ hostPath: '/data', containerPath: '/workspace', readOnly: true }),
    ).toBe('/data:/workspace:ro');
  });
});

describe('validateMountDeclarations', () => {
  it('容器路径重复时报错', () => {
    const error = validateMountDeclarations([
      { hostPath: '/a', containerPath: '/workspace', readOnly: false },
      { hostPath: '/b', containerPath: '/workspace', readOnly: false },
    ]);
    expect(error).toContain('重复');
  });

  it('容器路径各不相同则通过', () => {
    const error = validateMountDeclarations([
      { hostPath: '/a', containerPath: '/workspace', readOnly: false },
      { hostPath: '/b', containerPath: '/data', readOnly: false },
    ]);
    expect(error).toBeNull();
  });
});

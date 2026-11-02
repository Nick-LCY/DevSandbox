import { describe, expect, it } from 'vitest';

import {
  formatFileDeclaration,
  parseFileDeclaration,
  validateFileDeclarations,
} from './files';

describe('parseFileDeclaration', () => {
  it('解析 宿主路径:容器路径', () => {
    const result = parseFileDeclaration('/data/project/.env:/workspace/.env');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.declaration).toEqual({
        hostPath: '/data/project/.env',
        containerPath: '/workspace/.env',
      });
    }
  });

  it('段数不对（三段）报格式非法', () => {
    const result = parseFileDeclaration('/data/a:/workspace:/extra');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('格式非法');
    }
  });

  it('宿主路径必须是绝对路径（相对路径不放行）', () => {
    const result = parseFileDeclaration('relative/path:/workspace/.env');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('绝对路径');
    }
  });

  it('宿主路径允许家目录写法（~ 与 ~/…）', () => {
    const result = parseFileDeclaration('~/.ssh/id_ed25519:/root/.ssh/id_ed25519');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.declaration.hostPath).toBe('~/.ssh/id_ed25519');
    }

    const bare = parseFileDeclaration('~:/root/.bashrc');
    expect(bare.ok).toBe(true);
  });

  it('容器路径必须是绝对路径', () => {
    const result = parseFileDeclaration('/data/a:workspace/.env');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('绝对路径');
    }
  });

  it('路径含逗号一律拒绝', () => {
    const result = parseFileDeclaration('/data/a,b:/workspace/.env');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('逗号');
    }
  });

  it('宿主敏感目录一律拒绝', () => {
    const result = parseFileDeclaration('/etc/passwd:/workspace/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('敏感清单');
    }
  });

  it('宿主路径先归一化再判敏感清单（.. 绕不过去）', () => {
    const result = parseFileDeclaration('/tmp/../etc/passwd:/workspace/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('敏感清单');
    }
  });

  it('宿主路径先归一化再判敏感清单（前导多斜杠绕不过去）', () => {
    const result = parseFileDeclaration('//etc/passwd:/workspace/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('敏感清单');
    }
  });

  it('空声明报空', () => {
    const result = parseFileDeclaration('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('文件注入声明不能为空');
    }
  });
});

describe('formatFileDeclaration', () => {
  it('两段拼接（容器内一律只读，没有第三段标记）', () => {
    expect(formatFileDeclaration({ hostPath: '/data/a', containerPath: '/workspace/a' })).toBe(
      '/data/a:/workspace/a',
    );
  });
});

describe('validateFileDeclarations', () => {
  it('宿主路径重复时报错', () => {
    const error = validateFileDeclarations([
      { hostPath: '/data/a', containerPath: '/workspace/a' },
      { hostPath: '/data/a', containerPath: '/workspace/b' },
    ]);
    expect(error).toContain('宿主路径重复声明');
  });

  it('容器路径重复时报错', () => {
    const error = validateFileDeclarations([
      { hostPath: '/data/a', containerPath: '/workspace/a' },
      { hostPath: '/data/b', containerPath: '/workspace/a' },
    ]);
    expect(error).toContain('容器路径重复');
  });

  it('宿主与容器路径各不相同则通过', () => {
    const error = validateFileDeclarations([
      { hostPath: '/data/a', containerPath: '/workspace/a' },
      { hostPath: '/data/b', containerPath: '/workspace/b' },
    ]);
    expect(error).toBeNull();
  });
});

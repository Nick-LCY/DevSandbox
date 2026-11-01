import { describe, expect, it } from 'vitest';

import {
  applyTemplateConfig,
  collectTemplateConfig,
  parseTemplateMounts,
  type TemplateFormState,
} from './templates';

/** 一份空表单（模板合并的起点）。 */
function emptyForm(overrides: Partial<TemplateFormState> = {}): TemplateFormState {
  return {
    image: '',
    mounts: [],
    command: '',
    commandArray: null,
    workdir: '',
    env: {},
    network: null,
    ...overrides,
  };
}

describe('parseTemplateMounts', () => {
  it('解析 宿主路径:容器路径 与只读后缀', () => {
    const result = parseTemplateMounts(['/data/project:/workspace', '/data/ro:/mnt:ro']);
    expect(result.skipped).toBe(0);
    expect(result.rows).toEqual([
      { hostPath: '/data/project', containerPath: '/workspace', readOnly: false },
      { hostPath: '/data/ro', containerPath: '/mnt', readOnly: true },
    ]);
  });

  it('宿主路径允许家目录写法（~/data 通过）', () => {
    const result = parseTemplateMounts(['~/data/project:/workspace']);
    expect(result.skipped).toBe(0);
    expect(result.rows[0].hostPath).toBe('~/data/project');
  });

  it('解析不了的声明跳过并计数', () => {
    const result = parseTemplateMounts([
      '/data/a:/workspace', // 正常
      '相对路径:/workspace', // 宿主路径形态非法
      '/data/b:workspace', // 容器路径不是绝对路径
      '/data/c:/workspace:xx', // 挂载模式不认识
      '/data/d:/workspace:/extra', // 段数不对
      '', // 空声明
    ]);
    expect(result.skipped).toBe(5);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].hostPath).toBe('/data/a');
  });
});

describe('applyTemplateConfig', () => {
  it('模板里出现的字段整体替换', () => {
    const form = emptyForm({
      image: 'old-image:1',
      command: 'old-command',
      workdir: '/old',
      env: { OLD: '1' },
      network: 'old-net',
    });

    const result = applyTemplateConfig(form, { image: 'new-image:1', command: 'new-command' });

    expect(result.form.image).toBe('new-image:1');
    expect(result.form.command).toBe('new-command');
    // 没出现的字段保持表单现状。
    expect(result.form.workdir).toBe('/old');
    expect(result.form.env).toEqual({ OLD: '1' });
    expect(result.form.network).toBe('old-net');
    // 原表单不被就地改写。
    expect(form.image).toBe('old-image:1');
  });

  it('字段缺失与字段填了空值是两回事', () => {
    // 缺 image 字段：表单里的镜像保持不变。
    const kept = applyTemplateConfig(emptyForm({ image: 'keep:1' }), { command: 'x' });
    expect(kept.form.image).toBe('keep:1');

    // image 出现且取值是 null：整体替换（清空选择）。
    const cleared = applyTemplateConfig(emptyForm({ image: 'keep:1' }), { image: null });
    expect(cleared.form.image).toBe('');
  });

  it('挂载列表整组替换（不是逐条并入）', () => {
    const form = emptyForm({
      mounts: [
        { hostPath: '/old/a', containerPath: '/a', readOnly: false },
        { hostPath: '/old/b', containerPath: '/b', readOnly: true },
      ],
    });

    const result = applyTemplateConfig(form, { mounts: ['/new/c:/c'] });

    expect(result.form.mounts).toEqual([
      { hostPath: '/new/c', containerPath: '/c', readOnly: false },
    ]);
  });

  it('env 整组替换', () => {
    const form = emptyForm({ env: { OLD: '1', KEEP: '2' } });
    const result = applyTemplateConfig(form, { env: { NEW: '3' } });
    expect(result.form.env).toEqual({ NEW: '3' });
  });

  it('模板声明原样回填：挂载里的字面量一个都不替换', () => {
    const result = applyTemplateConfig(emptyForm(), {
      mounts: ['/data/{name}:/work/{name}:ro'],
      env: { APP: '{name}' },
    });
    expect(result.form.mounts).toEqual([
      { hostPath: '/data/{name}', containerPath: '/work/{name}', readOnly: true },
    ]);
    expect(result.form.env).toEqual({ APP: '{name}' });
  });

  it('模板声明原样回填：命令、工作目录与网络同样不替换', () => {
    const result = applyTemplateConfig(emptyForm(), {
      command: 'echo {name}',
      workdir: '/work/{name}',
      network: 'net-{name}',
    });
    expect(result.form.command).toBe('echo {name}');
    expect(result.form.workdir).toBe('/work/{name}');
    expect(result.form.network).toBe('net-{name}');
  });

  it('模板里的挂载有解析不了的：跳过的条数报出来', () => {
    const result = applyTemplateConfig(emptyForm(), {
      mounts: ['/data/a:/workspace', '畸形声明'],
    });
    expect(result.skippedDeclarations).toBe(1);
    expect(result.form.mounts).toHaveLength(1);
  });

  it('网络字段：出现即透传，缺失即保持现状', () => {
    const withNetwork = applyTemplateConfig(emptyForm({ network: null }), {
      network: 'template-net',
    });
    expect(withNetwork.form.network).toBe('template-net');

    const withoutNetwork = applyTemplateConfig(emptyForm({ network: 'kept-net' }), {
      image: 'x:1',
    });
    expect(withoutNetwork.form.network).toBe('kept-net');
  });

  it('命令是数组：表单输入框留空，数组进隐藏状态（元素原样透传）', () => {
    const result = applyTemplateConfig(emptyForm({ command: '旧命令' }), {
      command: ['/bin/sh', '-c', 'echo {name}'],
    });
    // 表单那一行装不下数组：留空。
    expect(result.form.command).toBe('');
    // 数组原样透传，每个元素都不做替换。
    expect(result.form.commandArray).toEqual(['/bin/sh', '-c', 'echo {name}']);
  });

  it('命令字段缺失：表单命令与隐藏数组都保持现状', () => {
    const result = applyTemplateConfig(
      emptyForm({ command: '保留的命令', commandArray: ['保留', '的数组'] }),
      { image: 'x:1' },
    );
    expect(result.form.command).toBe('保留的命令');
    expect(result.form.commandArray).toEqual(['保留', '的数组']);
  });

  it('命令字段出现且是字符串：清掉之前的隐藏数组', () => {
    const result = applyTemplateConfig(emptyForm({ commandArray: ['旧的数组'] }), {
      command: '新的命令',
    });
    expect(result.form.command).toBe('新的命令');
    expect(result.form.commandArray).toBeNull();
  });
});

describe('collectTemplateConfig', () => {
  it('没值的字段不进配置', () => {
    const config = collectTemplateConfig(emptyForm());
    expect(config).toEqual({});
  });

  it('有值的字段进配置', () => {
    const config = collectTemplateConfig(
      emptyForm({
        image: 'sandbox-platform/base:0.3.0',
        mounts: [{ hostPath: '/data', containerPath: '/workspace', readOnly: true }],
        command: 'sleep infinity',
        workdir: '/workspace',
        env: { APP: 'demo' },
        network: 'demo-net',
      }),
    );
    expect(config).toEqual({
      image: 'sandbox-platform/base:0.3.0',
      mounts: ['/data:/workspace:ro'],
      command: 'sleep infinity',
      workdir: '/workspace',
      env: { APP: 'demo' },
      network: 'demo-net',
    });
  });

  it('收集与合并是一对逆操作（出现即替换 / 缺失即保持）', () => {
    const form = emptyForm({
      image: 'sandbox-platform/base:0.3.0',
      command: 'sleep infinity',
    });
    const config = collectTemplateConfig(form);
    const applied = applyTemplateConfig(emptyForm({ workdir: '/kept' }), config);
    expect(applied.form.image).toBe('sandbox-platform/base:0.3.0');
    expect(applied.form.command).toBe('sleep infinity');
    expect(applied.form.workdir).toBe('/kept');
  });

  it('空挂载行不进配置（宿主与容器路径同时为空的行是假声明）', () => {
    const config = collectTemplateConfig(
      emptyForm({
        mounts: [
          { hostPath: '', containerPath: '', readOnly: false },
          { hostPath: '   ', containerPath: '', readOnly: false },
          { hostPath: '', containerPath: '  ', readOnly: true },
          { hostPath: '/data', containerPath: '/workspace', readOnly: false },
        ],
      }),
    );
    expect(config.mounts).toEqual(['/data:/workspace']);
  });

  it('挂载路径先 trim 再入库', () => {
    const config = collectTemplateConfig(
      emptyForm({
        mounts: [{ hostPath: '  /data  ', containerPath: ' /workspace ', readOnly: true }],
      }),
    );
    expect(config.mounts).toEqual(['/data:/workspace:ro']);
  });

  it('全是空挂载行：挂载字段不进配置', () => {
    const config = collectTemplateConfig(
      emptyForm({
        mounts: [{ hostPath: '', containerPath: '', readOnly: false }],
      }),
    );
    expect(config.mounts).toBeUndefined();
  });

  it('隐藏的数组命令优先于表单命令（数组原样收集）', () => {
    const config = collectTemplateConfig(
      emptyForm({ command: '表单里的命令', commandArray: ['/bin/sh', '-c', 'echo hi'] }),
    );
    expect(config.command).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('没有隐藏数组时收集表单里的字符串命令', () => {
    const config = collectTemplateConfig(emptyForm({ command: '  sleep infinity  ' }));
    expect(config.command).toBe('sleep infinity');
  });
});

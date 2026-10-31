import { describe, expect, it } from 'vitest';

import {
  applyTemplateConfig,
  collectTemplateConfig,
  parseTemplateMounts,
  substituteNamePlaceholder,
  type TemplateFormState,
} from './templates';

/** 一份空表单（模板合并的起点）。 */
function emptyForm(overrides: Partial<TemplateFormState> = {}): TemplateFormState {
  return {
    image: '',
    mounts: [],
    command: '',
    workdir: '',
    env: {},
    network: null,
    ...overrides,
  };
}

describe('substituteNamePlaceholder', () => {
  it('有沙箱名：{name} 换成沙箱名', () => {
    expect(substituteNamePlaceholder('/data/{name}', 'demo')).toBe('/data/demo');
    expect(substituteNamePlaceholder('{name}', 'demo')).toBe('demo');
    expect(substituteNamePlaceholder('a-{name}-b-{name}', 'demo')).toBe('a-demo-b-demo');
  });

  it('沙箱名为空：占位符原样保留', () => {
    expect(substituteNamePlaceholder('/data/{name}', '')).toBe('/data/{name}');
    expect(substituteNamePlaceholder('{name}', '')).toBe('{name}');
  });

  it('没有占位符：原样返回', () => {
    expect(substituteNamePlaceholder('/data/project', 'demo')).toBe('/data/project');
  });
});

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

    const result = applyTemplateConfig(
      form,
      { image: 'new-image:1', command: 'new-command' },
      'demo',
    );

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
    const kept = applyTemplateConfig(emptyForm({ image: 'keep:1' }), { command: 'x' }, 'demo');
    expect(kept.form.image).toBe('keep:1');

    // image 出现且取值是 null：整体替换（清空选择）。
    const cleared = applyTemplateConfig(
      emptyForm({ image: 'keep:1' }),
      { image: null },
      'demo',
    );
    expect(cleared.form.image).toBe('');
  });

  it('挂载列表整组替换（不是逐条并入）', () => {
    const form = emptyForm({
      mounts: [
        { hostPath: '/old/a', containerPath: '/a', readOnly: false },
        { hostPath: '/old/b', containerPath: '/b', readOnly: true },
      ],
    });

    const result = applyTemplateConfig(form, { mounts: ['/new/c:/c'] }, 'demo');

    expect(result.form.mounts).toEqual([
      { hostPath: '/new/c', containerPath: '/c', readOnly: false },
    ]);
  });

  it('env 整组替换', () => {
    const form = emptyForm({ env: { OLD: '1', KEEP: '2' } });
    const result = applyTemplateConfig(form, { env: { NEW: '3' } }, 'demo');
    expect(result.form.env).toEqual({ NEW: '3' });
  });

  it('占位符替换作用在整条挂载声明上（宿主与容器路径都换，:ro 不受影响）', () => {
    const result = applyTemplateConfig(
      emptyForm(),
      { mounts: ['/data/{name}:/work/{name}:ro'], env: { APP: '{name}' } },
      'demo',
    );
    expect(result.form.mounts).toEqual([
      { hostPath: '/data/demo', containerPath: '/work/demo', readOnly: true },
    ]);
    expect(result.form.env).toEqual({ APP: 'demo' });
  });

  it('沙箱名为空：占位符原样保留', () => {
    const result = applyTemplateConfig(
      emptyForm(),
      { mounts: ['/data/{name}:/workspace'], command: 'echo {name}' },
      '',
    );
    expect(result.form.mounts[0].hostPath).toBe('/data/{name}');
    expect(result.form.command).toBe('echo {name}');
  });

  it('模板里的挂载有解析不了的：跳过的条数报出来', () => {
    const result = applyTemplateConfig(
      emptyForm(),
      { mounts: ['/data/a:/workspace', '畸形声明'] },
      'demo',
    );
    expect(result.skippedDeclarations).toBe(1);
    expect(result.form.mounts).toHaveLength(1);
  });

  it('网络字段：出现即透传，缺失即保持现状', () => {
    const withNetwork = applyTemplateConfig(
      emptyForm({ network: null }),
      { network: 'template-net' },
      'demo',
    );
    expect(withNetwork.form.network).toBe('template-net');

    const withoutNetwork = applyTemplateConfig(
      emptyForm({ network: 'kept-net' }),
      { image: 'x:1' },
      'demo',
    );
    expect(withoutNetwork.form.network).toBe('kept-net');
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
    const applied = applyTemplateConfig(emptyForm({ workdir: '/kept' }), config, 'demo');
    expect(applied.form.image).toBe('sandbox-platform/base:0.3.0');
    expect(applied.form.command).toBe('sleep infinity');
    expect(applied.form.workdir).toBe('/kept');
  });
});

// @vitest-environment jsdom
/**
 * 新建沙箱抽屉：镜像选择器（可搜索）、镜像列表读取失败时的反馈、
 * 创建成功后的收口。
 *
 * 覆盖几件事：
 * - 镜像列表读得到：抽屉里不留任何失败说明；
 * - 镜像列表读不到：弹一条失败 toast，**并**在抽屉里留一行就地环境状态说明
 *   （toast 5 秒就消失，只留 toast 会让空的选择器变得没有解释）；
 * - 镜像列表到位后输入框**不被预填**（没有自动选中的默认镜像）；
 * - 镜像选择器：输入即本地筛选（只剩匹配项）、没命中时空态出现、
 *   逐字符打字能命中、键盘（↓ + Enter）能选中、选中后详情行给出引用 / 大小 /
 *   构建时间；
 * - 弹层顶部没有空白块（第一块可见内容就是列表首行）；
 * - 输入框右侧有下拉箭头；
 * - 没选镜像就提交：抽屉里就地报「请选择沙箱镜像」；
 * - 模板回填的时序：模板列表（毫秒级）先到、镜像列表（秒级）后到时，
 *   模板镜像不被静默清空（镜像真不在宿主上时，列表到齐后再清）；
 * - 模板的命令是数组：应用不崩、命令输入框留空、提交原样透传；
 * - 模板声明**不做任何占位符替换**：回填与提交都原样保留字面量
 *   （挂载 / 环境变量 / 命令 / 工作目录 / 网络）；
 * - 创建成功后不再渲染成功面板（成功面板已退役）；
 * - 创建成功后触发回调并关闭抽屉。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatBytes, formatTimestamp } from '../../lib/format';
import { ToastProvider } from '../Toast';
import { CreateSandboxDialog } from './CreateSandboxDialog';

const mocks = vi.hoisted(() => ({
  listImages: vi.fn(),
  createSandbox: vi.fn(),
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listImages: mocks.listImages,
      createSandbox: mocks.createSandbox,
      listTemplates: mocks.listTemplates,
      createTemplate: mocks.createTemplate,
    },
  };
});

/** 宿主上的一张本地镜像。 */
const IMAGE = 'sandbox-platform/base:0.2.0';
/** 第二张镜像：用来验证「输入即本地筛选」确实只剩命中项。 */
const OTHER_IMAGE = 'sandbox-console-acceptance/local-test:0.1.0';
/** 宿主上的镜像列表（两张）。 */
const IMAGES = [
  { reference: IMAGE, size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
  { reference: OTHER_IMAGE, size_bytes: 4096, created_at: '2026-10-30T03:00:00+00:00' },
];

/** 模板列表（两条）。 */
const TEMPLATES = [
  {
    id: 'tpl_0000000000aa',
    name: '开发环境',
    config: {
      image: IMAGE,
      mounts: ['/data/{name}:/workspace'],
      command: 'sleep infinity',
      workdir: '/workspace',
      env: { APP: '{name}' },
    },
    created_at: '2026-10-31T01:00:00+00:00',
    updated_at: '2026-10-31T02:00:00+00:00',
  },
  {
    id: 'tpl_0000000000bb',
    name: '干净环境',
    config: {},
    created_at: '2026-10-31T01:00:00+00:00',
    updated_at: '2026-10-31T02:00:00+00:00',
  },
];

/** 渲染带 Provider 的新建沙箱抽屉。 */
function renderDialog(overrides: Partial<Parameters<typeof CreateSandboxDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onCreated: vi.fn(),
    widthVw: 40,
    onWidthChange: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <ToastProvider>
        <CreateSandboxDialog {...props} />
      </ToastProvider>,
    ),
  };
}

/** 镜像选择器的输入框（现在是可搜索选择器的搜索框）。 */
function imageInput(): HTMLInputElement {
  return screen.getByTestId('page-sandbox-create-image-select') as HTMLInputElement;
}

/**
 * 打开镜像选择器。
 *
 * jsdom 里点输入框打不开弹层：原语 listens 在 mousedown 上（浏览器里点一下
 * 就开），fireEvent.click 不带 mousedown，因此用 ↓ 键打开。
 */
function openImagePicker(): void {
  fireEvent.keyDown(imageInput(), { key: 'ArrowDown' });
}

/** 当前弹层里渲染出来的选项（按镜像 reference 排序）。 */
function optionReferences(): string[] {
  return screen
    .queryAllByTestId('page-sandbox-create-image-option')
    .map((element) => element.getAttribute('data-image-reference') ?? '');
}

/** 在选择器里搜索关键字（整值替换）。 */
function searchImage(keyword: string): void {
  fireEvent.change(imageInput(), { target: { value: keyword } });
}

/**
 * 一个字符一个字符地敲（模拟真实打字）。
 *
 * 真实用户是在**已有文字后追加**，不是整值替换：整值替换恰好绕开了
 * 「预填文字挡在前面、搜索永远命中不了」的问题，必须逐字符模拟才测得到。
 */
function typeImage(text: string): void {
  const input = imageInput();
  let value = '';
  for (const character of text) {
    value += character;
    fireEvent.change(input, { target: { value } });
  }
}

/** 点选弹层里的某个镜像。 */
async function pickImage(reference: string): Promise<void> {
  const option = screen
    .queryAllByTestId('page-sandbox-create-image-option')
    .find((element) => element.getAttribute('data-image-reference') === reference);
  if (!option) {
    throw new Error(`弹层里没有镜像 ${reference}`);
  }
  fireEvent.click(option);
  await waitFor(() =>
    expect(screen.getByTestId('page-sandbox-create-image-detail').textContent).toContain(reference),
  );
}

/** 等镜像列表到位（接口回来了，候选项渲染出来了）。 */
async function waitImageList(): Promise<void> {
  await waitFor(() => expect(mocks.listImages).toHaveBeenCalledTimes(1));
}

/**
 * 等镜像列表**加载完**（不是「请求发出去了」）。
 *
 * 刷新镜像按钮在加载中是禁用的：按钮恢复可点 = 列表已经到齐，
 * 模板回填的「镜像在不在宿主上」判定这时才有依据。
 */
async function waitImagesSettled(): Promise<void> {
  const button = screen.getByTestId(
    'page-sandbox-create-image-refresh-button',
  ) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
}

/** 挂载行的宿主路径输入框（第几行）。 */
function mountHostInput(index = 0): HTMLInputElement {
  return screen.getAllByTestId('page-sandbox-create-mount-host-input')[index] as HTMLInputElement;
}

/** 挂载行的容器路径输入框（第几行）。 */
function mountContainerInput(index = 0): HTMLInputElement {
  return screen.getAllByTestId('page-sandbox-create-mount-container-input')[index] as HTMLInputElement;
}

/** 命令输入框。 */
function commandInput(): HTMLInputElement {
  return screen.getByTestId('page-sandbox-create-command-input') as HTMLInputElement;
}

/** 模板选择器的输入框。 */
function templateInput(): HTMLInputElement {
  return screen.getByTestId('page-sandbox-create-template-select') as HTMLInputElement;
}

/** 打开模板选择器（jsdom 里点输入框打不开弹层，用 ↓ 键打开）。 */
function openTemplatePicker(): void {
  fireEvent.keyDown(templateInput(), { key: 'ArrowDown' });
}

/** 当前弹层里渲染出来的模板候选（按模板名）。 */
function templateOptionNames(): string[] {
  return screen
    .queryAllByTestId('page-sandbox-create-template-option')
    .map((element) => element.getAttribute('data-template-name') ?? '');
}

/** 在模板选择器里搜索关键字（前端本地筛选）。 */
function searchTemplate(keyword: string): void {
  fireEvent.change(templateInput(), { target: { value: keyword } });
}

/** 点选弹层里的某个模板。 */
async function pickTemplate(name: string): Promise<void> {
  const option = screen
    .queryAllByTestId('page-sandbox-create-template-option')
    .find((element) => element.getAttribute('data-template-name') === name);
  if (!option) {
    throw new Error(`弹层里没有模板 ${name}`);
  }
  fireEvent.click(option);
  await waitFor(() => expect(templateInput().value).toBe(name));
}

/** 等模板列表到位。 */
async function waitTemplateList(): Promise<void> {
  await waitFor(() => expect(mocks.listTemplates).toHaveBeenCalledTimes(1));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listImages.mockReset();
  mocks.createSandbox.mockReset();
  mocks.listTemplates.mockReset();
  mocks.createTemplate.mockReset();
});

// 默认：镜像列表与模板列表都读得到（各用例自己覆盖内容）。
beforeEach(() => {
  mocks.listImages.mockResolvedValue(IMAGES);
  mocks.listTemplates.mockResolvedValue([]);
});

describe('新建沙箱抽屉的镜像列表', () => {
  it('镜像列表读得到：抽屉里不留失败说明', async () => {
    mocks.listImages.mockResolvedValue([
      { reference: IMAGE, size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
    ]);

    renderDialog();

    await waitImageList();
    openImagePicker();
    await waitFor(() => expect(optionReferences()).toHaveLength(1));
    expect(screen.queryByTestId('page-sandbox-create-image-status')).toBeNull();
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('镜像列表读不到：弹失败 toast，并留一行就地环境状态说明', async () => {
    mocks.listImages.mockRejectedValue(new Error('读取宿主本地镜像失败'));

    renderDialog();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.textContent).toContain('读取宿主本地镜像失败');
    expect(toast.getAttribute('data-toast-source')).toBe('sandbox-create');

    // toast 会消失，抽屉里的这行说明一直在：空的选择器有解释。
    const status = screen.getByTestId('page-sandbox-create-image-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('镜像列表读取失败');
    expect(status.textContent).toContain('读取宿主本地镜像失败');
  });
});

describe('新建沙箱抽屉的镜像选择器', () => {
  it('镜像列表到位后输入框保持为空（不被预填）', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    await waitFor(() => expect(optionReferences()).toHaveLength(2));

    // 没有自动选中的默认镜像：输入框是空的，详情行为空。
    expect(imageInput().value).toBe('');
    expect(screen.queryByTestId('page-sandbox-create-image-detail')).toBeNull();
  });

  it('输入关键字后只剩命中的镜像', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    // 弹层里先有全部候选。
    await waitFor(() => expect(optionReferences()).toHaveLength(2));

    searchImage('local-test');
    await waitFor(() => expect(optionReferences()).toEqual([OTHER_IMAGE]));
  });

  it('逐字符打字能命中搜索（真实用户是在已有文字后追加）', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    await waitFor(() => expect(optionReferences()).toHaveLength(2));

    // 一个字符一个字符地敲：筛选始终跟着文字走，命中的只剩那一条。
    typeImage('local');
    await waitFor(() => expect(optionReferences()).toEqual([OTHER_IMAGE]));
    expect(imageInput().value).toBe('local');
  });

  it('搜完整引用时只留命中的这一条（筛选不被原语跳过）', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    await waitFor(() => expect(optionReferences()).toHaveLength(2));

    // 关键字与某张镜像的引用完全相同：筛选照旧（只留命中的这一条）。
    searchImage(IMAGE);
    await waitFor(() => expect(optionReferences()).toEqual([IMAGE]));
  });

  it('没有命中时给出空态说明', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    searchImage('zzz-不存在的镜像');

    const empty = await screen.findByTestId('page-sandbox-create-image-no-match');
    expect(empty.textContent).toBe('暂无匹配镜像');
    expect(optionReferences()).toEqual([]);
  });

  it('弹层顶部没有空白块：第一块可见内容就是列表首行', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    await waitFor(() => expect(optionReferences()).toHaveLength(2));

    const popup = screen.getByTestId('page-sandbox-create-image-popup');
    // 弹层的直接子节点里，带纵向内边距又没有内容的 = 顶部空白块。
    const blankBlocks = Array.from(popup.children).filter((child) => {
      const className = child.getAttribute('class') ?? '';
      return /\bpy-/.test(className) && (child.textContent ?? '').trim() === '';
    });
    expect(blankBlocks).toHaveLength(0);

    // 第一块可见内容就是列表首行（不是空态提示，也不是别的占位块）。
    const firstVisible = Array.from(popup.querySelectorAll('*')).find(
      (element) => (element.textContent ?? '').trim() !== '' && element.children.length === 0,
    );
    expect(firstVisible?.getAttribute('data-slot')).toBe('combobox-item');
  });

  it('输入框右侧有下拉箭头，点它能开合弹层', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    const trigger = screen.getByTestId('page-sandbox-create-image-trigger');
    expect(trigger.querySelector('svg')).not.toBeNull();
    // 图标是装饰性的：对辅助技术隐藏。
    expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    // 点箭头：弹层开；再点一次：弹层关。
    expect(screen.queryByTestId('page-sandbox-create-image-popup')).toBeNull();
    fireEvent.mouseDown(trigger);
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-create-image-popup')).not.toBeNull(),
    );
    fireEvent.mouseDown(trigger);
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-create-image-popup')).toBeNull(),
    );
  });

  it('键盘（↓ + Enter）能选中镜像', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    const input = imageInput();
    openImagePicker();
    searchImage('local-test');
    await waitFor(() => expect(optionReferences()).toEqual([OTHER_IMAGE]));

    // ↓ 把高亮移到唯一那条，Enter 选中。
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-create-image-detail').textContent).toContain(OTHER_IMAGE),
    );
    expect(input.value).toBe(OTHER_IMAGE);
  });

  it('选中后详情行给出引用 / 大小 / 构建时间', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    searchImage('local-test');
    await waitFor(() => expect(optionReferences()).toEqual([OTHER_IMAGE]));
    await pickImage(OTHER_IMAGE);

    const detail = screen.getByTestId('page-sandbox-create-image-detail').textContent ?? '';
    expect(detail).toContain(OTHER_IMAGE);
    expect(detail).toContain(formatBytes(4096));
    expect(detail).toContain(formatTimestamp('2026-10-30T03:00:00+00:00'));
  });

  it('输入框文字偏离选中的镜像：等于放弃选择（显示与提交不分叉）', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    searchImage('local-test');
    await waitFor(() => expect(optionReferences()).toEqual([OTHER_IMAGE]));
    await pickImage(OTHER_IMAGE);

    // 选中了：输入框显示引用，详情行在。
    expect(imageInput().value).toBe(OTHER_IMAGE);
    expect(screen.queryByTestId('page-sandbox-create-image-detail')).not.toBeNull();

    // 用户改了字：不再是那张镜像了，选择被放弃（详情行消失）。
    fireEvent.change(imageInput(), { target: { value: 'local-test 改过了' } });
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-create-image-detail')).toBeNull(),
    );
    expect(imageInput().value).toBe('local-test 改过了');
  });

  it('没选镜像就提交：就地报「请选择沙箱镜像」', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });
    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));

    const error = await screen.findByTestId('page-sandbox-create-validation-error');
    expect(error.textContent).toBe('请选择沙箱镜像');
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('输入的文字命中不到任何镜像：同样算没选', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);

    renderDialog();
    await waitImageList();

    openImagePicker();
    searchImage('宿主上没有的镜像');
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-create-image-no-match')).toBeTruthy(),
    );

    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });
    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));

    const error = await screen.findByTestId('page-sandbox-create-validation-error');
    expect(error.textContent).toBe('请选择沙箱镜像');
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });
});

describe('新建沙箱抽屉的创建结果', () => {
  /** 填好表单并提交。 */
  async function submitForm(): Promise<void> {
    await waitImageList();
    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });
    openImagePicker();
    searchImage(IMAGE);
    await waitFor(() => expect(optionReferences()).toContain(IMAGE));
    await pickImage(IMAGE);
    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));
  }

  it('创建成功后不再渲染成功面板', async () => {
    mocks.listImages.mockResolvedValue([
      { reference: IMAGE, size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
    ]);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    renderDialog();
    await submitForm();

    await waitFor(() => expect(mocks.createSandbox).toHaveBeenCalledTimes(1));
    // 成功面板的四个标识全部退役。
    expect(screen.queryByTestId('page-sandbox-create-success')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-create-success-message')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-create-steps')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-create-success-link')).toBeNull();
  });

  it('创建成功后触发回调并关闭抽屉', async () => {
    mocks.listImages.mockResolvedValue([
      { reference: IMAGE, size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
    ]);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    const { props } = renderDialog();
    await submitForm();

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith('acc-demo'));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('提交时带上的是选中的镜像引用', async () => {
    mocks.listImages.mockResolvedValue(IMAGES);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    renderDialog();
    await submitForm();

    await waitFor(() => expect(mocks.createSandbox).toHaveBeenCalledTimes(1));
    expect(mocks.createSandbox.mock.calls[0][0].image).toBe(IMAGE);
  });
});

describe('新建沙箱抽屉的模板下拉', () => {
  it('模板列表可搜可选', async () => {
    mocks.listTemplates.mockResolvedValue(TEMPLATES);

    renderDialog();
    await waitTemplateList();

    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(2));

    // 输入即本地筛选：只剩命中的那一条。
    searchTemplate('干净');
    await waitFor(() => expect(templateOptionNames()).toEqual(['干净环境']));

    await pickTemplate('干净环境');
    expect(templateInput().value).toBe('干净环境');
  });

  it('选中模板即回填表单（模板声明原样回填，不做占位符替换）', async () => {
    mocks.listTemplates.mockResolvedValue(TEMPLATES);

    renderDialog();
    await waitTemplateList();

    // 先填沙箱名：模板里的字面量不会被它影响。
    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });

    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(2));
    await pickTemplate('开发环境');

    // 镜像回填（模板里的镜像在宿主本地镜像列表里）。
    await waitFor(() => expect(imageInput().value).toBe(IMAGE));
    // 挂载整组替换：字面量原样保留（不做任何占位符替换）。
    await waitFor(() =>
      expect(
        (screen.getByTestId('page-sandbox-create-mount-host-input') as HTMLInputElement).value,
      ).toBe('/data/{name}'),
    );
    expect(
      (screen.getByTestId('page-sandbox-create-mount-container-input') as HTMLInputElement).value,
    ).toBe('/workspace');
    expect((screen.getByTestId('page-sandbox-create-command-input') as HTMLInputElement).value).toBe(
      'sleep infinity',
    );
    expect((screen.getByTestId('page-sandbox-create-workdir-input') as HTMLInputElement).value).toBe(
      '/workspace',
    );
    expect((screen.getByTestId('page-sandbox-create-env-input') as HTMLTextAreaElement).value).toBe(
      'APP={name}',
    );
  });

  it('模板里的镜像不在宿主列表上：镜像选择器留空，提交走既有校验', async () => {
    mocks.listTemplates.mockResolvedValue([
      { ...TEMPLATES[0], config: { image: '宿主上没有的镜像:0.1.0' } },
    ]);

    renderDialog();
    await waitTemplateList();

    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(1));
    await pickTemplate('开发环境');

    expect(imageInput().value).toBe('');
    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });
    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));

    const error = await screen.findByTestId('page-sandbox-create-validation-error');
    expect(error.textContent).toBe('请选择沙箱镜像');
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });
});

describe('新建沙箱抽屉的模板回填时序', () => {
  it('模板先回填、镜像列表后到：模板镜像不被静默清空', async () => {
    // 镜像列表是秒级的宿主枚举，模板列表是毫秒级的文件读：模板几乎总是先到。
    let resolveImages: (value: typeof IMAGES) => void = () => {};
    mocks.listImages.mockReturnValue(
      new Promise<typeof IMAGES>((resolve) => {
        resolveImages = resolve;
      }),
    );
    mocks.listTemplates.mockResolvedValue(TEMPLATES);

    renderDialog();
    await waitTemplateList();

    // 镜像列表还没到：选中模板，模板镜像必须原样保留（不能拿空列表当全集）。
    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(2));
    await pickTemplate('开发环境');
    expect(imageInput().value).toBe(IMAGE);

    // 镜像列表后到：模板镜像确实在宿主上 → 仍然保留。
    resolveImages(IMAGES);
    await waitImagesSettled();
    expect(imageInput().value).toBe(IMAGE);
  });

  it('模板先回填、镜像列表后到：镜像真不在宿主上时，列表到齐后清空', async () => {
    let resolveImages: (value: typeof IMAGES) => void = () => {};
    mocks.listImages.mockReturnValue(
      new Promise<typeof IMAGES>((resolve) => {
        resolveImages = resolve;
      }),
    );
    mocks.listTemplates.mockResolvedValue(TEMPLATES);

    renderDialog();
    await waitTemplateList();

    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(2));
    await pickTemplate('开发环境');
    // 列表没到：先留着。
    expect(imageInput().value).toBe(IMAGE);

    // 列表到齐：模板镜像不在宿主上 → 清空（提交时报既有校验）。
    resolveImages([
      { reference: OTHER_IMAGE, size_bytes: 4096, created_at: '2026-10-30T03:00:00+00:00' },
    ]);
    await waitImagesSettled();
    await waitFor(() => expect(imageInput().value).toBe(''));
  });
});

describe('新建沙箱抽屉的数组命令模板', () => {
  /** 一份命令是数组的模板。 */
  const ARRAY_COMMAND_TEMPLATE = {
    ...TEMPLATES[0],
    config: {
      image: IMAGE,
      mounts: ['/data/{name}:/workspace'],
      command: ['/bin/sh', '-c', 'echo {name}'],
      network: 'net-{name}',
    },
  };

  it('命令是数组：应用不崩，命令输入框留空，提交原样透传', async () => {
    mocks.listTemplates.mockResolvedValue([ARRAY_COMMAND_TEMPLATE]);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    renderDialog();
    await waitTemplateList();
    await waitImagesSettled();

    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });

    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(1));
    await pickTemplate('开发环境');

    // 数组装不进单行输入框：输入框留空。
    expect(commandInput().value).toBe('');

    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));
    await waitFor(() => expect(mocks.createSandbox).toHaveBeenCalledTimes(1));

    const payload = mocks.createSandbox.mock.calls[0][0];
    // 数组原样透传，每个元素都不做替换。
    expect(payload.command).toEqual(['/bin/sh', '-c', 'echo {name}']);
    // 镜像一并回填（它在宿主列表里）。
    expect(payload.image).toBe(IMAGE);
  });

  it('命令是数组：表单里又敲了命令时，隐藏的数组命令优先', async () => {
    mocks.listTemplates.mockResolvedValue([ARRAY_COMMAND_TEMPLATE]);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    renderDialog();
    await waitTemplateList();
    await waitImagesSettled();

    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });

    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(1));
    await pickTemplate('开发环境');

    fireEvent.change(commandInput(), { target: { value: 'echo 表单里的命令' } });

    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));
    await waitFor(() => expect(mocks.createSandbox).toHaveBeenCalledTimes(1));

    const payload = mocks.createSandbox.mock.calls[0][0];
    expect(payload.command).toEqual(['/bin/sh', '-c', 'echo {name}']);
  });

  it('模板声明原样提交：挂载 / 网络 / 命令数组里的字面量一个都不替换', async () => {
    mocks.listTemplates.mockResolvedValue([
      {
        ...TEMPLATES[0],
        config: {
          image: IMAGE,
          mounts: ['/data/{name}:/work/{name}:ro'],
          command: ['/bin/sh', '-c', 'echo {name}'],
          workdir: '/work/{name}',
          env: { APP: '{name}' },
          network: 'net-{name}',
        },
      },
    ]);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    renderDialog();
    await waitTemplateList();
    await waitImagesSettled();

    // 沙箱名还空着：模板声明原样回填（字面量不被任何东西改写）。
    openTemplatePicker();
    await waitFor(() => expect(templateOptionNames()).toHaveLength(1));
    await pickTemplate('开发环境');

    expect(mountHostInput().value).toBe('/data/{name}');
    expect(mountContainerInput().value).toBe('/work/{name}');

    // 再填沙箱名并提交：提交内容仍与模板声明一字不差。
    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });
    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));
    await waitFor(() => expect(mocks.createSandbox).toHaveBeenCalledTimes(1));

    const payload = mocks.createSandbox.mock.calls[0][0];
    expect(payload.mounts).toEqual(['/data/{name}:/work/{name}:ro']);
    expect(payload.command).toEqual(['/bin/sh', '-c', 'echo {name}']);
    expect(payload.network).toBe('net-{name}');
    expect(payload.workdir).toBe('/work/{name}');
    expect(payload.env).toEqual({ APP: '{name}' });
    // 字面量原样提交：模板里写了什么，平台就收到什么。
    expect(JSON.stringify(payload)).toContain('{name}');
  });
});

describe('新建沙箱抽屉的模板入口位置', () => {
  it('加载模板块放在抽屉内容的最上方（沙箱名输入之前）', () => {
    renderDialog();

    const dialog = screen.getByTestId('page-sandbox-create-dialog');
    // 只看带标识的输入框（原语内部还有无标识的隐藏输入）。
    const inputs = Array.from(dialog.querySelectorAll('input[data-testid]'));
    expect(inputs.length).toBeGreaterThan(1);
    // 抽屉正文里的第一个输入框是模板选择器，第二个才是沙箱名。
    expect(inputs[0].getAttribute('data-testid')).toBe('page-sandbox-create-template-select');
    expect(inputs[1].getAttribute('data-testid')).toBe('page-sandbox-create-name-input');
  });

  it('保存为模板按钮在页脚里，且在「创建沙箱」主按钮左侧', () => {
    renderDialog();

    const save = screen.getByTestId('page-sandbox-create-template-save-button');
    const submit = screen.getByTestId('page-sandbox-create-submit-button');
    // 文案精确为「保存为模板」。
    expect(save.textContent).toBe('保存为模板');
    // 两个按钮同在页脚按钮区。
    expect(save.parentElement).toBe(submit.parentElement);
    // 位置在主按钮左侧。
    expect(save.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('新建沙箱抽屉的保存为模板', () => {
  it('空名禁提交：按钮禁用 + 就地红字', async () => {
    renderDialog();
    await waitTemplateList();

    fireEvent.click(screen.getByTestId('page-sandbox-create-template-save-button'));
    const confirm = (await screen.findByTestId(
      'page-sandbox-create-template-confirm-button',
    )) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = screen.getByTestId('page-sandbox-create-template-name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '开发环境' } });
    expect(confirm.disabled).toBe(false);

    // 清空：又禁掉，并在就地给出红字。
    fireEvent.change(input, { target: { value: '' } });
    expect(confirm.disabled).toBe(true);
    const error = await screen.findByTestId('page-sandbox-create-template-name-error');
    expect(error.textContent).toBe('模板名称不能为空');
    expect(mocks.createTemplate).not.toHaveBeenCalled();
  });

  it('保存成功：弹成功 toast（来源 sandbox-template）并关掉弹窗', async () => {
    mocks.createTemplate.mockResolvedValue({ id: 'tpl_x', name: '开发环境', config: {} });

    renderDialog();
    await waitTemplateList();

    fireEvent.click(screen.getByTestId('page-sandbox-create-template-save-button'));
    const input = await screen.findByTestId('page-sandbox-create-template-name-input');
    fireEvent.change(input, { target: { value: '开发环境' } });
    fireEvent.click(screen.getByTestId('page-sandbox-create-template-confirm-button'));

    await waitFor(() => expect(mocks.createTemplate).toHaveBeenCalledTimes(1));
    expect(mocks.createTemplate.mock.calls[0][0].name).toBe('开发环境');

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('sandbox-template');
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-create-template-dialog')).toBeNull(),
    );
  });

  it('保存的是当前表单：只有有值的字段进配置', async () => {    mocks.createTemplate.mockResolvedValue({ id: 'tpl_x', name: '开发环境', config: {} });

    renderDialog();
    await waitTemplateList();

    // 只填镜像与命令，其余留空。
    openImagePicker();
    searchImage(IMAGE);
    await waitFor(() => expect(optionReferences()).toContain(IMAGE));
    await pickImage(IMAGE);
    fireEvent.change(screen.getByTestId('page-sandbox-create-command-input'), {
      target: { value: 'sleep infinity' },
    });

    fireEvent.click(screen.getByTestId('page-sandbox-create-template-save-button'));
    const input = await screen.findByTestId('page-sandbox-create-template-name-input');
    fireEvent.change(input, { target: { value: '开发环境' } });
    fireEvent.click(screen.getByTestId('page-sandbox-create-template-confirm-button'));

    await waitFor(() => expect(mocks.createTemplate).toHaveBeenCalledTimes(1));
    const config = mocks.createTemplate.mock.calls[0][0].config;
    expect(config.image).toBe(IMAGE);
    expect(config.command).toBe('sleep infinity');
    // 没填的字段不进配置（加载时保持表单现状）。
    expect(config.workdir).toBeUndefined();
    expect(config.mounts).toBeUndefined();
    expect(config.env).toBeUndefined();
    expect(config.network).toBeUndefined();
  });

  it('空挂载行不进模板配置（两段路径都空的行是假声明）', async () => {
    mocks.createTemplate.mockResolvedValue({ id: 'tpl_x', name: '开发环境', config: {} });

    renderDialog();
    await waitTemplateList();

    // 点两次「添加挂载」：第一行填上路径，第二行留着空。
    fireEvent.click(screen.getByTestId('page-sandbox-create-mount-add-button'));
    fireEvent.click(screen.getByTestId('page-sandbox-create-mount-add-button'));
    fireEvent.change(mountHostInput(0), { target: { value: '  /data  ' } });
    fireEvent.change(mountContainerInput(0), { target: { value: ' /workspace ' } });

    fireEvent.click(screen.getByTestId('page-sandbox-create-template-save-button'));
    const input = await screen.findByTestId('page-sandbox-create-template-name-input');
    fireEvent.change(input, { target: { value: '开发环境' } });
    fireEvent.click(screen.getByTestId('page-sandbox-create-template-confirm-button'));

    await waitFor(() => expect(mocks.createTemplate).toHaveBeenCalledTimes(1));
    const config = mocks.createTemplate.mock.calls[0][0].config;
    // 只留填了路径的那一行（路径先 trim），空行不进配置。
    expect(config.mounts).toEqual(['/data:/workspace']);
  });
});

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
 * - 创建成功后不再渲染成功面板（成功面板已退役）；
 * - 创建成功后触发回调并关闭抽屉。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatBytes, formatTimestamp } from '../../lib/format';
import { ToastProvider } from '../Toast';
import { CreateSandboxDialog } from './CreateSandboxDialog';

const mocks = vi.hoisted(() => ({
  listImages: vi.fn(),
  createSandbox: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listImages: mocks.listImages,
      createSandbox: mocks.createSandbox,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listImages.mockReset();
  mocks.createSandbox.mockReset();
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

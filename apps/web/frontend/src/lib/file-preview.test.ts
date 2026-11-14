import { describe, expect, it } from 'vitest';

import {
  PREVIEW_LARGE_FILE_BYTES,
  currentPreview,
  isLargePreviewFile,
  previewStackReducer,
  splitPreviewLines,
  type PreviewTarget,
} from './file-preview';

function target(name: string): PreviewTarget {
  return { path: `/home/acc-demo/${name}`, name, size: 10 };
}

describe('大文件判定（> 2 MB 走二次确认）', () => {
  it('阈值是 2 MiB（与 formatFileSize 的 1024 进制一致）', () => {
    expect(PREVIEW_LARGE_FILE_BYTES).toBe(2 * 1024 * 1024);
  });

  it('恰好 2 MB 不算大文件（PRD 写的是「超过 2 MB」）', () => {
    expect(isLargePreviewFile(PREVIEW_LARGE_FILE_BYTES)).toBe(false);
  });

  it('超过 2 MB 才算大文件', () => {
    expect(isLargePreviewFile(PREVIEW_LARGE_FILE_BYTES + 1)).toBe(true);
    expect(isLargePreviewFile(8 * 1024 * 1024)).toBe(true);
  });

  it('小文件 / 空文件不算大文件', () => {
    expect(isLargePreviewFile(0)).toBe(false);
    expect(isLargePreviewFile(1024)).toBe(false);
  });

  it('拿不到大小（null / NaN / 负数）按小文件处理（不用弹窗挡住用户）', () => {
    expect(isLargePreviewFile(null)).toBe(false);
    expect(isLargePreviewFile(undefined)).toBe(false);
    expect(isLargePreviewFile(Number.NaN)).toBe(false);
    expect(isLargePreviewFile(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isLargePreviewFile(-1)).toBe(false);
  });
});

describe('预览返回栈', () => {
  it('栈空 = 列表态：currentPreview 为 null', () => {
    expect(currentPreview([])).toBeNull();
  });

  it('push 压栈、栈顶是当前预览', () => {
    const first = target('a.txt');
    const state = previewStackReducer([], { type: 'push', target: first });
    expect(state).toEqual([first]);
    expect(currentPreview(state)).toEqual(first);
  });

  it('push 不原地改（纯函数）', () => {
    const initial: PreviewTarget[] = [];
    const next = previewStackReducer(initial, { type: 'push', target: target('a.txt') });
    expect(initial).toEqual([]);
    expect(next).toHaveLength(1);
  });

  it('pop 退回上一层；返回钮在栈空时隐藏（栈空 pop 保持空）', () => {
    const a = target('a.txt');
    const b = target('b.txt');
    const stacked = previewStackReducer(
      previewStackReducer([], { type: 'push', target: a }),
      { type: 'push', target: b },
    );
    expect(currentPreview(stacked)).toEqual(b);
    const popped = previewStackReducer(stacked, { type: 'pop' });
    expect(currentPreview(popped)).toEqual(a);
    const empty = previewStackReducer(popped, { type: 'pop' });
    expect(empty).toEqual([]);
    expect(currentPreview(empty)).toBeNull();
    // 栈空再 pop：仍是空（不抛错、不变成负数）
    expect(previewStackReducer(empty, { type: 'pop' })).toEqual([]);
  });

  it('clear 清栈（点面包屑 / 换目录 / 换沙箱）', () => {
    const state = previewStackReducer([], { type: 'push', target: target('a.txt') });
    expect(previewStackReducer(state, { type: 'clear' })).toEqual([]);
    // 空栈 clear 不造新数组（省一次重渲染）
    const empty: PreviewTarget[] = [];
    expect(previewStackReducer(empty, { type: 'clear' })).toBe(empty);
  });
});

describe('行号槽切分', () => {
  it('按 \\n 切行，空行保留（行号必须与原文对得上）', () => {
    expect(splitPreviewLines('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('末尾换行不多算一行', () => {
    expect(splitPreviewLines('a\n')).toEqual(['a']);
    expect(splitPreviewLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('CRLF 去掉行尾回车（复制出来与原文一致）', () => {
    expect(splitPreviewLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('空文本没有行（不画行号槽）', () => {
    expect(splitPreviewLines('')).toEqual([]);
  });

  it('只有一个换行 = 一行空内容', () => {
    expect(splitPreviewLines('\n')).toEqual(['']);
  });

  it('`.md` 原文按纯文本切行（不做任何 markdown 解释）', () => {
    expect(splitPreviewLines('# 标题\n\n- **粗体** 列表\n')).toEqual([
      '# 标题',
      '',
      '- **粗体** 列表',
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { base64ToBytes, decodeSnapshotParts, type SnapshotPart } from './terminal-snapshot';

/** 造一片快照。 */
function part(overrides: Partial<SnapshotPart> & { part: number; parts: number }): SnapshotPart {
  return {
    data: btoa('x'),
    cols: 80,
    rows: 24,
    pwd: null,
    ...overrides,
  };
}

/** base64 → 可读字符串（测试里比字节数组好比对）。 */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('base64ToBytes', () => {
  it('解出字节', () => {
    const bytes = base64ToBytes(btoa('hello'));
    expect(bytes).not.toBeNull();
    expect(decodeText(bytes!)).toBe('hello');
  });

  it('空串是合法的（解出空数组）', () => {
    const bytes = base64ToBytes('');
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(0);
  });

  it('非法 base64 返回 null', () => {
    expect(base64ToBytes('这不是 base64!!')).toBeNull();
  });

  it('不是字符串返回 null', () => {
    expect(base64ToBytes(123 as unknown as string)).toBeNull();
  });
});

describe('decodeSnapshotParts', () => {
  it('单片：原样解出', () => {
    const bytes = decodeSnapshotParts([part({ part: 0, parts: 1, data: btoa('SNAPSHOT') })]);
    expect(bytes).not.toBeNull();
    expect(decodeText(bytes!)).toBe('SNAPSHOT');
  });

  it('多片：按序号拼接（乱序也能拼对）', () => {
    const bytes = decodeSnapshotParts([
      part({ part: 1, parts: 2, data: btoa('WORLD') }),
      part({ part: 0, parts: 2, data: btoa('HELLO-') }),
    ]);
    expect(bytes).not.toBeNull();
    expect(decodeText(bytes!)).toBe('HELLO-WORLD');
  });

  it('缺片：返回 null（宁可不写，也不写半截画面）', () => {
    expect(
      decodeSnapshotParts([part({ part: 0, parts: 2, data: btoa('ONE') })]),
    ).toBeNull();
  });

  it('分片间的 parts 不一致：返回 null（不是同一份快照）', () => {
    expect(
      decodeSnapshotParts([
        part({ part: 0, parts: 2, data: btoa('ONE') }),
        part({ part: 1, parts: 3, data: btoa('TWO') }),
      ]),
    ).toBeNull();
  });

  it('分片间的 cols / rows 不一致：返回 null（几何对不上，拼出来也错位）', () => {
    expect(
      decodeSnapshotParts([
        part({ part: 0, parts: 2, cols: 80, rows: 24, data: btoa('ONE') }),
        part({ part: 1, parts: 2, cols: 100, rows: 24, data: btoa('TWO') }),
      ]),
    ).toBeNull();
    expect(
      decodeSnapshotParts([
        part({ part: 0, parts: 2, cols: 80, rows: 24, data: btoa('ONE') }),
        part({ part: 1, parts: 2, cols: 80, rows: 30, data: btoa('TWO') }),
      ]),
    ).toBeNull();
  });

  it('序号重复：返回 null', () => {
    expect(
      decodeSnapshotParts([
        part({ part: 0, parts: 2, data: btoa('ONE') }),
        part({ part: 0, parts: 2, data: btoa('TWO') }),
      ]),
    ).toBeNull();
  });

  it('序号越界：返回 null', () => {
    expect(
      decodeSnapshotParts([
        part({ part: 0, parts: 1, data: btoa('ONE') }),
        part({ part: 5, parts: 1, data: btoa('FIVE') }),
      ]),
    ).toBeNull();
  });

  it('片数不是正整数：返回 null', () => {
    expect(decodeSnapshotParts([part({ part: 0, parts: 0 })])).toBeNull();
    expect(
      decodeSnapshotParts([part({ part: 0, parts: 1.5 as unknown as number })]),
    ).toBeNull();
  });

  it('某一片 base64 非法：返回 null', () => {
    expect(
      decodeSnapshotParts([
        part({ part: 0, parts: 2, data: btoa('OK') }),
        part({ part: 1, parts: 2, data: '不是 base64!!' }),
      ]),
    ).toBeNull();
  });

  it('没有分片：返回 null', () => {
    expect(decodeSnapshotParts([])).toBeNull();
  });
});

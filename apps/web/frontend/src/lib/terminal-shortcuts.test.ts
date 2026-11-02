/**
 * 终端快捷键分类的规则单测（纯函数）。
 *
 * 这份分类是**语义锁**：Ctrl+C 仍然是发往容器的 SIGINT、Ctrl+V 仍然是字面量
 * 0x16、浏览器保留键仍然放行、新加的 Ctrl+Shift+C / Ctrl+Shift+V 才走剪贴板。
 * 规则一旦漂移，真机上表现为「Ctrl+C 突然不中断了」这类难查的问题，
 * 所以逐条钉死。
 */
import { describe, expect, it } from 'vitest';

import { classifyTerminalShortcut, type TerminalShortcutEvent } from './terminal-shortcuts';

/** 造一次按键：默认什么都不按。 */
function press(overrides: Partial<TerminalShortcutEvent> & { key: string }): TerminalShortcutEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe('classifyTerminalShortcut：浏览器保留键', () => {
  it('保留字母清单里的键（带 Ctrl）一律交回浏览器', () => {
    for (const key of ['n', 't', 'w', 'q', 'p', 's', 'tab']) {
      expect(classifyTerminalShortcut(press({ key, ctrlKey: true }))).toBe('reserved');
      // 带 Shift 的组合同样放行（Ctrl+Shift+N 是新隐身窗口，Ctrl+Shift+T 是恢复标签页）。
      expect(classifyTerminalShortcut(press({ key, ctrlKey: true, shiftKey: true }))).toBe(
        'reserved',
      );
    }
  });

  it('保留字母清单里的键（带 Meta）同样交回浏览器', () => {
    expect(classifyTerminalShortcut(press({ key: 'w', metaKey: true }))).toBe('reserved');
  });

  it('大写字母与保留清单按小写比对（Shift 不改变归类）', () => {
    expect(classifyTerminalShortcut(press({ key: 'N', ctrlKey: true }))).toBe('reserved');
    expect(classifyTerminalShortcut(press({ key: 'Tab', ctrlKey: true }))).toBe('reserved');
  });

  it('F5 / F11 / F12 不带任何修饰键也是保留键', () => {
    expect(classifyTerminalShortcut(press({ key: 'F5' }))).toBe('reserved');
    expect(classifyTerminalShortcut(press({ key: 'F11' }))).toBe('reserved');
    expect(classifyTerminalShortcut(press({ key: 'F12' }))).toBe('reserved');
  });

  it('Alt+F4 是保留键（关窗口），别的 F 键不是', () => {
    expect(classifyTerminalShortcut(press({ key: 'F4', altKey: true }))).toBe('reserved');
    expect(classifyTerminalShortcut(press({ key: 'F4' }))).not.toBe('reserved');
    expect(classifyTerminalShortcut(press({ key: 'F6' }))).not.toBe('reserved');
  });

  it('单按 Shift 不是保留键（终端里要能正常用）', () => {
    expect(classifyTerminalShortcut(press({ key: 'n', shiftKey: true }))).toBe('plain');
    expect(classifyTerminalShortcut(press({ key: 'Tab', shiftKey: true }))).toBe('plain');
  });
});

describe('classifyTerminalShortcut：剪贴板组合', () => {
  it('Ctrl+Shift+C 是复制', () => {
    expect(classifyTerminalShortcut(press({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe('copy');
  });

  it('Ctrl+Shift+V 是粘贴', () => {
    expect(classifyTerminalShortcut(press({ key: 'v', ctrlKey: true, shiftKey: true }))).toBe('paste');
  });

  it('大写 key 同样命中（按住 Shift 时浏览器给的 key 是大写字母）', () => {
    expect(classifyTerminalShortcut(press({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe('copy');
    expect(classifyTerminalShortcut(press({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe('paste');
  });

  it('Meta（macOS 的 Cmd）+ Shift 同样触发复制与粘贴', () => {
    expect(classifyTerminalShortcut(press({ key: 'c', metaKey: true, shiftKey: true }))).toBe('copy');
    expect(classifyTerminalShortcut(press({ key: 'v', metaKey: true, shiftKey: true }))).toBe('paste');
  });

  it('不带 Shift 的 Ctrl+C / Ctrl+V 不走剪贴板（语义锁）', () => {
    expect(classifyTerminalShortcut(press({ key: 'c', ctrlKey: true }))).toBe('forward');
    expect(classifyTerminalShortcut(press({ key: 'v', ctrlKey: true }))).toBe('forward');
  });

  it('只按 Shift 的 c / v 是普通按键', () => {
    expect(classifyTerminalShortcut(press({ key: 'c', shiftKey: true }))).toBe('plain');
    expect(classifyTerminalShortcut(press({ key: 'v', shiftKey: true }))).toBe('plain');
  });

  it('Ctrl+Shift 的其它字母不进剪贴板', () => {
    expect(classifyTerminalShortcut(press({ key: 'x', ctrlKey: true, shiftKey: true }))).toBe(
      'forward',
    );
    expect(classifyTerminalShortcut(press({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe(
      'forward',
    );
  });
});

describe('classifyTerminalShortcut：转发给容器内的组合', () => {
  it('Ctrl+C 仍然是转发（发往容器的 SIGINT 语义不变）', () => {
    expect(classifyTerminalShortcut(press({ key: 'c', ctrlKey: true }))).toBe('forward');
  });

  it('Ctrl+V 仍然是转发（字面量 0x16 语义不变）', () => {
    expect(classifyTerminalShortcut(press({ key: 'v', ctrlKey: true }))).toBe('forward');
  });

  it('Alt+Backspace 仍然是转发（容器内删词）', () => {
    expect(classifyTerminalShortcut(press({ key: 'Backspace', altKey: true }))).toBe('forward');
  });

  it('Ctrl+Shift+A 这类组合仍然是转发', () => {
    expect(classifyTerminalShortcut(press({ key: 'a', ctrlKey: true, shiftKey: true }))).toBe(
      'forward',
    );
  });

  it('Alt 单独修饰的普通键是转发', () => {
    expect(classifyTerminalShortcut(press({ key: 'a', altKey: true }))).toBe('forward');
  });

  it('Meta 修饰的普通键是转发', () => {
    expect(classifyTerminalShortcut(press({ key: 'a', metaKey: true }))).toBe('forward');
  });
});

describe('classifyTerminalShortcut：普通按键', () => {
  it('纯按键（不带 Ctrl / Meta / Alt）是普通按键', () => {
    expect(classifyTerminalShortcut(press({ key: 'a' }))).toBe('plain');
    expect(classifyTerminalShortcut(press({ key: 'Enter' }))).toBe('plain');
    expect(classifyTerminalShortcut(press({ key: 'ArrowUp' }))).toBe('plain');
  });

  it('单按 Shift 的普通键是普通按键', () => {
    expect(classifyTerminalShortcut(press({ key: 'A', shiftKey: true }))).toBe('plain');
  });

  it('只有 Ctrl+Shift 的非字母键不是剪贴板组合', () => {
    expect(classifyTerminalShortcut(press({ key: 'Enter', ctrlKey: true, shiftKey: true }))).toBe(
      'forward',
    );
  });
});

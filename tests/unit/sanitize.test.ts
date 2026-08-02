import { describe, expect, it } from 'vitest';
import { stripAnsi, toReadableText } from '../../src/sanitize.ts';

describe('stripAnsi', () => {
  it('剥离 CSI 颜色序列', () => {
    expect(stripAnsi('\x1b[31m红\x1b[0m色')).toBe('红色');
    expect(stripAnsi('\x1b[1;32m加粗绿\x1b[m')).toBe('加粗绿');
  });

  it('剥离 OSC 序列（窗口标题等，整段移除）', () => {
    expect(stripAnsi('\x1b]0;窗口标题\x07文本')).toBe('文本');
  });

  it('剥离其他转义（光标/清屏）', () => {
    expect(stripAnsi('\x1b[2J\x1b[H内容')).toBe('内容');
    expect(stripAnsi('\x1b[?25l隐藏光标')).toBe('隐藏光标');
  });

  it('普通文本保持不变', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('')).toBe('');
  });
});

describe('toReadableText', () => {
  it('归一化 CRLF 与 CR', () => {
    expect(toReadableText('a\r\nb\r\nc')).toBe('a\nb\nc');
    expect(toReadableText('a\rb')).toBe('a\nb');
  });

  it('剥离 ANSI 后返回可读文本', () => {
    expect(toReadableText('\x1b[32mok\x1b[0m\r\n')).toBe('ok\n');
  });
});

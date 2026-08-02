// ANSI 剥离：供 `tmon show` 快照与后续 Agent 侧净化使用（docs/03-design.md §8）
// 保留纯文本内容：剥离 CSI/OSC 转义、退格回写、回车（保留换行）

const CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const OTHER_ESC_RE = /\x1b[()][0-9A-B]/g;

export function stripAnsi(s: string): string {
  return s
    .replace(OSC_RE, '')
    .replace(OTHER_ESC_RE, '')
    .replace(CSI_RE, '');
}

/** 将原始终端流清洗为可读文本（供 show 使用）：
 *  - 剥离 ANSI
 *  - \r\n 归一为 \n，独立 \r 视为行刷新（TUI 进度条场景：保留最后一次帧）
 */
export function toReadableText(raw: string): string {
  let out = stripAnsi(raw);
  out = out.replace(/\r\n/g, '\n');
  out = out.replace(/\r/g, '\n');
  return out;
}

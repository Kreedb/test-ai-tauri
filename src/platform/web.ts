import type { TerminalTransport } from '../domain/terminal';

export const webTransport: TerminalTransport = {
  available: false,
  async connect() {
    throw new Error('浏览器无法直接建立 SSH 连接，请使用 Linux 或 Windows 桌面版。');
  },
};

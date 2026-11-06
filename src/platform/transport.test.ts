import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { tauriTransport } from './tauri';
import { webTransport } from './web';
import type { TerminalEvent } from '../domain/terminal';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const request = {
  host: 'localhost', port: 22, username: 'test', password: 'test-only',
  hostKeySha256: `SHA256:${'A'.repeat(43)}`,
};
const size = { cols: 80, rows: 24 };

beforeEach(() => vi.mocked(invoke).mockReset());

describe('platform transports', () => {
  it('explicitly refuses SSH in a static browser deployment', async () => {
    expect(webTransport.available).toBe(false);
    await expect(webTransport.connect(request, size, () => {})).rejects.toThrow('浏览器');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses the command contract and splits input without changing Unicode or binary bytes', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'ssh_connect') return 7;
      return null;
    });
    const connection = await tauriTransport.connect(request, size, () => {});
    expect(invoke).toHaveBeenCalledWith('ssh_connect', { request, size });
    const input = new TextEncoder().encode('中'.repeat(6000));
    await connection.write(input);
    await connection.write(Uint8Array.from([0x1b, 0x5b, 0x4d, 0xff]));
    const writes = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'ssh_write');
    const bytes = writes.flatMap(([, args]) => (args as { data: number[] }).data);
    expect(bytes).toEqual([...input, 0x1b, 0x5b, 0x4d, 0xff]);
    expect(writes).toHaveLength(3);
    await connection.resize(size);
    await connection.disconnect();
    expect(invoke).toHaveBeenCalledWith('ssh_resize', { sessionId: 7, size });
    expect(invoke).toHaveBeenCalledWith('ssh_disconnect', { sessionId: 7 });
  });

  it('does not request more output until xterm has consumed the previous chunk', async () => {
    let read = 0;
    let render!: () => void;
    const rendered = new Promise<void>((resolve) => { render = resolve; });
    let finishClosed!: () => void;
    const closed = new Promise<void>((resolve) => { finishClosed = resolve; });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'ssh_connect') return 9;
      if (command === 'ssh_read') {
        read++;
        return read === 1 ? { type: 'data', data: [65] } : { type: 'closed', error: null };
      }
    });
    const onEvent = vi.fn(async (event: TerminalEvent) => {
      if (event.type === 'data') await rendered;
      else finishClosed();
    });
    await tauriTransport.connect(request, size, onEvent);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(read).toBe(1);
    render();
    await closed;
    expect(read).toBe(2);
  });

  it('closes the native session when output fails', async () => {
    let finishClosed!: () => void;
    const closed = new Promise<void>((resolve) => { finishClosed = resolve; });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'ssh_connect') return 10;
      if (command === 'ssh_read') throw new Error('read failed');
    });
    const onEvent = vi.fn(() => { finishClosed(); });
    await tauriTransport.connect(request, size, onEvent);
    await closed;
    expect(invoke).toHaveBeenCalledWith('ssh_disconnect', { sessionId: 10 });
    expect(onEvent).toHaveBeenCalledWith({ type: 'closed', error: 'Error: read failed' });
  });
});

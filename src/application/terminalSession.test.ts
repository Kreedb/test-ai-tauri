import { describe, expect, it, vi } from 'vitest';
import { createTerminalSession } from './terminalSession';
import type { TerminalConnection, TerminalEvent, TerminalTransport } from '../domain/terminal';

const request = {
  host: 'localhost', port: 22, username: 'test', password: 'test-only',
  hostKeySha256: `SHA256:${'A'.repeat(43)}`,
};
const size = { cols: 80, rows: 24 };
const bytes = (data: string) => new TextEncoder().encode(data);

function fixture() {
  let emit: (event: TerminalEvent) => void | Promise<void> = () => {};
  const active = {
    write: vi.fn(async (_data: Uint8Array) => {}),
    resize: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const transport: TerminalTransport = {
    available: true,
    connect: vi.fn(async (_request, _size, onEvent) => {
      emit = onEvent;
      return active;
    }),
  };
  const onData = vi.fn();
  const session = createTerminalSession(transport, onData);
  return { session, active, transport, onData, emit: (event: TerminalEvent) => emit(event) };
}

describe('terminal session lifecycle', () => {
  it('connects once, forwards bytes and dimensions, and disconnects', async () => {
    const f = fixture();
    await f.session.connect(request, size);
    await f.session.connect(request, size);
    expect(f.transport.connect).toHaveBeenCalledTimes(1);
    expect(f.session.phase.value).toBe('connected');
    f.emit({ type: 'data', data: [0xe4, 0xb8, 0xad] });
    expect(f.onData).toHaveBeenCalledWith(Uint8Array.from([0xe4, 0xb8, 0xad]));
    await f.session.write(bytes('pwd\r'));
    await f.session.resize({ cols: 100, rows: 40 });
    expect(f.active.write).toHaveBeenCalledWith(bytes('pwd\r'));
    expect(f.active.resize).toHaveBeenCalledWith({ cols: 100, rows: 40 });
    await f.session.disconnect();
    expect(f.active.disconnect).toHaveBeenCalledTimes(1);
    expect(f.session.phase.value).toBe('idle');
  });

  it('preserves input order while a previous write is pending', async () => {
    const f = fixture();
    let release!: () => void;
    f.active.write.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await f.session.connect(request, size);
    const first = f.session.write(bytes('a'));
    const second = f.session.write(bytes('b'));
    await Promise.resolve();
    expect(f.active.write).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(f.active.write.mock.calls.map(([data]) => data)).toEqual([bytes('a'), bytes('b')]);
  });

  it('surfaces connection failures without leaving a stuck state', async () => {
    const f = fixture();
    vi.mocked(f.transport.connect).mockRejectedValueOnce('host key rejected');
    await f.session.connect(request, size);
    expect(f.session.phase.value).toBe('idle');
    expect(f.session.error.value).toBe('host key rejected');
  });

  it('closes on input failure and drops queued input', async () => {
    const f = fixture();
    f.active.write.mockRejectedValueOnce(new Error('connection lost'));
    await f.session.connect(request, size);
    await Promise.all([f.session.write(bytes('a')), f.session.write(bytes('b'))]);
    expect(f.active.write).toHaveBeenCalledTimes(1);
    expect(f.active.disconnect).toHaveBeenCalledTimes(1);
    expect(f.session.phase.value).toBe('idle');
    expect(f.session.error.value).toBe('connection lost');
  });

  it('handles remote close and ignores stale events after reconnect', async () => {
    const f = fixture();
    await f.session.connect(request, size);
    const oldEvents = vi.mocked(f.transport.connect).mock.calls[0]![2];
    f.emit({ type: 'closed', error: 'remote closed' });
    expect(f.session.phase.value).toBe('idle');
    expect(f.session.error.value).toBe('remote closed');
    await f.session.connect(request, size);
    oldEvents({ type: 'closed', error: 'stale' });
    expect(f.session.phase.value).toBe('connected');
    expect(f.session.error.value).toBe('');
  });

  it('disconnects a connection that completes after cancellation', async () => {
    const f = fixture();
    let finish!: (connection: TerminalConnection) => void;
    vi.mocked(f.transport.connect).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    const pending = f.session.connect(request, size);
    await f.session.disconnect();
    finish(f.active);
    await pending;
    expect(f.active.disconnect).toHaveBeenCalledTimes(1);
    expect(f.session.phase.value).toBe('idle');
  });

  it('does not resurrect a session closed before connect resolves', async () => {
    const f = fixture();
    vi.mocked(f.transport.connect).mockImplementationOnce(async (_request, _size, onEvent) => {
      onEvent({ type: 'closed', error: null });
      return f.active;
    });
    await f.session.connect(request, size);
    expect(f.session.phase.value).toBe('idle');
    expect(f.active.disconnect).toHaveBeenCalledTimes(1);
  });
});

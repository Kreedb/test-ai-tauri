import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { page } from 'vitest/browser';
import type {} from '@vitest/browser-playwright';
import { createApp, nextTick } from 'vue';
import { Terminal } from '@xterm/xterm';
import { invoke } from '@tauri-apps/api/core';
import App from './App.vue';
import type { TerminalEvent } from './domain/terminal';
import './style.css';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
let app: ReturnType<typeof createApp>;
let host: HTMLDivElement;
let opened: MockInstance<Terminal['open']>;
let disposed: MockInstance<Terminal['dispose']>;
let reads: ReturnType<typeof deferred<TerminalEvent | null>>[];
const terminal = () => opened.mock.contexts.at(-1) as Terminal;

beforeEach(async () => {
  reads = [];
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
    if (command === 'ssh_connect') return calls('ssh_connect').length;
    if (command === 'ssh_read') {
      const read = deferred<TerminalEvent | null>();
      reads.push(read);
      return read.promise;
    }
  });
  // Observe real instances and disposal; all xterm methods still run unchanged.
  opened = vi.spyOn(Terminal.prototype, 'open');
  disposed = vi.spyOn(Terminal.prototype, 'dispose');
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(App);
  app.mount(host);
  // Legacy mouse reports need column 223, beyond the normal page's max-width.
  host.querySelector('main')!.style.maxWidth = 'none';
  await page.getByLabelText('主机', { exact: true }).fill('localhost');
  await page.getByLabelText('用户名').fill('test');
  await page.getByLabelText('主机指纹（SHA256）').fill(`SHA256:${'A'.repeat(43)}`);
});

afterEach(async () => {
  app.unmount();
  reads.forEach((read) => read.resolve(null));
  await nextTick();
  host.remove();
  vi.restoreAllMocks();
});

async function connect() {
  await page.getByLabelText('密码', { exact: true }).fill('test-only');
  await page.getByRole('button', { name: '连接 SSH' }).click();
  await expect.element(page.getByRole('status')).toHaveTextContent('已连接');
}

async function output(data: string | number[]) {
  const count = reads.length;
  reads.at(-1)!.resolve({ type: 'data', data: typeof data === 'string' ? bytes(data) : data });
  await expect.poll(() => reads.length).toBe(count + 1);
}

describe('real Vue terminal in Chromium', () => {
  it('forwards a real legacy mouse report containing 0xff through onBinary and IPC', async () => {
    await connect();
    const term = terminal();
    await expect.poll(() => term.cols).toBeGreaterThanOrEqual(223);
    await output('\x1b[?1000h');
    const binary = vi.fn();
    const subscription = term.onBinary(binary);
    const screen = term.element!.querySelector<HTMLElement>('.xterm-screen')!;
    const { width, height } = screen.getBoundingClientRect();
    // VT200/DEFAULT reports encode one-based coordinates + 32: 223 + 32 = 0xff.
    await page.elementLocator(screen).click({
      position: { x: width / term.cols * 222.5, y: height / term.rows * 0.5 },
    });
    await expect.poll(() => calls('ssh_write').length).toBeGreaterThan(0);
    expect(binary.mock.calls[0]![0]).toBe('\x1b[M \xff!');
    expect(calls('ssh_write')[0]![1]).toEqual({ sessionId: 1, data: [27, 91, 77, 32, 255, 33] });
    subscription.dispose();
  });

  it('waits for the actual xterm write callback before reading more split UTF-8 output', async () => {
    await connect();
    const term = terminal();
    const entered = deferred<void>();
    const release = deferred<boolean>();
    // xterm's public async parser API pauses actual parsing and its write callback.
    const handler = term.parser.registerCsiHandler({ final: 'z' }, () => {
      entered.resolve();
      return release.promise;
    });
    try {
      reads[0]!.resolve({ type: 'data', data: [...bytes('\x1b[2J\x1b[H\x1b[z'), 0xe4] });
      await entered.promise;
      expect(reads).toHaveLength(1);
      release.resolve(true);
      await expect.poll(() => reads.length).toBe(2);
      expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('');
      await output([0xb8]);
      expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('');
      await output([0xad, ...bytes(' done')]);
      expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('中 done');
      await expect.poll(() => term.element!.querySelector('.xterm-rows')!.textContent).toContain('中 done');
    } finally {
      release.resolve(true);
      handler.dispose();
    }
  });

  it('disposes old terminals and restores cursor, colors, parser and accessibility on reconnect', async () => {
    const preview = terminal();
    await connect();
    const old = terminal();
    expect(opened).toHaveBeenCalledTimes(2);
    expect(old).not.toBe(preview);
    expect(disposed.mock.contexts).toContain(preview);
    expect(preview.element!.isConnected).toBe(false);
    expect(old.buffer.active.cursorX).toBe(0);
    expect(old.buffer.active.cursorY).toBe(0);
    expect(old.buffer.active.getLine(0)!.translateToString(true)).toBe('');
    await output('\x1b[2J\x1b[H\x1b[6 q\x1b[?1000h\x1b]10;#112233\x07old session');
    await expect.poll(() => old.element!.querySelector('.xterm-cursor-bar')).not.toBeNull();
    await output('\x1b[?25l');
    await expect.poll(() => old.element!.querySelector('.xterm-cursor')).toBeNull();
    expect(getComputedStyle(old.element!.querySelector('.xterm-rows')!).color).toBe('rgb(17, 34, 51)');

    // Even a programmatic duplicate submit must leave a live terminal untouched.
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTick();
    await new Promise<void>((resolve) => old.write('', resolve));
    expect(terminal()).toBe(old);
    expect(calls('ssh_connect')).toHaveLength(1);
    expect(old.modes.mouseTrackingMode).toBe('vt200');
    expect(old.buffer.active.getLine(0)!.translateToString(true)).toBe('old session');

    const oldLiveRegion = old.element!.querySelector('.live-region')!;
    await output(' pending announcement\x1b]0;unfinished title');
    reads.at(-1)!.resolve({ type: 'closed', error: null });
    await expect.element(page.getByRole('status')).toHaveTextContent('未连接');
    await connect();
    const fresh = terminal();
    expect(fresh).not.toBe(old);
    expect(opened).toHaveBeenCalledTimes(3);
    expect(disposed.mock.contexts).toContain(old);
    expect(old.element!.isConnected).toBe(false);
    expect(oldLiveRegion.isConnected).toBe(false);
    expect(fresh.options.cursorStyle).toBe('block');
    expect(fresh.options.cursorBlink).toBe(true);
    expect(fresh.modes.mouseTrackingMode).toBe('none');
    expect(getComputedStyle(fresh.element!.querySelector('.xterm-rows')!).color).toBe('rgb(220, 228, 239)');
    await output('\x1b[2J\x1b[Hfresh session');
    await expect.poll(() => fresh.element!.querySelector('.xterm-cursor-block.xterm-cursor-blink')).not.toBeNull();
    const liveRegion = fresh.element!.querySelector<HTMLElement>('.live-region')!;
    await expect.poll(() => liveRegion.textContent).toContain('fresh session');
    expect(liveRegion.textContent).not.toContain('old session');
    expect(liveRegion.textContent).not.toContain('pending announcement');
    expect(fresh.buffer.active.getLine(0)!.translateToString(true)).toBe('fresh session');
    const writes = calls('ssh_write').length;
    old.input('orphaned input');
    await Promise.resolve();
    expect(calls('ssh_write')).toHaveLength(writes);
    expect(calls('ssh_connect')[1]![1]).toMatchObject({ size: { cols: fresh.cols, rows: fresh.rows } });
  });

  it('starts fresh after a failed connection and ignores duplicate submits while connecting', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('authentication failed'));
    await page.getByLabelText('密码', { exact: true }).fill('test-only');
    await page.getByRole('button', { name: '连接 SSH' }).click();
    await expect.element(page.getByRole('alert')).toHaveTextContent('authentication failed');
    // The alert must stay above the workspace so a small window still shows it.
    expect(host.querySelector('[role="alert"]')!.nextElementSibling).toBe(host.querySelector('.workspace'));
    const failed = terminal();
    const result = deferred<number>();
    vi.mocked(invoke).mockImplementationOnce(() => result.promise);
    await page.getByLabelText('密码', { exact: true }).fill('test-only');
    // The next mount must measure the new layout before ssh_connect reads its size.
    host.querySelector('main')!.style.maxWidth = '1000px';
    const form = host.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await expect.element(page.getByRole('status')).toHaveTextContent('正在连接…');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(opened).toHaveBeenCalledTimes(3);
    expect(terminal()).not.toBe(failed);
    expect(terminal().cols).toBeLessThan(failed.cols);
    expect(disposed.mock.contexts).toContain(failed);
    expect(calls('ssh_connect')).toHaveLength(2);
    result.resolve(2);
    await expect.element(page.getByRole('status')).toHaveTextContent('已连接');
    expect(calls('ssh_connect')[1]![1]).toMatchObject({ size: { cols: terminal().cols, rows: terminal().rows } });
    await expect.poll(() => document.activeElement).toBe(terminal().textarea);
    await expect.element(page.getByLabelText('密码', { exact: true })).toHaveValue('');
  });
});

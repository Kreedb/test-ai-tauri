import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type {} from '@vitest/browser-playwright';
import { createApp, nextTick } from 'vue';
import { Terminal } from '@xterm/xterm';
import { invoke } from '@tauri-apps/api/core';
import App from './App.vue';
import type { TerminalEvent, TerminalSize } from './domain/terminal';
import { settingsKey } from './platform/settingsStorage';
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
// Snapshot the terminal size when each connect is issued: the pane can refit again
// after the call, and ssh_resize forwards that later size to the server.
const connectSizes: TerminalSize[] = [];
const terminal = () => opened.mock.contexts.at(-1) as Terminal;
const recordConnectSize = () => connectSizes.push({ cols: terminal().cols, rows: terminal().rows });

beforeEach(async () => {
  localStorage.removeItem(settingsKey);
  reads = [];
  connectSizes.length = 0;
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
    if (command === 'ssh_connect') {
      recordConnectSize();
      return calls('ssh_connect').length;
    }
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
  localStorage.removeItem(settingsKey);
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
  it('applies and persists settings without restarting a live terminal, using SSH options on reconnect', async () => {
    await connect();
    await output('retained output');
    const term = terminal();
    const cols = term.cols;
    await page.getByRole('button', { name: '工作区设置' }).click();
    await page.getByLabelText('界面主题').selectOptions('light');
    await page.getByLabelText('强调色').selectOptions('blue');
    await page.getByLabelText('字号（px）').fill('20');
    await page.getByLabelText('行高', { exact: true }).fill('1.3');
    await page.getByLabelText('回滚行数').fill('4000');
    await page.getByLabelText('光标样式').selectOptions('bar');
    await page.getByLabelText('终端配色').selectOptions('paper');
    await page.getByLabelText('终端类型（TERM）').fill('vt100');
    await page.getByLabelText('连接超时（秒）').fill('42');
    await page.getByLabelText('保活间隔（秒）').fill('0');
    await page.getByLabelText('无数据超时（秒）').fill('0');
    await page.getByRole('button', { name: '应用设置' }).click();
    expect(host.querySelector('dialog')!.open).toBe(false);
    expect(terminal()).toBe(term);
    expect(calls('ssh_connect')).toHaveLength(1);
    expect(term.options).toMatchObject({ fontSize: 20, lineHeight: 1.3, scrollback: 4000, cursorStyle: 'bar' });
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('retained output');
    await expect.poll(() => term.cols).toBeLessThan(cols);
    await expect.poll(() => calls('ssh_resize').at(-1)?.[1]).toMatchObject({ size: { cols: term.cols, rows: term.rows } });
    expect(getComputedStyle(term.element!.querySelector('.xterm-rows')!).color).toBe('rgb(30, 41, 59)');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.accent).toBe('blue');
    const saved = localStorage.getItem(settingsKey)!;
    expect(JSON.parse(saved).ssh).toMatchObject({ term: 'vt100', connectTimeoutSecs: 42, keepaliveIntervalSecs: 0, inactivityTimeoutSecs: 0 });
    expect(saved).not.toContain('password');
    expect(saved).not.toContain('localhost');
    expect(saved).not.toContain('ignoreHostKey');

    await page.getByRole('button', { name: '断开连接' }).click();
    await connect();
    expect(calls('ssh_connect')[1]![1]).toMatchObject({ request: { options: JSON.parse(saved).ssh } });
    expect(terminal().options.fontSize).toBe(20);
    app.unmount();
    app = createApp(App);
    app.mount(host);
    await nextTick();
    expect(terminal().options.fontSize).toBe(20);
    await expect.element(page.getByLabelText('密码', { exact: true })).toHaveValue('');
    await expect.element(page.getByLabelText('忽略主机指纹（不安全）')).not.toBeChecked();
  });

  it('keeps edits as a draft, restores focus on Escape, and applies defaults only on confirmation', async () => {
    const trigger = page.getByRole('button', { name: '工作区设置' });
    await trigger.click();
    await page.getByLabelText('字号（px）').fill('24');
    await userEvent.keyboard('{Escape}');
    expect(host.querySelector('dialog')!.open).toBe(false);
    expect(terminal().options.fontSize).toBe(14);
    expect(localStorage.getItem(settingsKey)).toBeNull();
    await expect.element(trigger).toHaveFocus();
    await trigger.click();
    await expect.element(page.getByLabelText('字号（px）')).toHaveValue(14);
    await page.getByLabelText('字号（px）').fill('20');
    await page.getByRole('button', { name: '应用设置' }).click();
    await trigger.click();
    await page.getByRole('button', { name: '恢复默认' }).click();
    expect(terminal().options.fontSize).toBe(20);
    await page.getByRole('button', { name: '应用设置' }).click();
    expect(terminal().options.fontSize).toBe(14);
  });

  it('preserves the current draft on invalid import and omits credentials from exported settings', async () => {
    await page.getByRole('button', { name: '工作区设置' }).click();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    async function upload(value: string) {
      const files = new DataTransfer();
      files.items.add(new File([value], 'settings.json', { type: 'application/json' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await nextTick();
    }
    await page.getByLabelText('字号（px）').fill('18');
    await upload('{"version":1,"terminal":{"fontSize":99}}');
    await expect.poll(() => host.querySelector('[role="alert"]')?.textContent).toContain('fontSize');
    await expect.element(page.getByLabelText('字号（px）')).toHaveValue(18);
    await upload('{"version":1,"terminal":{"fontSize":16},"password":"test-only","ignoreHostKey":true}');
    await expect.element(page.getByLabelText('字号（px）')).toHaveValue(16);
    expect(terminal().options.fontSize).toBe(14);
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await page.getByRole('button', { name: '导出配置' }).click();
    const blob = createUrl.mock.calls[0]![0] as Blob;
    const exported = await blob.text();
    expect(JSON.parse(exported).terminal.fontSize).toBe(16);
    expect(exported).not.toContain('password');
    expect(exported).not.toContain('ignoreHostKey');
    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/^ssh-terminal-settings-\d{4}-.*\.json$/);
    await page.getByRole('button', { name: '应用设置' }).click();
    expect(terminal().options.fontSize).toBe(16);
  });

  it('reports unavailable persistence while keeping applied settings usable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    await page.getByRole('button', { name: '工作区设置' }).click();
    await page.getByLabelText('字号（px）').fill('18');
    await page.getByRole('button', { name: '应用设置' }).click();
    expect(terminal().options.fontSize).toBe(18);
    await expect.poll(() => host.querySelector('[role="alert"]')?.textContent).toContain('无法保存到本地');
  });

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
    expect(connectSizes).toHaveLength(2);
    expect(calls('ssh_connect')[1]![1]).toMatchObject({ size: connectSizes[1]! });
  });

  it('starts fresh after a failed connection and ignores duplicate submits while connecting', async () => {
    vi.mocked(invoke).mockImplementationOnce(() => {
      recordConnectSize();
      return Promise.reject(new Error('authentication failed'));
    });
    await page.getByLabelText('密码', { exact: true }).fill('test-only');
    await page.getByRole('button', { name: '连接 SSH' }).click();
    await expect.element(page.getByRole('alert')).toHaveTextContent('authentication failed');
    // The alert must stay above the workspace so a small window still shows it.
    expect(host.querySelector('[role="alert"]')!.nextElementSibling).toBe(host.querySelector('.workspace'));
    const failed = terminal();
    const result = deferred<number>();
    vi.mocked(invoke).mockImplementationOnce(() => {
      recordConnectSize();
      return result.promise;
    });
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
    expect(calls('ssh_connect')[1]![1]).toMatchObject({ size: connectSizes[1]! });
    expect(connectSizes[1]!.cols).toBeLessThan(failed.cols);
    await expect.poll(() => document.activeElement).toBe(terminal().textarea);
    await expect.element(page.getByLabelText('密码', { exact: true })).toHaveValue('');
  });
});

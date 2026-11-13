import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings, serializeSettings, validateSettings } from './settings';
import { loadSettings, saveSettings } from '../platform/settingsStorage';

describe('settings boundary and storage', () => {
  it('round-trips custom settings and fills omitted fields from defaults', () => {
    const settings = defaultSettings();
    settings.appearance.theme = 'system';
    settings.terminal.fontSize = 20;
    settings.terminal.lineHeight = 1.3;
    settings.terminal.fontFamily = '"霞鹜文楷等宽", Consolas, monospace';
    settings.ssh.term = 'vt100';
    settings.ssh.keepaliveIntervalSecs = 0;
    settings.ssh.inactivityTimeoutSecs = 0;
    expect(parseSettings(serializeSettings(settings))).toEqual(settings);
    expect(parseSettings('{"version":1,"terminal":{"fontSize":20}}')).toEqual({
      ...defaultSettings(), terminal: { ...defaultSettings().terminal, fontSize: 20 },
    });
  });

  it.each([
    null,
    [],
    { version: 2 },
    { version: 1, terminal: [] },
    { version: 1, appearance: { theme: 'unknown' } },
    { version: 1, terminal: { fontSize: '16' } },
    { version: 1, terminal: { fontSize: 29 } },
    { version: 1, terminal: { lineHeight: 1.05 } },
    { version: 1, terminal: { scrollback: Infinity } },
    { version: 1, terminal: { cursorBlink: 'false' } },
    { version: 1, terminal: { background: 'url(example.com)' } },
    { version: 1, terminal: { fontFamily: 'bad\nfont' } },
    { version: 1, terminal: { background: '#123456\n' } },
    { version: 1, terminal: { fontFamily: 'monospace\n' } },
    { version: 1, terminal: { fontFamily: 'monospace;} .error {display:none} /*' } },
    { version: 1, terminal: { fontFamily: 'monospace; background: url(https://example.com)' } },
    { version: 1, ssh: { term: 'xterm;sh' } },
    { version: 1, ssh: { term: 'xterm\n' } },
    { version: 1, ssh: { connectTimeoutSecs: 0 } },
    { version: 1, ssh: { keepaliveMax: 11 } },
    { version: 1, ssh: { keepaliveMax: 1.00000001 } },
    { version: 1, ssh: { inactivityTimeoutSecs: 86401 } },
  ])('rejects invalid configuration without coercing values: %j', (value) => {
    expect(() => validateSettings(value)).toThrow();
  });

  it('rejects broken or oversized JSON and strips unknown fields including credentials', () => {
    expect(() => parseSettings('{')).toThrow();
    expect(() => parseSettings(' '.repeat(32769))).toThrow('32 KB');
    const settings = parseSettings(JSON.stringify({
      ...defaultSettings(),
      password: 'test-only', host: 'secret-host', ignoreHostKey: true,
      ssh: { ...defaultSettings().ssh, password: 'test-only', ignoreHostKey: true },
      terminal: { ...defaultSettings().terminal, password: 'test-only' },
    }));
    const exported = serializeSettings(settings);
    expect(exported).not.toContain('password');
    expect(exported).not.toContain('secret-host');
    expect(exported).not.toContain('ignoreHostKey');
    expect(settings).toEqual(defaultSettings());
  });

  it('stores only validated settings and preserves unreadable storage for recovery', () => {
    let data: string | null = null;
    const storage = { getItem: () => data, setItem: (_key: string, value: string) => { data = value; } };
    expect(loadSettings(storage)).toEqual(defaultSettings());
    const settings = defaultSettings();
    settings.terminal.scrollback = 0;
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
    data = '{broken';
    expect(() => loadSettings(storage)).toThrow();
    expect(data).toBe('{broken');
    expect(() => saveSettings(settings, { setItem: () => { throw new Error('quota exceeded'); } })).toThrow('quota exceeded');
  });
});

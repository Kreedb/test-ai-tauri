import type { ConnectionOptions } from './terminal';

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  screenReaderMode: boolean;
  palette: 'midnight' | 'paper' | 'custom';
  background: string;
  foreground: string;
  cursor: string;
}

export interface Settings {
  version: 1;
  appearance: {
    theme: 'dark' | 'light' | 'system';
    accent: 'mint' | 'blue' | 'violet';
    density: 'comfortable' | 'compact';
    sidebarWidth: number;
  };
  terminal: TerminalSettings;
  ssh: ConnectionOptions;
}

export const limits = {
  sidebarWidth: { min: 280, max: 420, step: 10 },
  fontSize: { min: 10, max: 28, step: 1 },
  lineHeight: { min: 1, max: 2, step: 0.1 },
  scrollback: { min: 0, max: 50000, step: 1 },
  connectTimeoutSecs: { min: 1, max: 120, step: 1 },
  keepaliveIntervalSecs: { min: 0, max: 300, step: 1 },
  keepaliveMax: { min: 1, max: 10, step: 1 },
  inactivityTimeoutSecs: { min: 0, max: 86400, step: 1 },
} as const;

export const palettes = {
  midnight: { background: '#10151e', foreground: '#dce4ef', cursor: '#7dd3c0' },
  paper: { background: '#f8fafc', foreground: '#1e293b', cursor: '#0f766e' },
} as const;

export function terminalColors(settings: TerminalSettings) {
  return settings.palette === 'custom'
    ? { background: settings.background, foreground: settings.foreground, cursor: settings.cursor }
    : palettes[settings.palette];
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    appearance: { theme: 'dark', accent: 'mint', density: 'comfortable', sidebarWidth: 320 },
    terminal: {
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1,
      scrollback: 3000,
      cursorStyle: 'block',
      cursorBlink: true,
      screenReaderMode: true,
      palette: 'midnight',
      ...palettes.midnight,
    },
    ssh: {
      term: 'xterm-256color',
      connectTimeoutSecs: 15,
      keepaliveIntervalSecs: 30,
      keepaliveMax: 3,
      inactivityTimeoutSecs: 120,
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function choice<T extends string>(value: unknown, fallback: T, choices: readonly T[]): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`选项必须是：${choices.join('、')}`);
  return value as T;
}

function number(value: unknown, fallback: number, key: keyof typeof limits): number {
  if (value === undefined) return fallback;
  const { min, max, step } = limits[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (step >= 1 && !Number.isInteger(value))
    || Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-7) {
    throw new Error(`${key} 必须在 ${min}–${max} 之间，步长为 ${step}`);
  }
  return value;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('开关必须是 true 或 false');
  return value;
}

function text(value: unknown, fallback: string, pattern: RegExp, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || !pattern.test(value)) throw new Error(`${label}格式不正确`);
  return value;
}

// Reconstruct known fields so imported or stored data cannot carry credentials into exports.
export function validateSettings(value: unknown): Settings {
  const root = object(value);
  if (root.version !== 1) throw new Error('不支持的配置版本，需要 version: 1');
  const a = object(root.appearance);
  const t = object(root.terminal);
  const s = object(root.ssh);
  const defaults = defaultSettings();
  return {
    version: 1,
    appearance: {
      theme: choice(a.theme, defaults.appearance.theme, ['dark', 'light', 'system']),
      accent: choice(a.accent, defaults.appearance.accent, ['mint', 'blue', 'violet']),
      density: choice(a.density, defaults.appearance.density, ['comfortable', 'compact']),
      sidebarWidth: number(a.sidebarWidth, defaults.appearance.sidebarWidth, 'sidebarWidth'),
    },
    terminal: {
      // xterm interpolates this into a stylesheet, so admit font lists, not CSS declarations.
      fontFamily: text(t.fontFamily, defaults.terminal.fontFamily, /^(?=\S)[\p{L}\p{N} _,.'"-]{1,200}$/u, '字体'),
      fontSize: number(t.fontSize, defaults.terminal.fontSize, 'fontSize'),
      lineHeight: number(t.lineHeight, defaults.terminal.lineHeight, 'lineHeight'),
      scrollback: number(t.scrollback, defaults.terminal.scrollback, 'scrollback'),
      cursorStyle: choice(t.cursorStyle, defaults.terminal.cursorStyle, ['block', 'underline', 'bar']),
      cursorBlink: boolean(t.cursorBlink, defaults.terminal.cursorBlink),
      screenReaderMode: boolean(t.screenReaderMode, defaults.terminal.screenReaderMode),
      palette: choice(t.palette, defaults.terminal.palette, ['midnight', 'paper', 'custom']),
      background: text(t.background, defaults.terminal.background, /^#[\da-fA-F]{6}$/, '背景颜色'),
      foreground: text(t.foreground, defaults.terminal.foreground, /^#[\da-fA-F]{6}$/, '文字颜色'),
      cursor: text(t.cursor, defaults.terminal.cursor, /^#[\da-fA-F]{6}$/, '光标颜色'),
    },
    ssh: {
      term: text(s.term, defaults.ssh.term, /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/, 'TERM'),
      connectTimeoutSecs: number(s.connectTimeoutSecs, defaults.ssh.connectTimeoutSecs, 'connectTimeoutSecs'),
      keepaliveIntervalSecs: number(s.keepaliveIntervalSecs, defaults.ssh.keepaliveIntervalSecs, 'keepaliveIntervalSecs'),
      keepaliveMax: number(s.keepaliveMax, defaults.ssh.keepaliveMax, 'keepaliveMax'),
      inactivityTimeoutSecs: number(s.inactivityTimeoutSecs, defaults.ssh.inactivityTimeoutSecs, 'inactivityTimeoutSecs'),
    },
  };
}

export function parseSettings(json: string): Settings {
  if (json.length > 32768) throw new Error('配置文件不能超过 32 KB');
  return validateSettings(JSON.parse(json));
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify(validateSettings(settings), null, 2);
}

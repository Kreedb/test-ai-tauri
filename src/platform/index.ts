import { isTauri } from '@tauri-apps/api/core';
import { tauriTransport } from './tauri';
import { webTransport } from './web';

export const terminalTransport = isTauri() ? tauriTransport : webTransport;

import { defaultSettings, parseSettings, serializeSettings, type Settings } from '../domain/settings';

export const settingsKey = 'tauri-ssh.settings.v1';

export function loadSettings(storage: Pick<Storage, 'getItem'> = localStorage): Settings {
  const saved = storage.getItem(settingsKey);
  return saved === null ? defaultSettings() : parseSettings(saved);
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(settingsKey, serializeSettings(settings));
}

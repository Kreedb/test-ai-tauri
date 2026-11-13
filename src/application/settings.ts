import { ref } from 'vue';
import { defaultSettings, validateSettings, type Settings } from '../domain/settings';
import { loadSettings, saveSettings } from '../platform/settingsStorage';

export function useSettings() {
  const settings = ref(defaultSettings());
  const storageError = ref('');
  try {
    settings.value = loadSettings();
  } catch {
    storageError.value = '无法读取本地配置，已使用默认值；原配置尚未覆盖。';
  }

  function applySettings(value: Settings) {
    settings.value = validateSettings(value);
    try {
      saveSettings(settings.value);
      storageError.value = '';
    } catch {
      storageError.value = '配置已在本次运行生效，但无法保存到本地；请导出配置以保留修改。';
    }
  }

  return { settings, storageError, applySettings };
}

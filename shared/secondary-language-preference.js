import { SUPPORTED_LANGUAGES } from '../content/system/config/config-schema.js';

// UI 便利資訊，不是設定：不可加入 schema、備份或 CONFIG_CHANGED 投影。
export const LAST_MANUAL_SECONDARY_LANGUAGE_KEY = 'subpalLastManualSecondaryLanguage';

export function normalizeLastManualSecondaryLanguage(value) {
  return SUPPORTED_LANGUAGES.some(language => language.code === value) ? value : 'en';
}

export function renderLastManualSecondaryLanguage(element, configuredLanguage, lastManualLanguage) {
  if (!element) return;
  const language = normalizeLastManualSecondaryLanguage(lastManualLanguage);
  element.hidden = configuredLanguage !== 'auto';
  element.textContent = `上次手動語言：${SUPPORTED_LANGUAGES.find(item => item.code === language)?.name || language}`;
}

// storage 只由 extension 頁面／isolated owner 注入；MAIN 僅能經唯讀 capability 取得值。
export function createSecondaryLanguagePreference(storage) {
  const preference = {
    async read() {
      const stored = await storage.get(LAST_MANUAL_SECONDARY_LANGUAGE_KEY);
      return normalizeLastManualSecondaryLanguage(stored[LAST_MANUAL_SECONDARY_LANGUAGE_KEY]);
    },
    async change(currentLanguage, nextLanguage, writeLanguage) {
      // manual 是 UI 的「恢復上次語言」動作，永不寫入公開設定。
      const language = nextLanguage === 'manual' ? await preference.read() : nextLanguage;
      if (language !== 'auto' && !SUPPORTED_LANGUAGES.some(item => item.code === language)) {
        throw new Error('invalid secondary language');
      }
      if (language === 'auto' && currentLanguage !== 'auto') {
        await storage.set({ [LAST_MANUAL_SECONDARY_LANGUAGE_KEY]: normalizeLastManualSecondaryLanguage(currentLanguage) });
      }
      if (language !== 'auto') await storage.set({ [LAST_MANUAL_SECONDARY_LANGUAGE_KEY]: language });
      await writeLanguage(language);
      return language;
    }
  };
  return Object.freeze(preference);
}

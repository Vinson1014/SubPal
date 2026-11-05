import { SUPPORTED_LANGUAGES } from '../content/system/config/config-schema.js';
import { normalizeSubtitleLanguage } from './secondary-track-selection.js';

// 非設定的最後播放狀態：不加入 schema、備份或 CONFIG_CHANGED。
export const SECONDARY_RUNTIME_STATUS_KEY = 'subpalSecondaryRuntimeStatus';
const OBJECT_SOURCE = Function.prototype.toString.call(Object);

function ownRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
      if (!constructor || !Object.hasOwn(constructor, 'value') || typeof constructor.value !== 'function' ||
          Object.getOwnPropertyDescriptor(constructor.value, 'prototype')?.value !== prototype ||
          Function.prototype.toString.call(constructor.value) !== OBJECT_SOURCE) return null;
    }
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

export function parseSecondaryRuntimeStatus(input) {
  const value = ownRecord(input, ['videoId', 'effectiveLanguage', 'quality', 'status', 'reason', 'isManualFallback', 'updatedAt']);
  const quality = value && ownRecord(value.quality, ['isCC', 'degraded']);
  if (!value || !quality || typeof value.videoId !== 'string' || !value.videoId || value.videoId.length > 128 ||
      (value.effectiveLanguage !== null && !normalizeSubtitleLanguage(value.effectiveLanguage)) ||
      typeof quality.isCC !== 'boolean' || typeof quality.degraded !== 'boolean' ||
      !['resolving', 'ready', 'missing', 'unknown', 'ambiguous', 'unavailable', 'manual'].includes(value.status) ||
      typeof value.reason !== 'string' || !/^[a-z0-9-]{1,128}$/.test(value.reason) ||
      typeof value.isManualFallback !== 'boolean' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return null;
  try {
    if (typeof structuredClone === 'function') structuredClone(input);
    return { ...value, quality };
  } catch {
    return null;
  }
}

export async function readSecondaryRuntimeStatus(storage) {
  try {
    const stored = await storage.get(SECONDARY_RUNTIME_STATUS_KEY);
    return parseSecondaryRuntimeStatus(stored[SECONDARY_RUNTIME_STATUS_KEY]);
  } catch {
    // 狀態僅供參考；擴充重載／storage 失敗時由 UI 顯示設定值。
    return null;
  }
}

function languageName(value) {
  const code = normalizeSubtitleLanguage(value);
  if (!code) return null;
  return SUPPORTED_LANGUAGES.find(item => normalizeSubtitleLanguage(item.code) === code)?.name ||
    SUPPORTED_LANGUAGES.find(item => item.code.split('-')[0] === code.split('-')[0])?.name || value;
}

export function formatSecondaryRuntimeStatus(configuredLanguage, input) {
  const autoLabel = '自動（跟隨影片原始語言）';
  if (configuredLanguage !== 'auto') return `手動：${languageName(configuredLanguage) || '未設定'}`;
  const snapshot = parseSecondaryRuntimeStatus(input);
  if (!snapshot || snapshot.status === 'manual') return autoLabel;
  const language = languageName(snapshot.effectiveLanguage);
  const quality = [snapshot.quality.isCC ? 'CC' : null, snapshot.quality.degraded ? '降級' : null].filter(Boolean);
  if (snapshot.status === 'ready' && snapshot.reason === 'same-primary-track') quality.push('與主要字幕同軌，已省略');
  const suffix = quality.length ? `（${quality.join('、')}）` : '';
  if (snapshot.isManualFallback && language) {
    return `自動：目前無法讀取原始語言；使用上次手動語言：${language}${suffix}${snapshot.status === 'ready' ? '' : '（字幕尚未就緒）'}`;
  }
  switch (snapshot.status) {
    case 'resolving': return '自動：解析中…';
    case 'ready': return language ? `自動：${language}${suffix}` : autoLabel;
    case 'missing': return `自動：此影片沒有${language || '原始語言'}字幕`;
    case 'unknown': return '自動：無法判斷原始語言';
    case 'ambiguous': return '自動：此影片有多種原始語言';
    case 'unavailable': return language ? `自動：無法取得${language}字幕` : '自動：目前無法讀取原始語言';
    default: return autoLabel;
  }
}

const pendingDisplays = new WeakMap();

export async function updateSecondaryRuntimeStatus(element, configuredLanguage, storage) {
  if (!element) return;
  const request = {};
  pendingDisplays.set(element, request);
  element.textContent = formatSecondaryRuntimeStatus(configuredLanguage, null);
  if (configuredLanguage !== 'auto') return;
  const snapshot = await readSecondaryRuntimeStatus(storage);
  // 設定已切回手動時，不能被晚到的自動模式讀取覆蓋。
  if (pendingDisplays.get(element) === request) element.textContent = formatSecondaryRuntimeStatus(configuredLanguage, snapshot);
}

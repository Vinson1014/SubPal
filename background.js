// background.js - 用於跨模組消息與全局狀態管理
// 使用 chrome.runtime.connect 處理 content script 消息以提高穩定性

// 全局未處理的 Promise Rejection 監聽器
self.addEventListener('unhandledrejection', function(event) {
  console.error('[Background] Unhandled Promise Rejection:', event.reason);
  // 考慮記錄更詳細的錯誤信息，例如 event.reason.stack
  if (event.reason && event.reason.stack) {
    console.error('[Background] Stack trace:', event.reason.stack);
  }
});

// Service Worker 實例 ID，僅用於本次執行期的日誌關聯
const serviceWorkerInstanceId = `sw-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
console.log(`[Background] Service Worker script executing. Current Instance ID: ${serviceWorkerInstanceId}`);

import * as apiModule from './background/api.js';
import * as syncModule from './background/sync.js';
import './background/sync-listener.js'; // 載入同步監聽器，自動註冊 storage 變化監聽
import {
  activateBackendProfile,
  createBackendProfile,
  deleteBackendProfile,
  exportBackendProfileQueue,
  listBackendProfiles,
  resolveBackendProfile,
  setBackendProfileCredentials
} from './background/backend-profiles.js';
import { ensureStorageMigrationsComplete } from './background/storage-migrations.js';
import {
  enqueueContribution,
  getContributionProjection,
  parseContributionIntent,
  retryContribution,
  retryFailedContributions
} from './background/contribution-queue.js';

let lifecycleInitialization;

function initializeLifecycle() {
  if (!lifecycleInitialization) {
    lifecycleInitialization = (async () => {
      await ensureStorageMigrationsComplete();
      await ensureUserRegisteredAndJwtPresent();
      await syncModule.initializeSync();
    })().finally(() => {
      lifecycleInitialization = null;
    });
  }
  return lifecycleInitialization;
}

// 擴充功能安裝/更新事件
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[Background] onInstalled event. Instance ID: ${serviceWorkerInstanceId}. 字幕助手擴充功能已安裝或更新`);

  try {
    await initializeLifecycle();
  } catch (error) {
    console.error('[Background] Lifecycle initialization failed:', error);
    throw error;
  }
  
  // 檢查是否需要顯示教學頁面
  if (details.reason === 'install') {
    await showTutorialIfNeeded();
  }
});

/**
 * 檢查是否需要顯示教學頁面，如果是首次安裝且未完成教學則顯示
 */
async function showTutorialIfNeeded() {
  try {
    const result = await chrome.storage.local.get(['tutorialCompleted']);
    if (!result.tutorialCompleted) {
      // 首次安裝且未完成教學，打開教學頁面
      console.log('[Background] Opening tutorial page for new installation');
      const tutorialUrl = chrome.runtime.getURL('tutorial.html');
      await chrome.tabs.create({
        url: tutorialUrl,
        active: true
      });
      console.log('[Background] Tutorial page opened successfully');
    } else {
      console.log('[Background] Tutorial already completed, skipping');
    }
  } catch (error) {
    console.error('[Background] Error checking tutorial status or opening tutorial page:', error);
  }
}

// 擴充功能啟動事件
chrome.runtime.onStartup.addListener(async () => {
  console.log(`[Background] onStartup event. Instance ID: ${serviceWorkerInstanceId}. Extension startup, triggering initialization.`);

  try {
    await initializeLifecycle();
  } catch (error) {
    console.error('[Background] Lifecycle initialization failed:', error);
    throw error;
  }
});

/**
 * 確保用戶已註冊並存在 JWT
 */
async function ensureUserRegisteredAndJwtPresent() {
  console.log('[Background] Checking user registration and JWT presence...');
  const profile = await resolveBackendProfile(chrome.storage.local);
  if (profile.jwt) return;
  const response = await apiModule.registerUser(profile.userId, profile.id);
  if (!response?.token) throw new Error(response?.error || 'User registration returned no token');
  await setBackendProfileCredentials(chrome.storage.local, profile.id, { jwt: response.token });
  console.log('[Background] Successfully registered user and obtained JWT.');
}

// 儲存 content script 的 port，以 tabId 為鍵
const contentScriptPorts = new Map();
const BACKEND_PROFILE_COMMANDS = new Set([
  'BACKEND_PROFILES_LIST',
  'BACKEND_PROFILES_CREATE',
  'BACKEND_PROFILES_ACTIVATE',
  'BACKEND_PROFILES_DELETE',
  'BACKEND_PROFILES_EXPORT_QUEUE',
  'BACKEND_PROFILES_RETRY_FAILED'
]);
const CONTRIBUTION_ENQUEUE_COMMAND = 'CONTRIBUTION_ENQUEUE';
const CONTRIBUTION_READ_COMMAND = 'CONTRIBUTION_READ';
const CONTRIBUTION_RETRY_COMMAND = 'CONTRIBUTION_RETRY';
const CONTRIBUTION_READ_VARIANTS = new Set(['vote-authority', 'translation-reconciliation']);

function profileFailure(kind, code) {
  return { ok: false, error: { kind, code, retryable: false } };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strictOwnDataRecord(value, expectedKeys) {
  try {
    if (!isRecord(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return null;
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 || keys.length !== expectedKeys.length ||
        keys.some((key) => !expectedKeys.includes(key))) return null;
    const result = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function strictOwnDataArray(value) {
  try {
    if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length !== value.length + 1 || !keys.includes('length') ||
        keys.some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return null;
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

function readPortRequest(messageData) {
  let messageId;
  try {
    if (!isRecord(messageData)) return { messageId, valid: false };
    messageId = messageData.messageId;
    const message = messageData.message;
    if (!isRecord(message) || typeof message.type !== 'string') return { messageId, valid: false };
    return { messageId, message, type: message.type, valid: true };
  } catch {
    return { messageId, valid: false };
  }
}

function isBackendProfileCommand(type) {
  return BACKEND_PROFILE_COMMANDS.has(type);
}

function isTrustedOptionsSender(port) {
  try {
    if (port?.name !== 'options-page-channel') return false;
    const sender = port.sender;
    const optionsUrl = chrome.runtime.getURL('options.html');
    const parsedOptionsUrl = new URL(optionsUrl);
    const optionsOrigin = parsedOptionsUrl.origin === 'null'
      ? optionsUrl.slice(0, optionsUrl.indexOf('/', optionsUrl.indexOf('//') + 2))
      : parsedOptionsUrl.origin;
    const senderTab = sender.tab;
    return isRecord(sender) &&
      sender.id === chrome.runtime.id &&
      (senderTab === undefined || (isRecord(senderTab) && senderTab.url === optionsUrl)) &&
      sender.url === optionsUrl &&
      (sender.origin === undefined || sender.origin === optionsOrigin);
  } catch {
    return false;
  }
}

function isHttpsNetflixUrl(value) {
  try {
    const { hostname, protocol } = new URL(value);
    return protocol === 'https:' && (hostname === 'netflix.com' || hostname.endsWith('.netflix.com'));
  } catch {
    return false;
  }
}

function isTrustedContributionPort(port) {
  try {
    const sender = port?.sender;
    const tab = sender?.tab;
    const senderUrl = new URL(sender?.url);
    const tabUrl = new URL(tab?.url);
    return port?.name === 'subtitle-assistant-channel' &&
      sender?.id === chrome.runtime.id &&
      Number.isInteger(tab?.id) && tab.id >= 0 &&
      isHttpsNetflixUrl(sender.url) && isHttpsNetflixUrl(tab.url) &&
      sender.url === tab.url && sender.origin === senderUrl.origin && senderUrl.origin === tabUrl.origin;
  } catch {
    return false;
  }
}

function contributionFailure(kind, code, retryable = false) {
  return { ok: false, error: { kind, code, retryable } };
}

function parseContributionRequest(request) {
  try {
    if (!isRecord(request)) return null;
    const keys = Object.getOwnPropertyNames(request);
    if (Object.getOwnPropertySymbols(request).length !== 0 || keys.length !== 2 || !keys.includes('type') || !keys.includes('intent')) return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(request, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
    }
    if (request.type !== CONTRIBUTION_ENQUEUE_COMMAND) return null;
    const intent = parseContributionIntent(request.intent);
    return intent ? { intent: request.intent } : null;
  } catch {
    return null;
  }
}

async function handleContributionPortRequest(messageId, request, port) {
  if (!isTrustedContributionPort(port)) {
    port.postMessage({ messageId, response: contributionFailure('forbidden', 'contribution-port-access') });
    return;
  }
  const parsed = parseContributionRequest(request);
  if (!parsed) {
    port.postMessage({ messageId, response: contributionFailure('invalid', 'contribution-input') });
    return;
  }
  try {
    await ensureStorageMigrationsComplete(chrome.storage.local);
    const value = await enqueueContribution(chrome.storage.local, parsed.intent);
    port.postMessage({ messageId, response: { ok: true, value } });
  } catch (error) {
    const code = error?.message === 'Invalid active backend profile'
      ? 'profile-unavailable'
      : error?.message === 'Invalid contribution intent'
        ? 'contribution-input'
        : 'local-persistence-failed';
    port.postMessage({ messageId, response: contributionFailure('domain-rejected', code, code === 'local-persistence-failed') });
  }
}

function parseContributionReadRequest(request) {
  const envelope = strictOwnDataRecord(request, ['type', 'projection']);
  if (!envelope || envelope.type !== CONTRIBUTION_READ_COMMAND) return null;
  const projection = strictOwnDataRecord(envelope.projection, ['variant', 'payload']);
  if (!projection || !CONTRIBUTION_READ_VARIANTS.has(projection.variant)) return null;
  if (projection.variant === 'vote-authority') {
    const payload = strictOwnDataRecord(projection.payload, ['translationID']);
    return payload && typeof payload.translationID === 'string' && payload.translationID.length > 0
      ? { projection: { variant: projection.variant, payload } }
      : null;
  }
  const payload = strictOwnDataRecord(projection.payload, ['operationIds']);
  const operationIds = payload ? strictOwnDataArray(payload.operationIds) : null;
  if (!operationIds || operationIds.length > 100 || operationIds.some((operationId) => typeof operationId !== 'string' || !operationId) ||
      new Set(operationIds).size !== operationIds.length) return null;
  return { projection: { variant: projection.variant, payload: { operationIds } } };
}

function parseContributionRetryRequest(request) {
  const envelope = strictOwnDataRecord(request, ['type', 'operationId']);
  return envelope && envelope.type === CONTRIBUTION_RETRY_COMMAND && typeof envelope.operationId === 'string' && envelope.operationId.length > 0
    ? envelope
    : null;
}

async function handleContributionReadPortRequest(messageId, request, port) {
  if (!isTrustedContributionPort(port)) {
    port.postMessage({ messageId, response: contributionFailure('forbidden', 'contribution-port-access') });
    return;
  }
  const parsed = parseContributionReadRequest(request);
  if (!parsed) {
    port.postMessage({ messageId, response: contributionFailure('invalid', 'contribution-input') });
    return;
  }
  try {
    await ensureStorageMigrationsComplete(chrome.storage.local);
    const value = await getContributionProjection(chrome.storage.local, parsed.projection);
    port.postMessage({ messageId, response: { ok: true, value } });
  } catch (error) {
    const code = error?.message === 'Invalid active backend profile' ? 'profile-unavailable' : 'local-persistence-failed';
    port.postMessage({ messageId, response: contributionFailure('domain-rejected', code, code === 'local-persistence-failed') });
  }
}

async function handleContributionRetryPortRequest(messageId, request, port) {
  if (!isTrustedContributionPort(port)) {
    port.postMessage({ messageId, response: contributionFailure('forbidden', 'contribution-port-access') });
    return;
  }
  const parsed = parseContributionRetryRequest(request);
  if (!parsed) {
    port.postMessage({ messageId, response: contributionFailure('invalid', 'contribution-input') });
    return;
  }
  try {
    await ensureStorageMigrationsComplete(chrome.storage.local);
    const activeProfile = await resolveBackendProfile(chrome.storage.local);
    if (!activeProfile?.id) throw new Error('Active profile unavailable');
    try {
      await retryContribution(chrome.storage.local, parsed.operationId, activeProfile.id);
    } catch {
      port.postMessage({ messageId, response: contributionFailure('domain-rejected', 'operation-not-found') });
      return;
    }
    port.postMessage({ messageId, response: { ok: true, value: { retryScheduled: true, operationId: parsed.operationId } } });
  } catch {
    port.postMessage({ messageId, response: contributionFailure('domain-rejected', 'profile-unavailable') });
  }
}

function parseBackendProfileRequest(request) {
  try {
    const retryRequest = strictOwnDataRecord(request, ['type', 'profileId', 'confirmInactiveProfile']);
    if (retryRequest?.type === 'BACKEND_PROFILES_RETRY_FAILED') {
      return typeof retryRequest.profileId === 'string' && retryRequest.profileId.length > 0 &&
        typeof retryRequest.confirmInactiveProfile === 'boolean' ? retryRequest : null;
    }
    if (!isRecord(request) || !isBackendProfileCommand(request.type) || !Object.hasOwn(request, 'type')) return null;
    const keys = Object.keys(request);
    const hasOnly = (...allowed) => keys.every((key) => allowed.includes(key));
    const profileId = request.profileId;
    const validProfileId = typeof profileId === 'string' && profileId.length > 0;
    switch (request.type) {
      case 'BACKEND_PROFILES_LIST':
        return hasOnly('type') ? { type: request.type } : null;
      case 'BACKEND_PROFILES_CREATE':
        return hasOnly('type', 'endpoint') && Object.hasOwn(request, 'endpoint') && typeof request.endpoint === 'string'
          ? { type: request.type, endpoint: request.endpoint }
          : null;
      case 'BACKEND_PROFILES_ACTIVATE':
      case 'BACKEND_PROFILES_EXPORT_QUEUE':
        return hasOnly('type', 'profileId') && Object.hasOwn(request, 'profileId') && validProfileId
          ? { type: request.type, profileId }
          : null;
      case 'BACKEND_PROFILES_DELETE':
        return hasOnly('type', 'profileId', 'discard') && Object.hasOwn(request, 'profileId') && validProfileId &&
          (!Object.hasOwn(request, 'discard') || typeof request.discard === 'boolean')
          ? { type: request.type, profileId, discard: Object.hasOwn(request, 'discard') ? request.discard : false }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function handleBackendProfileRetryPortRequest(messageId, parsed, port) {
  try {
    const selectedProfile = await resolveBackendProfile(chrome.storage.local, parsed.profileId);
    const activeProfile = await resolveBackendProfile(chrome.storage.local);
    if (!selectedProfile?.id || selectedProfile.id !== parsed.profileId || !activeProfile?.id) {
      throw new Error('Profile unavailable');
    }
    if (selectedProfile.id !== activeProfile.id && !parsed.confirmInactiveProfile) {
      port.postMessage({ messageId, response: profileFailure('forbidden', 'profile-inactive-confirmation-required') });
      return;
    }
    const scheduled = await retryFailedContributions(chrome.storage.local, selectedProfile.id);
    const triggerWork = [];
    if (scheduled.vote > 0) triggerWork.push(syncModule.triggerVoteSync(selectedProfile.id));
    if (scheduled.translation > 0) triggerWork.push(syncModule.triggerTranslationSync(selectedProfile.id));
    if (scheduled.replacementEvent > 0) triggerWork.push(syncModule.triggerReplacementEventSync(selectedProfile.id));
    await Promise.all(triggerWork);
    port.postMessage({ messageId, response: { ok: true, value: { retryScheduled: true } } });
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const code = message === 'Profile unavailable' || message.startsWith('Unknown backend profile')
      ? 'profile-unavailable'
      : 'profile-retry-failed';
    port.postMessage({ messageId, response: profileFailure('domain-rejected', code) });
  }
}

function profileOperationFailure(type, error) {
  let message = '';
  try {
    message = typeof error?.message === 'string' ? error.message : '';
  } catch {
    return profileFailure('domain-rejected', 'profile-operation-failed');
  }
  if (type === 'BACKEND_PROFILES_CREATE' && message.includes('Invalid backend endpoint')) {
    return profileFailure('domain-rejected', 'unsafe-endpoint');
  }
  if (type === 'BACKEND_PROFILES_DELETE' && message.startsWith('Cannot delete')) {
    return profileFailure('domain-rejected', 'profile-delete-blocked');
  }
  if (message.startsWith('Unknown backend profile')) {
    return profileFailure('domain-rejected', 'profile-unavailable');
  }
  if (type === 'BACKEND_PROFILES_EXPORT_QUEUE' && message.includes('active profile')) {
    return profileFailure('forbidden', 'profile-export-not-active');
  }
  return profileFailure('domain-rejected', 'profile-operation-failed');
}

async function handleBackendProfilePortRequest(messageId, request, port) {
  if (!isTrustedOptionsSender(port)) {
    port.postMessage({ messageId, response: profileFailure('forbidden', 'options-profile-access') });
    return;
  }
  const parsed = parseBackendProfileRequest(request);
  if (!parsed) {
    port.postMessage({ messageId, response: profileFailure('invalid', 'profile-input') });
    return;
  }
  try {
    await ensureStorageMigrationsComplete(chrome.storage.local);
  } catch {
    port.postMessage({ messageId, response: profileFailure('domain-rejected', 'profile-migration-failed') });
    return;
  }
  try {
    let value;
    switch (parsed.type) {
      case 'BACKEND_PROFILES_LIST':
        value = await listBackendProfiles(chrome.storage.local);
        break;
      case 'BACKEND_PROFILES_CREATE':
        value = await createBackendProfile(chrome.storage.local, { endpoint: parsed.endpoint });
        break;
      case 'BACKEND_PROFILES_ACTIVATE':
        value = await activateBackendProfile(chrome.storage.local, parsed.profileId);
        break;
      case 'BACKEND_PROFILES_DELETE':
        value = await deleteBackendProfile(chrome.storage.local, parsed.profileId, { discard: parsed.discard });
        break;
      case 'BACKEND_PROFILES_EXPORT_QUEUE':
        value = await exportBackendProfileQueue(chrome.storage.local, parsed.profileId);
        break;
      case 'BACKEND_PROFILES_RETRY_FAILED':
        await handleBackendProfileRetryPortRequest(messageId, parsed, port);
        return;
    }
    port.postMessage({ messageId, response: { ok: true, value } });
  } catch (error) {
    port.postMessage({ messageId, response: profileOperationFailure(parsed.type, error) });
  }
}

// 監聽來自 content script 的長連接
chrome.runtime.onConnect.addListener((port) => {
  console.log(`[Background] Content script connected. Port name: ${port.name}`);
  // 根據 port.name 區分連接來源
  if (port.name === "subtitle-assistant-channel") {
    // 來自 content script 的連接
    const tabId = port.sender?.tab?.id;
    if (!tabId) {
      console.error('[Background] Received content script connection from unknown sender (no tabId).');
      port.disconnect();
      return;
    }
    console.log(`[Background] Storing content script port for tabId: ${tabId}`);
    contentScriptPorts.set(tabId, port);

    port.onMessage.addListener((messageData) => {
      const request = readPortRequest(messageData);
      console.log(`[Background] Message [${request?.type}] received by SW Instance ID: ${serviceWorkerInstanceId} via content script port from Tab ${tabId}`, messageData);
      if (!request.valid) {
        console.error('[Background] Invalid message format received via content script port:', messageData);
        port.postMessage({ response: { success: false, error: '無效的消息格式' } });
        return;
      }
      const { messageId, message, type } = request;
      if (isBackendProfileCommand(type)) {
        port.postMessage({ messageId, response: profileFailure('forbidden', 'page-profile-change') });
        return;
      }
      if (type === CONTRIBUTION_ENQUEUE_COMMAND) {
        void handleContributionPortRequest(messageId, message, port);
        return;
      }
      if (type === CONTRIBUTION_READ_COMMAND) {
        void handleContributionReadPortRequest(messageId, message, port);
        return;
      }
      if (type === CONTRIBUTION_RETRY_COMMAND) {
        void handleContributionRetryPortRequest(messageId, message, port);
        return;
      }
      routeMessageToModulePort(messageId, message, port);
    });

    port.onDisconnect.addListener(() => {
      console.log(`[Background] Content script port disconnected for tabId: ${tabId}`);
      contentScriptPorts.delete(tabId);
    });

  } else if (port.name === "options-page-channel") {
    // 來自 options 頁面的連接
    console.log('[Background] Options page connected.');
    // options 頁面不需要 tabId，因為它不是針對特定 tab 的
    // 可以將 options 頁面的 port 存儲在一個單獨的變量中，如果需要向其主動發送消息
    // 例如：optionsPagePort = port;

    port.onMessage.addListener((messageData) => {
      const request = readPortRequest(messageData);
      console.log(`[Background] Message [${request?.type}] received by SW Instance ID: ${serviceWorkerInstanceId} via options page port`, messageData);
      if (!request.valid) {
        console.error('[Background] Invalid message format received via options page port:', messageData);
        const response = isTrustedOptionsSender(port)
          ? profileFailure('invalid', 'profile-input')
          : profileFailure('forbidden', 'options-profile-access');
        port.postMessage({ messageId: request.messageId, response });
        return;
      }
      const { messageId, message, type } = request;
      if (type === CONTRIBUTION_READ_COMMAND || type === CONTRIBUTION_RETRY_COMMAND) {
        void (type === CONTRIBUTION_READ_COMMAND
          ? handleContributionReadPortRequest(messageId, message, port)
          : handleContributionRetryPortRequest(messageId, message, port));
        return;
      }
      if (isBackendProfileCommand(type)) {
        void handleBackendProfilePortRequest(messageId, message, port);
        return;
      }
      routeMessageToModulePort(messageId, message, port);
    });

    port.onDisconnect.addListener(() => {
      console.log('[Background] Options page port disconnected.');
      // optionsPagePort = null;
    });

  } else {
    console.warn('[Background] Unknown connection name:', port.name);
    port.disconnect();
  }
});


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const requestType = (() => {
    try {
      return typeof request?.type === 'string' ? request.type : null;
    } catch {
      return null;
    }
  })();
  console.log(`[Background] Message [${requestType}] received by SW Instance ID: ${serviceWorkerInstanceId}`);

  if (isBackendProfileCommand(requestType)) {
    sendResponse(profileFailure('forbidden', 'options-profile-access'));
    return false;
  }

  if (requestType === CONTRIBUTION_READ_COMMAND || requestType === CONTRIBUTION_RETRY_COMMAND) {
    sendResponse(contributionFailure('forbidden', 'contribution-port-access'));
    return false;
  }

  if (requestType === 'GET_CROWDSOURCING_TASKS') {
    return handleRuntimeCrowdsourcingTasks(request, sender, sendResponse);
  }

  if (requestType === 'POPUP_ACTIVE_PROFILE_STATS') {
    const popupRequest = parsePopupActiveProfileStatsRequest(request);
    if (!popupRequest) {
      sendResponse(popupStatsFailure('invalid', 'popup-active-profile-stats'));
      return false;
    }
    if (!isTrustedPopupSender(sender)) {
      sendResponse(popupStatsFailure('forbidden', 'popup-active-profile-access'));
      return false;
    }
    void handlePopupActiveProfileStats(sendResponse);
    return true;
  }

  if (requestType === 'POPUP_API_REQUEST') {
    sendResponse(popupStatsFailure('invalid', 'popup-active-profile-stats'));
    return false;
  }

  if (sender.tab) {
    console.warn('[Background] Received message from content script via onMessage, expected via port:', request.type);
    sendResponse({ success: false, error: '請通過長連接發送消息' });
    return false;
  }

  if (!request || !requestType) {
    console.error('[Background] Invalid message format:', request);
    sendResponse({ success: false, error: '無效的消息格式' });
    return false;
  }

  sendResponse({ success: false, error: `Unhandled popup message type ${request.type}` });
  return false;
});

function popupStatsFailure(kind, code) {
  return { ok: false, error: { kind, code, retryable: false } };
}

function parsePopupActiveProfileStatsRequest(request) {
  const parsed = strictOwnDataRecord(request, ['type']);
  return parsed?.type === 'POPUP_ACTIVE_PROFILE_STATS' ? parsed : null;
}

function isTrustedPopupSender(sender) {
  try {
    if (!isRecord(sender) || sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
    const popupUrl = chrome.runtime.getURL('popup.html');
    const parsedPopupUrl = new URL(popupUrl);
    const popupOrigin = parsedPopupUrl.origin === 'null'
      ? popupUrl.slice(0, popupUrl.indexOf('/', popupUrl.indexOf('//') + 2))
      : parsedPopupUrl.origin;
    return sender.url === popupUrl && sender.origin === popupOrigin;
  } catch {
    return false;
  }
}

function isUsableJwt(jwt) {
  return typeof jwt === 'string' && jwt.trim().length > 0;
}

function maskPopupUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0) return null;
  return userId.length <= 4 ? '***' : `${userId.slice(0, 2)}...${userId.slice(-2)}`;
}

function normalizeActiveProfileStats(response) {
  try {
    const body = isRecord(response?.data) ? response.data : response;
    if (!isRecord(body) || !isRecord(body.statistics)) return null;
    const totals = {
      points: body.points,
      translationSubmissions: body.statistics.translationSubmissions,
      translationViews: body.statistics.translationViews,
      upvotesReceived: body.statistics.upvotesReceived,
      subtitlesReplaced: body.statistics.subtitlesReplaced
    };
    return Object.values(totals).every((value) => typeof value === 'number' && Number.isFinite(value))
      ? totals
      : null;
  } catch {
    return null;
  }
}

async function handlePopupActiveProfileStats(sendResponse) {
  let profile;
  try {
    await ensureStorageMigrationsComplete(chrome.storage.local);
    profile = await resolveBackendProfile(chrome.storage.local);
  } catch {
    sendResponse(popupStatsFailure('domain-rejected', 'profile-unavailable'));
    return;
  }
  if (!isRecord(profile) || typeof profile.id !== 'string' || typeof profile.userId !== 'string') {
    sendResponse(popupStatsFailure('domain-rejected', 'profile-unavailable'));
    return;
  }
  const userIdMasked = maskPopupUserId(profile.userId);
  if (!userIdMasked) {
    sendResponse(popupStatsFailure('domain-rejected', 'profile-unavailable'));
    return;
  }
  try {
    if (!isUsableJwt(profile.jwt)) {
      const registration = await apiModule.registerUser(profile.userId, profile.id);
      if (!isUsableJwt(registration?.token)) {
        sendResponse(popupStatsFailure('domain-rejected', 'stats-unavailable'));
        return;
      }
      await setBackendProfileCredentials(chrome.storage.local, profile.id, { jwt: registration.token });
    }
    const totals = normalizeActiveProfileStats(
      await apiModule.fetchUserStats(profile.userId, true, profile.id)
    );
    if (!totals) {
      sendResponse(popupStatsFailure('domain-rejected', 'stats-unavailable'));
      return;
    }
    sendResponse({
      ok: true,
      value: {
        scope: 'active-backend-profile-user',
        backendProfileId: profile.id,
        userIdMasked,
        totals
      }
    });
  } catch {
    sendResponse(popupStatsFailure('domain-rejected', 'stats-unavailable'));
  }
}


/**
 * 處理私有字幕查詢
 * @param {Object} request - 私有 Port 請求對象
 * @param {Function} portSendResponse - 回應函數
 */
async function handleSubtitleQuery(request, portSendResponse) {
  const { videoId, timestamp, duration } = request.query || {};

  if (!videoId || typeof timestamp !== 'number' || duration !== 180) {
    console.error('[Background] SUBTITLE_QUERY error: invalid subtitle query');
    portSendResponse({ ok: false, error: { kind: 'invalid', code: 'subtitle-query', retryable: false } });
    return;
  }

  console.log('[Background] Fetching subtitles for:', videoId, timestamp);

  try {
    const subtitles = await apiModule.fetchSubtitles({
      videoId: videoId,
      startTime: timestamp,
      duration
    });

    console.log(`[Background] Successfully fetched ${subtitles.length} subtitles`);
    portSendResponse({ ok: true, value: { subtitles } });
  } catch (error) {
    console.error('[Background] Error fetching subtitles:', error);
    portSendResponse({ ok: false, error: { kind: 'domain-rejected', code: 'subtitle-fetch-failed', retryable: false } });
  }
}

async function handleGetCrowdsourcingTasks(request, portSendResponse) {
  const { videoID, languageCode, limit } = request;

  if (!videoID || typeof videoID !== 'string' || !videoID.trim()) {
    console.error('[Background] GET_CROWDSOURCING_TASKS error: Missing videoID');
    portSendResponse({ success: false, error: '缺少或無效的 videoID' });
    return;
  }

  try {
    const data = await apiModule.fetchCrowdsourcingTasks({ videoID, languageCode, limit });
    portSendResponse({ ...data, success: true });
  } catch (error) {
    console.error('[Background] Error fetching crowdsourcing tasks:', error);
    portSendResponse({ success: false, error: `獲取眾包字幕任務失敗: ${error.message}` });
  }
}

function isNetflixContentSender(sender) {
  const senderUrl = sender?.tab?.url || '';
  if (sender?.id !== chrome.runtime.id) return false;
  if (!sender?.tab?.id || !senderUrl) return false;

  try {
    const { hostname, protocol } = new URL(senderUrl);
    return protocol === 'https:' && (hostname === 'netflix.com' || hostname.endsWith('.netflix.com'));
  } catch (error) {
    console.warn('[Background] Invalid sender URL for crowdsourcing tasks:', error.message);
    return false;
  }
}

function handleRuntimeCrowdsourcingTasks(request, sender, sendResponse) {
  if (!isNetflixContentSender(sender)) {
    console.warn('[Background] Unauthorized GET_CROWDSOURCING_TASKS sender');
    sendResponse({ success: false, error: 'Unauthorized sender for GET_CROWDSOURCING_TASKS' });
    return false;
  }

  const senderUrl = sender.tab.url;
  const senderVideoMatch = new URL(senderUrl).pathname.match(/^\/watch\/(\d+)(?:\/|$)/);
  const senderVideoID = senderVideoMatch ? senderVideoMatch[1] : null;
  const supportedLanguages = new Set([
    'zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru',
    'ar', 'th', 'vi', 'id', 'ms', 'hi', 'tr', 'nl', 'pl', 'sv'
  ]);
  if (!senderVideoID || request.videoID !== senderVideoID) {
    sendResponse({ success: false, error: 'videoID does not match sender watch URL' });
    return false;
  }
  if (request.limit !== 5) {
    sendResponse({ success: false, error: 'limit must equal 5' });
    return false;
  }
  if (!supportedLanguages.has(request.languageCode)) {
    sendResponse({ success: false, error: 'Unsupported languageCode' });
    return false;
  }

  handleGetCrowdsourcingTasks(request, sendResponse);
  return true;
}

function routeMessageToModulePort(messageId, request, port) {
  if (request.type === 'SUBTITLE_QUERY') {
    void handleSubtitleQuery(request, (response) => {
      port.postMessage({ messageId, response });
    });
    return;
  }
  console.warn('[Background] 未處理的消息類型 (port):', request.type);
  port.postMessage({ messageId, response: { success: false, error: `Unhandled message type (port) ${request.type}` } });
}

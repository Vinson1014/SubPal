/**
 * 提交對話框組件 - 重新設計版本（基於舊版 UI 設計）
 * 
 * 設計理念：
 * 1. 完全按照舊版 ui-manager.js 的設計和功能
 * 2. 相對於播放器定位，避免背景干擾
 * 3. 智能焦點管理，防止播放器 UI 干擾
 * 4. 語言記憶功能
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class SubmissionDialog {
  constructor() {
    this.isInitialized = false;
    this.dialog = null;
    this.overlay = null;
    this.videoPlayer = null;
    this.isOpen = false;
    this.currentSubtitleData = null;
    
    // 表單元素
    this.form = null;
    this.inputs = {};
    
    // 焦點管理
    this.lastFocusedInput = null;
    this.savedStates = {
      translation: '',
      translationCursor: 0,
      reason: '',
      reasonCursor: 0
    };
    
    // 事件回調
    this.eventCallbacks = {
      onSubmit: null,
      onCancel: null,
      onClose: null
    };
    
    // 調試模式
    this.debug = false;
  }

  async initialize() {
    this.log('提交對話框組件初始化中...');
    
    try {
      // 載入調試模式設置
      await this.loadDebugMode();
      
      this.isInitialized = true;
      this.log('提交對話框組件初始化完成');
      
    } catch (error) {
      console.error('提交對話框組件初始化失敗:', error);
      throw error;
    }
  }

  // 打開對話框
  async open(subtitleData) {
    if (!this.isInitialized || !subtitleData) {
      console.error('對話框未初始化或缺少字幕數據');
      return;
    }
    
    if (this.isOpen) {
      this.log('對話框已經打開，先關閉現有對話框');
      this.close();
    }
    
    this.log('打開提交對話框', subtitleData);
    this.currentSubtitleData = subtitleData;
    
    // 找到視頻播放器
    this.videoPlayer = this.findVideoPlayer();
    if (!this.videoPlayer) {
      console.error('找不到視頻播放器元素，無法顯示提交對話框');
      return;
    }
    
    // 創建對話框
    await this.createDialog();
    
    // 設置事件處理器
    this.setupEventHandlers();
    
    // 載入用戶語言設置
    await this.loadUserLanguage();
    
    // 顯示對話框
    this.show();
    
    this.isOpen = true;
  }

  // 關閉對話框
  close() {
    if (!this.isOpen) {
      return;
    }
    
    this.log('關閉提交對話框');
    
    // 隱藏對話框
    this.hide();
    
    // 清理資源
    this.cleanup();
    
    this.isOpen = false;
    this.currentSubtitleData = null;
    
    // 觸發關閉回調
    this.triggerCallback('onClose');
  }

  // 找到視頻播放器元素
  findVideoPlayer() {
    const selectors = [
      '.watch-video', 
      '.NFPlayer', 
      'video', 
      '.VideoContainer', 
      '.nf-player-container', 
      '[data-uia="video-player"]'
    ];
    
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        this.log(`找到視頻播放器: ${selector}`);
        return element;
      }
    }
    
    this.log('未找到視頻播放器元素');
    return null;
  }

  // 創建對話框（完全按照舊版設計）
  createDialog() {
    this.log('創建提交對話框');
    
    const originalText = this.currentSubtitleData.original || this.currentSubtitleData.text;
    const currentText = this.currentSubtitleData.text;
    
    // 創建 overlay 層（相對於播放器定位）
    this.overlay = document.createElement('div');
    this.overlay.id = 'subpal-translation-overlay';
    this.overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.5);
      z-index: 999998;
    `;
    
    // 創建浮動視窗
    this.dialog = document.createElement('div');
    this.dialog.id = 'subpal-translation-floating-window';
    this.dialog.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background-color: white;
      padding: 24px;
      border-radius: 8px;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      z-index: 999999;
      width: 450px;
      max-height: 80vh;
      overflow-y: auto;
      box-sizing: border-box;
    `;
    
    // 創建對話框內容
    this.dialog.innerHTML = `
      <h3 style="margin-top: 0; margin-bottom: 18px; color: #222; font-size: 22px; font-weight: 600;">提交翻譯</h3>
      <div style="margin-bottom: 14px;">
        <label for="original-text" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">原始翻譯</label>
        <input id="original-text" type="text" value="${originalText.replace(/"/g, '&quot;')}" readonly
          style="width: 100%; box-sizing: border-box; background: #f3f4f6; color: #222; border: 1px solid #e0e0e0; border-radius: 5px; padding: 8px 10px; font-size: 15px; margin-bottom: 0;"/>
      </div>
      <div style="margin-bottom: 14px;">
        <label for="language-select" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">字幕語言</label>
        <select id="language-select" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1.5px solid #bfc7d1; border-radius: 5px; font-size: 15px; color: #222; background: #fff;">
          <option value="">請選擇語言...</option>
          <option value="en">English</option>
          <option value="zh-TW">繁體中文</option>
          <option value="zh-CN">简体中文</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
          <option value="es">Español</option>
          <option value="fr">Français</option>
          <option value="de">Deutsch</option>
          <option value="other">其他 (請在原因中註明)</option>
        </select>
      </div>
      <div style="margin-bottom: 14px;">
        <label for="translation-input" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">修正翻譯</label>
        <textarea id="translation-input" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1.5px solid #bfc7d1; border-radius: 5px; font-size: 15px; height: 70px; color: #222; background: #fff; resize: vertical;">${currentText}</textarea>
      </div>
      <div style="margin-bottom: 18px;">
        <label for="reason-input" style="display: block; margin-bottom: 6px; color: #444; font-size: 15px;">調整原因</label>
        <textarea id="reason-input" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1.5px solid #bfc7d1; border-radius: 5px; font-size: 15px; height: 50px; color: #222; background: #fff; resize: vertical;" placeholder="請簡述為何需要調整翻譯"></textarea>
      </div>
      <div style="text-align: right;">
        <button id="cancel-translation" style="padding: 8px 18px; margin-right: 10px; background-color: #f5f5f5; color: #888; border: none; border-radius: 4px; cursor: pointer; font-size: 15px;">取消</button>
        <button id="submit-translation" style="padding: 8px 18px; background-color: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 15px; font-weight: 500;">提交</button>
      </div>
    `;
    
    // 添加到播放器內部
    this.videoPlayer.appendChild(this.overlay);
    this.videoPlayer.appendChild(this.dialog);
    
    // 獲取表單元素引用
    this.inputs = {
      languageSelect: this.dialog.querySelector('#language-select'),
      translationInput: this.dialog.querySelector('#translation-input'),
      reasonInput: this.dialog.querySelector('#reason-input')
    };
    
    this.log('提交對話框創建完成');
  }

  // 設置事件處理器（完全按照舊版邏輯）
  setupEventHandlers() {
    this.log('設置事件處理器');
    
    const { languageSelect, translationInput, reasonInput } = this.inputs;
    
    // 自動焦點到翻譯輸入框
    setTimeout(() => {
      translationInput.focus();
    }, 0);
    
    // 設置初始狀態
    this.savedStates.translation = translationInput.value;
    this.savedStates.translationCursor = 0;
    this.savedStates.reason = '';
    this.savedStates.reasonCursor = 0;
    this.lastFocusedInput = translationInput;
    
    // 追蹤翻譯輸入欄位的內容和光標位置
    translationInput.addEventListener('input', () => {
      this.savedStates.translation = translationInput.value;
      this.savedStates.translationCursor = translationInput.selectionStart;
      this.lastFocusedInput = translationInput;
    });
    
    translationInput.addEventListener('click', () => {
      this.savedStates.translationCursor = translationInput.selectionStart;
      this.lastFocusedInput = translationInput;
    });
    
    translationInput.addEventListener('keyup', () => {
      this.savedStates.translationCursor = translationInput.selectionStart;
      this.lastFocusedInput = translationInput;
    });
    
    // 追蹤原因輸入欄位的內容和光標位置
    reasonInput.addEventListener('input', () => {
      this.savedStates.reason = reasonInput.value;
      this.savedStates.reasonCursor = reasonInput.selectionStart;
      this.lastFocusedInput = reasonInput;
    });
    
    reasonInput.addEventListener('click', () => {
      this.savedStates.reasonCursor = reasonInput.selectionStart;
      this.lastFocusedInput = reasonInput;
    });
    
    reasonInput.addEventListener('keyup', () => {
      this.savedStates.reasonCursor = reasonInput.selectionStart;
      this.lastFocusedInput = reasonInput;
    });
    
    // 智能焦點管理機制
    const handleFocusOut = (e) => {
      const clickedButton = e.relatedTarget && (
        e.relatedTarget.id === 'submit-translation' ||
        e.relatedTarget.id === 'cancel-translation'
      );
      
      if (!clickedButton && !this.dialog.contains(e.relatedTarget)) {
        setTimeout(() => {
          if (this.lastFocusedInput === translationInput) {
            translationInput.focus();
            translationInput.setSelectionRange(this.savedStates.translationCursor, this.savedStates.translationCursor);
          } else if (this.lastFocusedInput === reasonInput) {
            reasonInput.focus();
            reasonInput.setSelectionRange(this.savedStates.reasonCursor, this.savedStates.reasonCursor);
          }
        }, 0);
      }
    };
    
    this.dialog.addEventListener('focusout', handleFocusOut, true);
    
    // Overlay 點擊處理
    const handleOverlayClick = (e) => {
      if (e.target === this.overlay) {
        e.preventDefault();
        if (this.lastFocusedInput === translationInput) {
          translationInput.focus();
          translationInput.setSelectionRange(this.savedStates.translationCursor, this.savedStates.translationCursor);
        } else if (this.lastFocusedInput === reasonInput) {
          reasonInput.focus();
          reasonInput.setSelectionRange(this.savedStates.reasonCursor, this.savedStates.reasonCursor);
        }
      }
    };
    
    this.overlay.addEventListener('mousedown', handleOverlayClick);
    
    // 阻止事件傳播，但確保按鈕可點擊
    this.dialog.addEventListener('mousedown', (e) => {
      const clickedElement = e.target;
      const isButton = clickedElement.tagName === 'BUTTON' ||
                       clickedElement.id === 'submit-translation' ||
                       clickedElement.id === 'cancel-translation';
      
      if (!isButton) {
        e.stopPropagation();
      }
    });
    
    // 按鈕事件處理
    const cancelButton = this.dialog.querySelector('#cancel-translation');
    const submitButton = this.dialog.querySelector('#submit-translation');
    
    cancelButton.addEventListener('click', () => {
      this.triggerCallback('onCancel');
      this.close();
    });
    
    submitButton.addEventListener('click', () => {
      this.handleSubmit();
    });
    
    // 視窗大小變化處理
    const repositionWindow = () => {
      this.dialog.style.top = '50%';
      this.dialog.style.left = '50%';
      this.dialog.style.transform = 'translate(-50%, -50%)';
    };
    
    window.addEventListener('resize', repositionWindow);
    
    // 儲存清理函數
    this.cleanupFunctions = [
      () => window.removeEventListener('resize', repositionWindow),
      () => this.dialog.removeEventListener('focusout', handleFocusOut, true),
      () => this.overlay.removeEventListener('mousedown', handleOverlayClick)
    ];
    
    // 監聽調試模式變更
    registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
      this.debug = message.debugMode;
      this.log('調試模式設置已更新:', this.debug);
    });
  }

  // 載入用戶語言設置
  async loadUserLanguage() {
    try {
      const result = await sendMessage({ type: 'GET_USER_LANGUAGE' });
      if (result && result.success && result.languageCode) {
        this.inputs.languageSelect.value = result.languageCode;
        this.log(`載入用戶語言設置: ${result.languageCode}`);
      }
    } catch (error) {
      console.warn('載入用戶語言設置失敗:', error);
    }
  }

  // 保存用戶語言設置
  async saveUserLanguage(languageCode) {
    try {
      await sendMessage({ type: 'SAVE_USER_LANGUAGE', languageCode });
      this.log(`保存用戶語言設置: ${languageCode}`);
    } catch (error) {
      console.warn('保存用戶語言設置失敗:', error);
    }
  }

  // 處理表單提交
  handleSubmit() {
    this.log('處理表單提交');
    
    const { languageSelect, translationInput, reasonInput } = this.inputs;
    
    const translation = translationInput.value.trim();
    const reason = reasonInput.value.trim();
    const selectedLanguage = languageSelect.value;
    
    // 驗證表單
    if (!translation) {
      alert('請輸入翻譯內容');
      translationInput.focus();
      return;
    }
    
    if (!reason) {
      alert('請填寫調整原因');
      reasonInput.focus();
      return;
    }
    
    if (!selectedLanguage) {
      alert('請選擇字幕語言');
      languageSelect.focus();
      return;
    }
    
    // 構造提交數據
    const submissionData = {
      videoId: this.currentSubtitleData.videoId,
      timestamp: this.currentSubtitleData.timestamp,
      original: this.currentSubtitleData.original || this.currentSubtitleData.text,
      translation: translation,
      submissionReason: reason,
      languageCode: selectedLanguage
    };
    
    this.log('提交數據:', submissionData);
    
    // 保存用戶語言設置
    this.saveUserLanguage(selectedLanguage);
    
    // 觸發提交回調
    this.triggerCallback('onSubmit', submissionData);
    
    // 關閉對話框
    this.close();
  }

  // 顯示對話框
  show() {
    // 對話框已經在創建時就顯示了
    this.log('提交對話框已顯示');
  }

  // 隱藏對話框
  hide() {
    // 在清理時會被移除
    this.log('提交對話框已隱藏');
  }

  // 清理資源
  cleanup() {
    this.log('清理提交對話框資源');
    
    // 執行清理函數
    if (this.cleanupFunctions) {
      this.cleanupFunctions.forEach(fn => fn());
      this.cleanupFunctions = null;
    }
    
    // 移除 DOM 元素
    if (this.overlay && this.videoPlayer && this.videoPlayer.contains(this.overlay)) {
      this.videoPlayer.removeChild(this.overlay);
    }
    
    if (this.dialog && this.videoPlayer && this.videoPlayer.contains(this.dialog)) {
      this.videoPlayer.removeChild(this.dialog);
    }
    
    this.dialog = null;
    this.overlay = null;
    this.videoPlayer = null;
    this.inputs = {};
    this.lastFocusedInput = null;
    this.savedStates = {
      translation: '',
      translationCursor: 0,
      reason: '',
      reasonCursor: 0
    };
  }

  // 觸發回調
  triggerCallback(callbackName, data = null) {
    const callback = this.eventCallbacks[callbackName];
    if (callback && typeof callback === 'function') {
      this.log(`觸發回調: ${callbackName}`);
      callback(data);
    }
  }

  // 註冊事件回調
  onSubmit(callback) {
    this.eventCallbacks.onSubmit = callback;
    this.log('提交回調已註冊');
  }

  onCancel(callback) {
    this.eventCallbacks.onCancel = callback;
    this.log('取消回調已註冊');
  }

  onClose(callback) {
    this.eventCallbacks.onClose = callback;
    this.log('關閉回調已註冊');
  }

  // 獲取狀態
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isOpen: this.isOpen,
      hasCurrentData: !!this.currentSubtitleData,
      hasVideoPlayer: !!this.videoPlayer,
      callbacks: Object.keys(this.eventCallbacks).filter(key => 
        typeof this.eventCallbacks[key] === 'function'
      )
    };
  }

  // 從存儲中載入調試模式設置
  async loadDebugMode() {
    try {
      const result = await sendMessage({
        type: 'GET_SETTINGS',
        keys: ['debugMode']
      });
      
      if (result && result.debugMode !== undefined) {
        this.debug = result.debugMode;
        this.log(`調試模式: ${this.debug}`);
      }
    } catch (error) {
      console.error('載入調試模式設置時出錯:', error);
    }
  }


  log(message, ...args) {
    if (this.debug) {
      console.log(`[SubmissionDialog] ${message}`, ...args);
    }
  }
}

export { SubmissionDialog };
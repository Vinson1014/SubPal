/**
 * DOM 監聽模式 - 重構版字幕偵測器
 * 
 * 設計理念：
 * 1. 模塊化：從原有 subtitle-detector.js 重構而來
 * 2. 專責化：只負責 DOM 監聽和字幕提取
 * 3. 統一接口：提供標準化的字幕數據格式
 * 4. 健壯性：保留原有的重試機制和錯誤處理
 */

import { registerInternalEventHandler } from '../system/messaging.js';

class DOMMonitor {
  constructor() {
    this.isActive = false;
    this.isInitialized = false;
    this.callback = null;
    this.currentObserver = null;
    
    // 字幕去重機制
    this.lastSubtitleText = '';
    this.lastSubtitlePosition = null;
    
    // 字幕元素選擇器（從原有實現保留）
    this.subtitleSelectors = [
      '.player-timedtext-text-container', // 主要字幕容器
      '.player-timedtext-text-container span', // 字幕文本元素
      '.player-timedtext', // 備用選擇器
      '.VideoContainer div.player-timedtext', // 更具體的選擇器
      '.VideoContainer div.player-timedtext-text-container', // 更具體的選擇器
      'div[data-uia="player-timedtext-text-container"]', // 使用 data-uia 屬性
      '.player-timedtext-text-container > span', // 直接子元素
      '.player-timedtext > .player-timedtext-text-container' // 父子關係
    ];
    
    // 調試模式
    this.debug = false;
  }

  async initialize() {
    this.log('DOM 監聽模式初始化中...');
    
    try {
      const { configBridge } = await import('../system/config/config-bridge.js');
      this.configBridge = configBridge;
      this.debug = configBridge.get('debugMode');
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
      });

      this.setupEventHandlers();
      
      this.isInitialized = true;
      this.log('DOM 監聽模式初始化完成');
      
    } catch (error) {
      console.error('DOM 監聽模式初始化失敗:', error);
      throw error;
    }
  }

  start() {
    if (this.isActive) {
      this.log('DOM 監聽已經啟動，跳過');
      return;
    }
    
    if (!this.isInitialized) {
      console.error('DOM 監聽模式未初始化，無法啟動');
      return;
    }
    
    this.log('啟動 DOM 監聽模式...');
    this.isActive = true;
    
    // 設置字幕容器觀察器
    this.setupSubtitleObserver();
    
    // 立即掃描一次
    this.scanForSubtitles();
    
    this.log('DOM 監聽模式已啟動');
  }

  stop() {
    if (!this.isActive) {
      this.log('DOM 監聽已經停止，跳過');
      return;
    }
    
    this.log('停止 DOM 監聽模式...');
    this.isActive = false;
    
    // 斷開觀察器
    if (this.currentObserver) {
      this.currentObserver.disconnect();
      this.currentObserver = null;
    }
    
    // 清理狀態
    this.lastSubtitleText = '';
    this.lastSubtitlePosition = null;
    
    this.log('DOM 監聽模式已停止');
  }

  onSubtitleDetected(callback) {
    this.callback = callback;
    this.log('字幕檢測回調已註冊');
  }

  // 設置事件處理器
  setupEventHandlers() {
    // 監聽影片切換事件
    registerInternalEventHandler('VIDEO_ID_CHANGED', (message) => {
      this.log('收到影片切換事件，重新設置觀察器');
      if (this.isActive) {
        this.setupSubtitleObserver();
        this.scanForSubtitles();
      }
    });
  }

  // 設置字幕容器觀察器（保留原有邏輯）
  setupSubtitleObserver() {
    // 如果存在舊的觀察器，先斷開它
    if (this.currentObserver) {
      this.log('斷開舊的字幕容器觀察器');
      this.currentObserver.disconnect();
      this.currentObserver = null;
    }
    
    // 尋找字幕容器
    const subtitleContainer = document.querySelector('.player-timedtext');
    if (subtitleContainer) {
      // 創建專門用於字幕容器的 MutationObserver
      const subtitleObserver = new MutationObserver((mutations) => {
        if (!this.isActive) return; // 確保只在活躍狀態下處理
        
        for (const mutation of mutations) {
          if (mutation.type === 'childList' || mutation.type === 'characterData') {
            this.scanForSubtitles();
            break;
          }
        }
      });
      
      // 觀察字幕容器的變化
      subtitleObserver.observe(subtitleContainer, {
        childList: true,
        subtree: true,
        characterData: true
      });
      
      // 儲存新的觀察器實例
      this.currentObserver = subtitleObserver;
      
      this.log('已設置字幕容器觀察器');
    } else {
      // 如果找不到字幕容器，稍後再試
      this.log('未找到字幕容器，1秒後重試');
      setTimeout(() => {
        if (this.isActive) {
          this.setupSubtitleObserver();
        }
      }, 1000);
    }
  }

  // 主動掃描頁面尋找字幕元素（保留原有邏輯）
  scanForSubtitles() {
    if (!this.isActive) return;
    
    this.log('主動掃描字幕元素...');

    // 只針對最外層字幕 container 做偵測與合併
    const containers = document.querySelectorAll('.player-timedtext-text-container');
    if (containers.length > 0) {
      this.log(`找到 ${containers.length} 個字幕 container`);
      containers.forEach(container => {
        this.processSubtitleContainer(container);
      });
      return;
    }

    // 沒有任何字幕時，主動觸發空字幕事件
    this.emitSubtitleData({
      text: '',
      position: null,
      element: null,
      isEmpty: true
    });
  }

  // 合併 container 內所有 span，並正確抓取分行與位置（保留原有邏輯）
  processSubtitleContainer(container) {
    // 直接抓取 container 的 innerHTML 與 textContent
    const text = container.textContent.trim();
    const htmlContent = container.innerHTML;

    // 如果字幕為空，觸發空字幕事件
    if (!text) {
      this.log('偵測到空字幕，觸發隱藏事件');
      this.emitSubtitleData({
        text: '',
        position: null,
        element: container,
        isEmpty: true
      });
      return;
    }

    // 延遲抓取 position，確保 DOM 已排版（保留原有邏輯）
    const getAndEmitPosition = (retry = 0) => {
      const rect = container.getBoundingClientRect();
      const position = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };

      // 若 position 異常，最多重試 3 次
      if ((position.top < 1 || position.left < 1 || position.width < 1) && retry < 3) {
        setTimeout(() => getAndEmitPosition(retry + 1), 30 * (retry + 1));
        return;
      }

      // 去重：只用 text+position（保留原有邏輯）
      if (
        text === this.lastSubtitleText &&
        this.lastSubtitlePosition &&
        Math.abs(this.lastSubtitlePosition.top - position.top) < 5 &&
        Math.abs(this.lastSubtitlePosition.left - position.left) < 5
      ) {
        this.log('字幕文本和位置與上一次相同，不觸發更新');
        return;
      }
      
      this.lastSubtitleText = text;
      this.lastSubtitlePosition = { ...position };

      // 樣式提取（保留原有邏輯）
      const style = window.getComputedStyle(container);
      const subtitleStyle = {
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        color: style.color,
        backgroundColor: style.backgroundColor,
        textAlign: style.textAlign
      };

      this.log('DOM 字幕偵測:', text);
      this.log('字幕位置:', position);
      this.log('字幕樣式:', subtitleStyle);
      
      // 調試：原生字幕容器詳細資訊
      if (this.debug) {
        console.log('[DOMMonitor] 原生字幕容器詳細資訊:', {
          selector: '.player-timedtext-text-container',
          element: container,
          computedStyle: {
            position: style.position,
            display: style.display,
            transform: style.transform,
            zIndex: style.zIndex,
            visibility: style.visibility
          },
          boundingRect: rect,
          offsetParent: container.offsetParent,
          scrollPosition: {
            scrollX: window.scrollX,
            scrollY: window.scrollY
          }
        });
      }

      // 構造標準化字幕數據
      const subtitleData = {
        text,
        htmlContent,
        position,
        style: subtitleStyle,
        element: container,
        timestamp: Date.now(),
        isEmpty: false
      };

      this.emitSubtitleData(subtitleData);
    };

    getAndEmitPosition();
  }

  // 發射字幕數據到回調
  emitSubtitleData(subtitleData) {
    if (this.callback) {
      this.callback(subtitleData);
    }
  }

  // 獲取監聽狀態
  getStatus() {
    return {
      isActive: this.isActive,
      isInitialized: this.isInitialized,
      hasObserver: !!this.currentObserver,
      lastSubtitle: this.lastSubtitleText ? {
        text: this.lastSubtitleText.substring(0, 50) + '...',
        position: this.lastSubtitlePosition
      } : null,
      debug: this.debug
    };
  }

  // 清理資源
  cleanup() {
    this.log('清理 DOM 監聽器資源...');
    
    this.stop();
    this.callback = null;
    this.isInitialized = false;
    
    this.log('DOM 監聽器資源清理完成');
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[DOMMonitor] ${message}`, ...args);
    }
  }
}

export { DOMMonitor };
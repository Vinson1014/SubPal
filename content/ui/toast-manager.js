/**
 * Toast 消息管理組件 - 專責消息提示
 * 
 * 設計理念：
 * 1. 專責化：只負責消息提示的顯示和管理
 * 2. 類型支援：支援不同類型的消息（成功、錯誤、警告、信息）
 * 3. 動畫效果：平滑的顯示和隱藏效果
 * 4. 隊列管理：支援多個消息的排隊顯示
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

// Toast 類型定義
const TOAST_TYPES = {
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info'
};

// Toast 樣式配置
const TOAST_STYLES = {
  [TOAST_TYPES.SUCCESS]: {
    backgroundColor: 'rgba(46, 125, 50, 0.9)',
    color: '#ffffff',
    icon: '✓'
  },
  [TOAST_TYPES.ERROR]: {
    backgroundColor: 'rgba(211, 47, 47, 0.9)',
    color: '#ffffff',
    icon: '✗'
  },
  [TOAST_TYPES.WARNING]: {
    backgroundColor: 'rgba(245, 124, 0, 0.9)',
    color: '#ffffff',
    icon: '⚠'
  },
  [TOAST_TYPES.INFO]: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    color: '#ffffff',
    icon: 'ℹ'
  }
};

// Z-Index 層級（參考舊版設計）
const TOAST_Z_INDEX = 13000;

class ToastManager {
  constructor() {
    this.isInitialized = false;
    this.activeToasts = new Set(); // 管理當前活躍的 toast
    this.toastQueue = []; // 消息隊列
    this.maxConcurrentToasts = 3; // 最大同時顯示數量
    this.defaultDuration = 3000; // 默認顯示時間（3秒，比舊版稍長）
    
    // 調試模式（將由 ConfigBridge 設置）
    this.debug = false;

    // 容器配置
    this.containerConfig = {
      top: '30px', // 保持與舊版一致的位置
      gap: '10px'  // toast 之間的間距
    };
  }

  async initialize() {
    this.log('Toast 管理器初始化中...');

    try {
      // 導入 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 從 ConfigBridge 讀取配置
      this.debug = configBridge.get('debugMode');
      this.log(`調試模式設置為: ${this.debug}`);

      // 訂閱配置變更
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log(`調試模式已更新: ${newValue}`);
      });

      // 保存 ConfigBridge 實例
      this.configBridge = configBridge;
      
      // 設置事件處理器
      this.setupEventHandlers();
      
      this.isInitialized = true;
      this.log('Toast 管理器初始化完成');
      
    } catch (error) {
      console.error('Toast 管理器初始化失敗:', error);
      throw error;
    }
  }

  // 主要的 Toast 顯示方法
  show(message, type = TOAST_TYPES.INFO, options = {}) {
    if (!this.isInitialized) {
      console.error('Toast 管理器未初始化');
      return null;
    }

    if (!message) {
      console.warn('Toast 消息不能為空');
      return null;
    }

    this.log(`顯示 Toast: [${type}] ${message}`);

    const toastConfig = {
      message,
      type,
      duration: options.duration || this.defaultDuration,
      persistent: options.persistent || false, // 是否需要手動關閉
      showIcon: options.showIcon !== false, // 默認顯示圖標
      timestamp: Date.now(),
      id: this.generateToastId()
    };

    // 如果當前顯示的 toast 數量超過限制，加入隊列
    if (this.activeToasts.size >= this.maxConcurrentToasts) {
      this.toastQueue.push(toastConfig);
      this.log(`Toast 加入隊列，當前隊列長度: ${this.toastQueue.length}`);
      return toastConfig.id;
    }

    return this.displayToast(toastConfig);
  }

  // 快捷方法（參考舊版使用方式）
  showSuccess(message, options = {}) {
    return this.show(message, TOAST_TYPES.SUCCESS, options);
  }

  showError(message, options = {}) {
    return this.show(message, TOAST_TYPES.ERROR, options);
  }

  showWarning(message, options = {}) {
    return this.show(message, TOAST_TYPES.WARNING, options);
  }

  showInfo(message, options = {}) {
    return this.show(message, TOAST_TYPES.INFO, options);
  }

  // 顯示 Toast 元素
  displayToast(toastConfig) {
    const toast = this.createToastElement(toastConfig);
    
    // 添加到頁面
    document.body.appendChild(toast);
    this.activeToasts.add(toast);
    
    // 更新所有 toast 的位置
    this.updateToastPositions();
    
    // 顯示動畫
    this.showToastAnimation(toast);
    
    // 設置自動移除（除非是持久化的）
    if (!toastConfig.persistent) {
      setTimeout(() => {
        this.removeToast(toast);
      }, toastConfig.duration);
    }
    
    this.log(`Toast 已顯示，當前活躍數量: ${this.activeToasts.size}`);
    return toastConfig.id;
  }

  // 創建 Toast 元素
  createToastElement(toastConfig) {
    const { message, type, showIcon, id } = toastConfig;
    const styleConfig = TOAST_STYLES[type] || TOAST_STYLES[TOAST_TYPES.INFO];
    
    // 創建主容器
    const toast = document.createElement('div');
    toast.dataset.toastId = id;
    toast.className = 'subpal-toast';
    
    // 基本樣式（保留舊版的基礎設計）
    Object.assign(toast.style, {
      position: 'fixed',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: styleConfig.backgroundColor,
      color: styleConfig.color,
      fontSize: '16px', // 比舊版稍小一點
      padding: '12px 20px',
      borderRadius: '6px', // 稍微圓潤一點
      zIndex: TOAST_Z_INDEX.toString(),
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      maxWidth: '400px',
      wordBreak: 'break-word',
      opacity: '0',
      transition: 'all 0.3s ease-in-out',
      cursor: 'pointer'
    });

    // 添加圖標（如果啟用）
    if (showIcon && styleConfig.icon) {
      const icon = document.createElement('span');
      icon.textContent = styleConfig.icon;
      icon.style.fontSize = '18px';
      icon.style.marginRight = '4px';
      toast.appendChild(icon);
    }

    // 添加消息文本
    const messageElement = document.createElement('span');
    messageElement.textContent = message;
    messageElement.style.flex = '1';
    toast.appendChild(messageElement);

    // 添加關閉按鈕（用於持久化 toast）
    if (toastConfig.persistent) {
      const closeButton = document.createElement('span');
      closeButton.textContent = '×';
      closeButton.style.fontSize = '20px';
      closeButton.style.marginLeft = '8px';
      closeButton.style.cursor = 'pointer';
      closeButton.style.opacity = '0.7';
      
      closeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeToast(toast);
      });
      
      closeButton.addEventListener('mouseenter', () => {
        closeButton.style.opacity = '1';
      });
      
      closeButton.addEventListener('mouseleave', () => {
        closeButton.style.opacity = '0.7';
      });
      
      toast.appendChild(closeButton);
    }

    // 點擊 toast 關閉（非持久化的）
    if (!toastConfig.persistent) {
      toast.addEventListener('click', () => {
        this.removeToast(toast);
      });
    }

    return toast;
  }

  // 顯示動畫
  showToastAnimation(toast) {
    // 初始狀態：從上方滑入
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    toast.style.opacity = '0';
    
    // 使用 requestAnimationFrame 確保動畫流暢
    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(-50%) translateY(0)';
      toast.style.opacity = '1';
    });
  }

  // 隱藏動畫
  hideToastAnimation(toast) {
    return new Promise((resolve) => {
      toast.style.transform = 'translateX(-50%) translateY(-20px)';
      toast.style.opacity = '0';
      
      // 等待動畫完成
      setTimeout(() => {
        resolve();
      }, 300);
    });
  }

  // 移除 Toast
  async removeToast(toast) {
    if (!toast || !this.activeToasts.has(toast)) {
      return;
    }

    this.log(`移除 Toast: ${toast.dataset.toastId}`);

    // 播放隱藏動畫
    await this.hideToastAnimation(toast);

    // 從 DOM 和集合中移除
    if (toast.parentElement) {
      toast.parentElement.removeChild(toast);
    }
    this.activeToasts.delete(toast);

    // 更新剩餘 toast 位置
    this.updateToastPositions();

    // 處理隊列中的下一個 toast
    this.processQueue();

    this.log(`Toast 已移除，當前活躍數量: ${this.activeToasts.size}`);
  }

  // 更新所有 Toast 位置
  updateToastPositions() {
    const toasts = Array.from(this.activeToasts);
    const baseTop = parseInt(this.containerConfig.top);
    const gap = parseInt(this.containerConfig.gap);

    toasts.forEach((toast, index) => {
      const topPosition = baseTop + (index * (toast.offsetHeight + gap));
      toast.style.top = `${topPosition}px`;
    });
  }

  // 處理隊列中的下一個 Toast
  processQueue() {
    if (this.toastQueue.length === 0 || this.activeToasts.size >= this.maxConcurrentToasts) {
      return;
    }

    const nextToast = this.toastQueue.shift();
    this.log(`從隊列中處理 Toast: ${nextToast.message}`);
    this.displayToast(nextToast);
  }

  // 清除所有 Toast
  clearAll() {
    this.log('清除所有 Toast');
    
    const toasts = Array.from(this.activeToasts);
    toasts.forEach(toast => {
      this.removeToast(toast);
    });
    
    this.toastQueue.length = 0;
  }

  // 生成唯一 Toast ID
  generateToastId() {
    return `toast_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  // 獲取當前狀態
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      activeToasts: this.activeToasts.size,
      queueLength: this.toastQueue.length,
      maxConcurrentToasts: this.maxConcurrentToasts,
      defaultDuration: this.defaultDuration
    };
  }

  // 設置配置
  configure(config) {
    if (config.maxConcurrentToasts !== undefined) {
      this.maxConcurrentToasts = Math.max(1, Math.min(10, config.maxConcurrentToasts));
    }
    
    if (config.defaultDuration !== undefined) {
      this.defaultDuration = Math.max(1000, config.defaultDuration);
    }
    
    if (config.containerConfig) {
      this.containerConfig = { ...this.containerConfig, ...config.containerConfig };
    }
    
    this.log('Toast 管理器配置已更新:', config);
  }

  // 清理資源
  cleanup() {
    this.log('清理 Toast 管理器資源...');
    
    this.clearAll();
    this.isInitialized = false;
    
    this.log('Toast 管理器資源清理完成');
  }

  // 設置事件處理器
  setupEventHandlers() {
    // 配置變更已通過 ConfigBridge 訂閱處理
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[ToastManager] ${message}`, ...args);
    }
  }
}

export { ToastManager, TOAST_TYPES };
/**
 * Netflix 播放器適配器 - 動態計算字幕位置
 * 
 * 設計理念：
 * 1. 即時獲取播放器邊界
 * 2. 根據TTML region定義動態計算像素位置
 * 3. 支援播放器尺寸變化的實時適配
 * 4. 提供多種Netflix播放器版本的兼容性
 */

import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';

class NetflixPlayerAdapter {
  constructor() {
    // 預設 region 配置 (基於Netflix標準) - 作為後備方案
    this.defaultRegionConfigs = {
      'region0': {
        origin: { x: 0.1, y: 0.1 },    // 10%, 10%
        extent: { w: 0.8, h: 0.4 },    // 80%, 40%
        displayAlign: 'before'          // 頂部對齊
      },
      'region1': {
        origin: { x: 0.1, y: 0.5 },    // 10%, 50%
        extent: { w: 0.8, h: 0.4 },    // 80%, 40%
        displayAlign: 'after'           // 底部對齊
      }
    };
    
    // 動態 region 配置 (從 TTML 解析)
    this.dynamicRegionConfigs = {};
    
    // 當前有效的 region 配置 (動態配置優先，預設配置作為後備)
    this.regionConfigs = { ...this.defaultRegionConfigs };
    
    // 播放器選擇器 (按優先級排序)
    this.playerSelectors = [
      '.watch-video--player-view',      // 新版Netflix
      '.nfp-video-player',              // 標準播放器
      '[data-uia="player"]',            // 通用播放器
      '.VideoContainer',                // 舊版容器
      '.watch-video',                   // 備用選擇器
      'video'                          // 最後備案：直接選擇video元素
    ];
    
    // 緩存
    this.lastPlayerBounds = null;
    this.lastCalculatedTime = 0;
    this.cacheValidDuration = 100; // 100ms內使用緩存
    this.positionCache = {}; // 位置計算緩存
    
    // 調試模式（將由 ConfigBridge 設置）
    this.debug = false;
    this.isConfigInitialized = false;
  }

  /**
   * 獲取當前播放器邊界
   * @returns {Object} 播放器邊界信息
   */
  getCurrentPlayerBounds() {
    const now = Date.now();
    
    // 使用緩存避免頻繁計算
    if (this.lastPlayerBounds && 
        (now - this.lastCalculatedTime) < this.cacheValidDuration) {
      return this.lastPlayerBounds;
    }
    
    let playerElement = null;
    
    // 按優先級嘗試不同的選擇器
    for (const selector of this.playerSelectors) {
      playerElement = document.querySelector(selector);
      if (playerElement) {
        this.log(`找到播放器元素: ${selector}`);
        break;
      }
    }
    
    let bounds;
    
    if (playerElement) {
      bounds = playerElement.getBoundingClientRect();
      this.log('播放器邊界:', bounds);
      
      // 驗證邊界合理性
      if (bounds.width < 100 || bounds.height < 100) {
        this.log('播放器尺寸異常，使用視窗作為後備');
        bounds = this.getViewportBounds();
      }
    } else {
      this.log('未找到播放器元素，使用視窗邊界作為後備');
      bounds = this.getViewportBounds();
    }
    
    // 緩存結果
    this.lastPlayerBounds = bounds;
    this.lastCalculatedTime = now;
    
    return bounds;
  }

  /**
   * 獲取視窗邊界作為後備方案
   */
  getViewportBounds() {
    return {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      right: window.innerWidth,
      bottom: window.innerHeight
    };
  }

  /**
   * 根據TTML region動態計算像素位置
   * @param {string} region - TTML region ID
   * @returns {Object|null} 像素位置對象
   */
  calculatePosition(region) {
    if (!region) {
      this.log('region 參數為空');
      return null;
    }
    
    const config = this.regionConfigs[region];
    if (!config) {
      this.log(`未知的 region: ${region}`);
      return null;
    }
    
    // 檢查位置緩存
    const cacheKey = `${region}_${this.lastCalculatedTime}`;
    if (this.positionCache && this.positionCache[cacheKey]) {
      return this.positionCache[cacheKey];
    }
    
    const playerBounds = this.getCurrentPlayerBounds();
    
    // 計算像素位置
    const position = {
      left: Math.round(playerBounds.left + playerBounds.width * config.origin.x),
      top: Math.round(playerBounds.top + playerBounds.height * config.origin.y),
      width: Math.round(playerBounds.width * config.extent.w),
      height: Math.round(playerBounds.height * config.extent.h),
      displayAlign: config.displayAlign,
      
      // 額外資訊用於調試
      _debug: this.debug ? {
        region: region,
        playerBounds: playerBounds,
        config: config,
        calculatedAt: new Date().toISOString()
      } : undefined
    };
    
    // 緩存位置結果
    this.positionCache[cacheKey] = position;
    
    this.log(`計算 ${region} 位置:`, position);
    
    return position;
  }

  /**
   * 計算多個region的位置 (批量計算優化)
   * @param {Array<string>} regions - region ID 陣列
   * @returns {Object} region -> position 的映射
   */
  calculateMultiplePositions(regions) {
    if (!Array.isArray(regions) || regions.length === 0) {
      return {};
    }
    
    // 一次獲取播放器邊界，避免重複計算
    const playerBounds = this.getCurrentPlayerBounds();
    const results = {};
    
    for (const region of regions) {
      const config = this.regionConfigs[region];
      if (config) {
        results[region] = {
          left: Math.round(playerBounds.left + playerBounds.width * config.origin.x),
          top: Math.round(playerBounds.top + playerBounds.height * config.origin.y),
          width: Math.round(playerBounds.width * config.extent.w),
          height: Math.round(playerBounds.height * config.extent.h),
          displayAlign: config.displayAlign
        };
      }
    }
    
    return results;
  }

  /**
   * 獲取播放器元素 (用於設置監聽器)
   * @returns {Element|null} 播放器元素
   */
  getPlayerElement() {
    for (const selector of this.playerSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    return null;
  }

  /**
   * 檢查播放器是否處於全屏模式
   * @returns {boolean} 是否全屏
   */
  isFullscreen() {
    return !!(document.fullscreenElement || 
              document.webkitFullscreenElement || 
              document.mozFullScreenElement ||
              document.msFullscreenElement);
  }

  /**
   * 獲取播放器狀態信息
   * @returns {Object} 狀態信息
   */
  getPlayerStatus() {
    const playerElement = this.getPlayerElement();
    const bounds = this.getCurrentPlayerBounds();
    
    return {
      hasPlayer: !!playerElement,
      playerSelector: playerElement ? this.getElementSelector(playerElement) : null,
      isFullscreen: this.isFullscreen(),
      bounds: bounds,
      regionConfigs: {
        defaultRegions: Object.keys(this.defaultRegionConfigs),
        dynamicRegions: Object.keys(this.dynamicRegionConfigs),
        activeRegions: Object.keys(this.regionConfigs),
        hasDynamicConfigs: Object.keys(this.dynamicRegionConfigs).length > 0
      },
      cacheStatus: {
        hasCachedBounds: !!this.lastPlayerBounds,
        cacheAge: this.lastPlayerBounds ? Date.now() - this.lastCalculatedTime : 0
      }
    };
  }

  /**
   * 獲取元素的選擇器 (調試用)
   */
  getElementSelector(element) {
    for (const selector of this.playerSelectors) {
      if (element.matches(selector)) {
        return selector;
      }
    }
    return 'unknown';
  }

  /**
   * 清除緩存 (強制重新計算)
   */
  clearCache() {
    this.lastPlayerBounds = null;
    this.lastCalculatedTime = 0;
    this.positionCache = {};
    this.log('緩存已清除');
  }

  /**
   * 重置到預設 region 配置
   */
  resetToDefaultRegionConfigs() {
    this.dynamicRegionConfigs = {};
    this.regionConfigs = { ...this.defaultRegionConfigs };
    this.log('已重置到預設 region 配置');
  }

  // 初始化配置
  async initializeConfig() {
    if (this.isConfigInitialized) {
      return;
    }

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
      this.isConfigInitialized = true;
    } catch (error) {
      console.error('初始化配置時出錯:', error);
    }
  }

  /**
   * 添加自定義region配置
   * @param {string} regionId - region ID
   * @param {Object} config - region配置
   */
  addRegionConfig(regionId, config) {
    if (!config.origin || !config.extent) {
      console.error('無效的region配置:', config);
      return;
    }
    
    this.regionConfigs[regionId] = {
      origin: { x: config.origin.x || 0, y: config.origin.y || 0 },
      extent: { w: config.extent.w || 1, h: config.extent.h || 1 },
      displayAlign: config.displayAlign || 'after'
    };
    
    this.log(`添加自定義region: ${regionId}`, this.regionConfigs[regionId]);
  }

  /**
   * 設置 region 配置 (動態配置優先，預設配置作為後備)
   * @param {Object} regionConfigs - 從 TTML 解析的 region 配置映射
   */
  setRegionConfigs(regionConfigs) {
    if (!regionConfigs || typeof regionConfigs !== 'object') {
      this.log('無效的 regionConfigs 參數');
      return;
    }
    
    // 轉換格式：從 TTML 解析格式轉換為適配器內部格式
    const convertedConfigs = {};
    
    for (const [regionId, config] of Object.entries(regionConfigs)) {
      if (config.origin && config.extent) {
        convertedConfigs[regionId] = {
          origin: { 
            x: config.origin.x || 0, 
            y: config.origin.y || 0 
          },
          extent: { 
            w: config.extent.x || 1, 
            h: config.extent.y || 1 
          },
          displayAlign: config.displayAlign || 'after'
        };
      }
    }
    
    // 更新動態配置
    this.dynamicRegionConfigs = { ...convertedConfigs };
    
    // 重建最終配置：動態配置優先，預設配置作為後備
    this.regionConfigs = { 
      ...this.defaultRegionConfigs,    // 預設配置作為後備
      ...this.dynamicRegionConfigs     // 動態配置優先
    };
    
    // 記錄配置更新詳情
    const overriddenRegions = Object.keys(convertedConfigs).filter(
      regionId => this.defaultRegionConfigs[regionId]
    );
    
    this.log(`更新 region 配置完成:`);
    this.log(`- 新增動態配置: ${Object.keys(convertedConfigs).length} 個`);
    this.log(`- 覆蓋預設配置: ${overriddenRegions.length} 個 (${overriddenRegions.join(', ')})`);
    this.log(`- 最終有效配置: ${Object.keys(this.regionConfigs).length} 個`);
    
    if (this.debug) {
      this.log('動態配置詳情:', convertedConfigs);
      this.log('最終配置詳情:', this.regionConfigs);
    }
  }

  /**
   * 調試日誌
   */
  log(message, ...args) {
    if (this.debug) {
      console.log(`[NetflixPlayerAdapter] ${message}`, ...args);
    }
  }
}

// 創建單例實例
const netflixPlayerAdapter = new NetflixPlayerAdapter();
netflixPlayerAdapter.initializeConfig();

/**
 * 獲取播放器適配器實例
 */
export function getPlayerAdapter() {
  return netflixPlayerAdapter;
}

/**
 * 計算字幕位置
 */
export function calculateSubtitlePosition(region) {
  return netflixPlayerAdapter.calculatePosition(region);
}

/**
 * 批量計算字幕位置
 */
export function calculateMultipleSubtitlePositions(regions) {
  return netflixPlayerAdapter.calculateMultiplePositions(regions);
}

/**
 * 獲取播放器狀態
 */
export function getPlayerStatus() {
  return netflixPlayerAdapter.getPlayerStatus();
}

/**
 * 設置 region 配置
 */
export function setRegionConfigs(regionConfigs) {
  return netflixPlayerAdapter.setRegionConfigs(regionConfigs);
}

/**
 * 重置到預設 region 配置
 */
export function resetToDefaultRegionConfigs() {
  return netflixPlayerAdapter.resetToDefaultRegionConfigs();
}


console.log('[NetflixPlayerAdapter] 模組已載入');
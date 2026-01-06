/**
 * 字幕解析器 - 解析 TTML 格式字幕
 * 
 * 此模組負責：
 * 1. 解析 TTML 格式字幕
 * 2. 統一時間格式轉換
 * 3. 處理分行和樣式
 * 4. 建立時間索引
 * 5. 提取 region 屬性供動態位置計算使用
 * 
 * 注意：位置計算已移至 NetflixPlayerAdapter，此處只負責解析
 */

// 調試模式
let debugMode = true;

function debugLog(...args) {
  if (debugMode) {
    console.log('[SubtitleParser]', ...args);
  }
}

/**
 * 字幕解析器類
 */
class SubtitleParser {
  constructor() {
    this.tickRate = 10000000; // Netflix 預設：1秒 = 10,000,000 ticks
  }

  /**
   * 解析字幕內容（只支援 TTML 格式）
   * @param {string} content - 字幕文件內容
   * @returns {Object} 包含字幕數據和 region 配置的對象
   */
  parseSubtitle(content) {
    debugLog('開始解析 TTML 字幕');
    
    if (!content || typeof content !== 'string') {
      debugLog('字幕內容無效');
      return { subtitles: [], regionConfigs: {} };
    }

    // Netflix 主要使用 TTML 格式
    const subtitles = this.parseTTML(content);
    
    // 解析 region 配置
    const regionConfigs = this.parseRegionConfigs(content);
    
    debugLog(`解析完成，共 ${subtitles.length} 個字幕條目，${Object.keys(regionConfigs).length} 個 region 配置`);
    return { subtitles, regionConfigs };
  }

  /**
   * 檢查是否為有效的 TTML 格式
   */
  isValidTTML(content) {
    return content.includes('<?xml') && content.includes('<tt');
  }

  /**
   * 解析 TTML 格式字幕
   */
  parseTTML(content) {
    debugLog('解析 TTML 格式');
    
    const subtitles = [];
    
    try {
      // 解析 XML
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(content, 'text/xml');
      
      // 檢查解析錯誤
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        console.error('TTML 解析錯誤:', parseError.textContent);
        return [];
      }

      // 獲取 tickRate
      const ttElement = xmlDoc.querySelector('tt');
      if (ttElement) {
        const tickRateAttr = ttElement.getAttribute('ttp:tickRate');
        if (tickRateAttr) {
          this.tickRate = parseInt(tickRateAttr);
          debugLog('檢測到 tickRate:', this.tickRate);
        }
      }

      // 獲取所有 <p> 元素（字幕段落）
      const paragraphs = xmlDoc.querySelectorAll('p');
      
      for (const p of paragraphs) {
        const subtitle = this.parseTTMLParagraph(p);
        if (subtitle) {
          subtitles.push(subtitle);
        }
      }

    } catch (error) {
      console.error('TTML 解析失敗:', error);
      return [];
    }

    return subtitles.sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * 解析 TTML 段落元素
   */
  parseTTMLParagraph(paragraph) {
    const id = paragraph.getAttribute('xml:id');
    const beginAttr = paragraph.getAttribute('begin');
    const endAttr = paragraph.getAttribute('end');
    const region = paragraph.getAttribute('region');

    if (!beginAttr || !endAttr) {
      debugLog('跳過沒有時間屬性的段落:', id);
      return null;
    }

    // 轉換時間格式
    const startTime = this.parseTimeToSeconds(beginAttr);
    const endTime = this.parseTimeToSeconds(endAttr);

    if (startTime === null || endTime === null) {
      debugLog('時間解析失敗:', beginAttr, endAttr);
      return null;
    }

    // 提取文本內容
    const text = this.extractTTMLText(paragraph);

    return {
      id,
      startTime,
      endTime,
      text,
      region,
      originalElement: paragraph,
      // 位置計算已移至 NetflixPlayerAdapter，這裡只保留 region 資訊
      hasRegion: !!region
    };
  }

  /**
   * 提取 TTML 文本內容，處理 <br/> 分行
   */
  extractTTMLText(element) {
    let text = '';
    
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'br') {
          text += '\n';
        } else if (node.tagName === 'span') {
          text += this.extractTTMLText(node);
        }
      }
    }
    
    return text.trim();
  }


  /**
   * 解析時間格式到秒（只支援 TTML tick 格式）
   */
  parseTimeToSeconds(timeStr) {
    if (!timeStr) return null;
    
    // TTML tick 格式 (例如: "915080832t")
    if (timeStr.endsWith('t')) {
      const ticks = parseInt(timeStr.slice(0, -1));
      return ticks / this.tickRate;
    }
    
    // 直接數字格式（秒）
    const seconds = parseFloat(timeStr);
    return isNaN(seconds) ? null : seconds;
  }

  /**
   * 根據時間查找字幕
   */
  findSubtitleByTime(subtitles, currentTime, tolerance = 0.005) {
    if (!subtitles || subtitles.length === 0) return null;
    
    for (const subtitle of subtitles) {
      if (currentTime >= (subtitle.startTime - tolerance) && 
          currentTime <= (subtitle.endTime + tolerance)) {
        return subtitle;
      }
    }
    
    return null;
  }

  /**
   * 建立時間索引以提高查找效率（優化版本）
   */
  buildTimeIndex(subtitles) {
    debugLog('建立時間索引');
    
    if (subtitles.length === 0) {
      debugLog('字幕數據為空，返回空索引');
      return new Map();
    }
    
    // 使用更粗粒度的時間間隔來避免 Map 過大
    const timeInterval = 10; // 每10秒一個索引項目
    const index = new Map();
    
    for (const subtitle of subtitles) {
      // 檢查時間戳是否有異常值
      if (!subtitle.startTime || !subtitle.endTime || 
          subtitle.startTime < 0 || subtitle.endTime < 0 ||
          subtitle.startTime > 86400 || subtitle.endTime > 86400) {
        debugLog('發現異常時間戳:', {
          startTime: subtitle.startTime,
          endTime: subtitle.endTime,
          text: subtitle.text ? subtitle.text.substring(0, 50) : 'no text'
        });
        continue; // 跳過異常的字幕
      }
      
      // 計算字幕所在的時間區間
      const startInterval = Math.floor(subtitle.startTime / timeInterval);
      const endInterval = Math.floor(subtitle.endTime / timeInterval);
      
      // 檢查區間是否合理
      if (startInterval < 0 || endInterval < 0 || 
          startInterval > 8640 || endInterval > 8640) { // 24小時 * 360 (10秒區間)
        debugLog('計算出異常的時間區間:', {
          startInterval,
          endInterval,
          startTime: subtitle.startTime,
          endTime: subtitle.endTime
        });
        continue;
      }
      
      for (let interval = startInterval; interval <= endInterval; interval++) {
        if (!index.has(interval)) {
          index.set(interval, []);
        }
        index.get(interval).push(subtitle);
      }
    }
    
    debugLog(`時間索引建立完成，覆蓋 ${index.size} 個時間區間 (每區間${timeInterval}秒)`);
    return index;
  }

  /**
   * 使用時間索引快速查找字幕
   */
  findSubtitleByTimeIndex(timeIndex, currentTime, tolerance = 0.005) {
    const timeInterval = 10; // 與建立索引時相同的間隔
    const interval = Math.floor(currentTime / timeInterval);
    const candidates = timeIndex.get(interval) || [];
    
    for (const subtitle of candidates) {
      if (currentTime >= (subtitle.startTime - tolerance) && 
          currentTime <= (subtitle.endTime + tolerance)) {
        return subtitle;
      }
    }
    
    return null;
  }

  /**
   * 設置調試模式
   */
  setDebugMode(enabled) {
    debugMode = enabled;
  }

  /**
   * 解析 TTML 中的 region 配置
   * @param {string} ttmlContent - TTML 內容
   * @returns {Object} region 配置映射
   */
  parseRegionConfigs(ttmlContent) {
    const regionConfigs = {};
    
    if (!ttmlContent || typeof ttmlContent !== 'string') {
      debugLog('無效的 TTML 內容，無法解析 region 配置');
      return regionConfigs;
    }
    
    try {
      // 解析 <layout> 部分
      const layoutMatch = ttmlContent.match(/<layout[^>]*>(.*?)<\/layout>/s);
      if (!layoutMatch) {
        debugLog('TTML 中未找到 <layout> 標籤');
        return regionConfigs;
      }
      
      const layoutContent = layoutMatch[1];
      
      // 解析每個 <region> 標籤
      const regionMatches = layoutContent.matchAll(/<region[^>]*>/g);
      let regionCount = 0;
      
      for (const match of regionMatches) {
        const regionConfig = this.parseRegionAttributes(match[0]);
        if (regionConfig.id) {
          regionConfigs[regionConfig.id] = regionConfig;
          regionCount++;
          debugLog(`解析 region: ${regionConfig.id}`, regionConfig);
        }
      }
      
      debugLog(`成功解析 ${regionCount} 個 region 配置`);
      
    } catch (error) {
      debugLog('解析 region 配置時出錯:', error);
    }
    
    return regionConfigs;
  }

  /**
   * 解析 region 標籤的屬性
   * @param {string} regionElement - region 標籤字符串
   * @returns {Object} region 配置對象
   */
  parseRegionAttributes(regionElement) {
    const config = {};
    
    // 解析 xml:id
    const idMatch = regionElement.match(/xml:id="([^"]+)"/);
    if (idMatch) {
      config.id = idMatch[1];
    }
    
    // 解析 tts:origin (例如: "10.000% 10.000%")
    const originMatch = regionElement.match(/tts:origin="([^"]+)"/);
    if (originMatch) {
      config.origin = this.parsePercentagePair(originMatch[1]);
    }
    
    // 解析 tts:extent (例如: "80.000% 40.000%")
    const extentMatch = regionElement.match(/tts:extent="([^"]+)"/);
    if (extentMatch) {
      config.extent = this.parsePercentagePair(extentMatch[1]);
    }
    
    // 解析 tts:displayAlign (例如: "after", "before")
    const displayAlignMatch = regionElement.match(/tts:displayAlign="([^"]+)"/);
    if (displayAlignMatch) {
      config.displayAlign = displayAlignMatch[1];
    }
    
    return config;
  }

  /**
   * 解析百分比對 (例如: "10.000% 50.000%" -> {x: 0.1, y: 0.5})
   * @param {string} percentageStr - 百分比字符串
   * @returns {Object} 解析後的座標對象
   */
  parsePercentagePair(percentageStr) {
    const parts = percentageStr.trim().split(/\s+/);
    if (parts.length !== 2) {
      debugLog('無效的百分比格式:', percentageStr);
      return { x: 0, y: 0 };
    }
    
    const x = parseFloat(parts[0].replace('%', '')) / 100;
    const y = parseFloat(parts[1].replace('%', '')) / 100;
    
    return {
      x: isNaN(x) ? 0 : x,
      y: isNaN(y) ? 0 : y
    };
  }
}

// 創建單例實例
const subtitleParser = new SubtitleParser();

/**
 * 解析字幕內容（只支援 TTML 格式）
 * @param {string} content - 字幕文件內容
 * @returns {Object} 包含字幕數據和 region 配置的對象
 */
export function parseSubtitle(content) {
  return subtitleParser.parseSubtitle(content);
}

/**
 * 根據時間查找字幕
 */
export function findSubtitleByTime(subtitles, currentTime, tolerance = 0.1) {
  return subtitleParser.findSubtitleByTime(subtitles, currentTime, tolerance);
}

/**
 * 建立時間索引
 */
export function buildTimeIndex(subtitles) {
  return subtitleParser.buildTimeIndex(subtitles);
}

/**
 * 使用時間索引查找字幕
 */
export function findSubtitleByTimeIndex(timeIndex, currentTime, tolerance = 0.1) {
  return subtitleParser.findSubtitleByTimeIndex(timeIndex, currentTime, tolerance);
}

/**
 * 設置調試模式
 */
export function setSubtitleParserDebugMode(enabled) {
  subtitleParser.setDebugMode(enabled);
}

/**
 * 獲取解析器實例
 */
export function getSubtitleParser() {
  return subtitleParser;
}

/**
 * 解析 TTML 中的 region 配置
 * @param {string} ttmlContent - TTML 內容
 * @returns {Object} region 配置映射
 */
export function parseRegionConfigs(ttmlContent) {
  return subtitleParser.parseRegionConfigs(ttmlContent);
}

debugLog('字幕解析器模組已載入');
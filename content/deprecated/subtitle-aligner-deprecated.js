/**
 * 字幕對齊引擎 - 智能字幕對齊算法
 * 
 * 此模組提供多種字幕對齊策略：
 * 1. 時間軸對齊 - 基於字幕時間戳
 * 2. 內容相似度對齊 - 基於文本相似性
 * 3. 語義對齊 - 基於語義理解
 * 4. 混合對齊策略 - 結合多種方法
 * 5. 對齊質量評估 - 評估對齊準確性
 */

import { sendMessage } from './messaging.js';

// 調試模式
let debugMode = false;

function debugLog(...args) {
  if (debugMode) {
    console.log('[SubtitleAligner]', ...args);
  }
}

/**
 * 字幕對齊引擎類
 */
class SubtitleAligner {
  constructor() {
    this.alignmentStrategies = {
      TIME_BASED: 'time',
      CONTENT_BASED: 'content',
      SEMANTIC_BASED: 'semantic',
      HYBRID: 'hybrid'
    };
    
    this.defaultStrategy = this.alignmentStrategies.HYBRID;
    this.timeTolerance = 0.5; // 時間容差（秒）
    this.contentThreshold = 0.6; // 內容相似度閾值
    this.minAlignmentScore = 0.4; // 最小對齊分數
    
    // 統計信息
    this.alignmentStats = {
      totalPairs: 0,
      successfulAlignments: 0,
      timeBasedAlignments: 0,
      contentBasedAlignments: 0,
      hybridAlignments: 0,
      averageScore: 0
    };
  }

  /**
   * 對齊兩組字幕
   */
  alignSubtitles(primarySubs, secondarySubs, strategy = this.defaultStrategy) {
    debugLog('開始對齊字幕:', {
      primary: primarySubs.length,
      secondary: secondarySubs.length,
      strategy: strategy
    });
    
    // 重置統計
    this.resetStats();
    
    if (!primarySubs || !secondarySubs || primarySubs.length === 0 || secondarySubs.length === 0) {
      debugLog('字幕數據不足，無法對齊');
      return [];
    }
    
    let alignedSubtitles = [];
    
    switch (strategy) {
      case this.alignmentStrategies.TIME_BASED:
        alignedSubtitles = this.alignByTime(primarySubs, secondarySubs);
        break;
      case this.alignmentStrategies.CONTENT_BASED:
        alignedSubtitles = this.alignByContent(primarySubs, secondarySubs);
        break;
      case this.alignmentStrategies.SEMANTIC_BASED:
        alignedSubtitles = this.alignBySemantic(primarySubs, secondarySubs);
        break;
      case this.alignmentStrategies.HYBRID:
        alignedSubtitles = this.alignByHybrid(primarySubs, secondarySubs);
        break;
      default:
        alignedSubtitles = this.alignByHybrid(primarySubs, secondarySubs);
    }
    
    // 後處理和優化
    alignedSubtitles = this.postProcessAlignment(alignedSubtitles);
    
    // 計算統計信息
    this.calculateStats(alignedSubtitles);
    
    debugLog('字幕對齊完成:', {
      aligned: alignedSubtitles.length,
      stats: this.alignmentStats
    });
    
    return alignedSubtitles;
  }

  /**
   * 基於時間軸對齊
   */
  alignByTime(primarySubs, secondarySubs) {
    debugLog('使用時間軸對齊策略');
    
    const aligned = [];
    const usedSecondaryIndices = new Set();
    
    for (let i = 0; i < primarySubs.length; i++) {
      const primarySub = primarySubs[i];
      const matches = [];
      
      // 找到所有時間重疊的次要字幕
      for (let j = 0; j < secondarySubs.length; j++) {
        if (usedSecondaryIndices.has(j)) continue;
        
        const secondarySub = secondarySubs[j];
        const overlap = this.calculateTimeOverlap(primarySub, secondarySub);
        
        if (overlap > 0) {
          matches.push({
            index: j,
            subtitle: secondarySub,
            overlap: overlap,
            score: this.calculateTimeAlignmentScore(primarySub, secondarySub)
          });
        }
      }
      
      // 選擇最佳匹配
      if (matches.length > 0) {
        matches.sort((a, b) => b.score - a.score);
        const bestMatch = matches[0];
        
        if (bestMatch.score >= this.minAlignmentScore) {
          aligned.push(this.createAlignedSubtitle(primarySub, bestMatch.subtitle, bestMatch.score, 'time'));
          usedSecondaryIndices.add(bestMatch.index);
          this.alignmentStats.timeBasedAlignments++;
        } else {
          // 沒有好的匹配，只顯示主要字幕
          aligned.push(this.createAlignedSubtitle(primarySub, null, 0, 'time'));
        }
      } else {
        // 沒有匹配的次要字幕
        aligned.push(this.createAlignedSubtitle(primarySub, null, 0, 'time'));
      }
    }
    
    // 添加未匹配的次要字幕
    for (let j = 0; j < secondarySubs.length; j++) {
      if (!usedSecondaryIndices.has(j)) {
        aligned.push(this.createAlignedSubtitle(null, secondarySubs[j], 0, 'time'));
      }
    }
    
    return aligned;
  }

  /**
   * 基於內容相似度對齊
   */
  alignByContent(primarySubs, secondarySubs) {
    debugLog('使用內容相似度對齊策略');
    
    const aligned = [];
    const usedSecondaryIndices = new Set();
    
    for (let i = 0; i < primarySubs.length; i++) {
      const primarySub = primarySubs[i];
      const matches = [];
      
      // 計算與所有次要字幕的相似度
      for (let j = 0; j < secondarySubs.length; j++) {
        if (usedSecondaryIndices.has(j)) continue;
        
        const secondarySub = secondarySubs[j];
        const similarity = this.calculateContentSimilarity(primarySub.text, secondarySub.text);
        
        if (similarity >= this.contentThreshold) {
          matches.push({
            index: j,
            subtitle: secondarySub,
            similarity: similarity,
            score: similarity
          });
        }
      }
      
      // 選擇最佳匹配
      if (matches.length > 0) {
        matches.sort((a, b) => b.score - a.score);
        const bestMatch = matches[0];
        
        aligned.push(this.createAlignedSubtitle(primarySub, bestMatch.subtitle, bestMatch.score, 'content'));
        usedSecondaryIndices.add(bestMatch.index);
        this.alignmentStats.contentBasedAlignments++;
      } else {
        // 沒有匹配的次要字幕
        aligned.push(this.createAlignedSubtitle(primarySub, null, 0, 'content'));
      }
    }
    
    // 添加未匹配的次要字幕
    for (let j = 0; j < secondarySubs.length; j++) {
      if (!usedSecondaryIndices.has(j)) {
        aligned.push(this.createAlignedSubtitle(null, secondarySubs[j], 0, 'content'));
      }
    }
    
    return aligned;
  }

  /**
   * 基於語義對齊
   */
  alignBySemantic(primarySubs, secondarySubs) {
    debugLog('使用語義對齊策略');
    
    // 語義對齊需要更複雜的NLP處理
    // 暫時使用增強的內容相似度算法
    return this.alignByEnhancedContent(primarySubs, secondarySubs);
  }

  /**
   * 混合對齊策略
   */
  alignByHybrid(primarySubs, secondarySubs) {
    debugLog('使用混合對齊策略');
    
    const aligned = [];
    const usedSecondaryIndices = new Set();
    
    for (let i = 0; i < primarySubs.length; i++) {
      const primarySub = primarySubs[i];
      const candidates = [];
      
      // 評估所有可能的次要字幕
      for (let j = 0; j < secondarySubs.length; j++) {
        if (usedSecondaryIndices.has(j)) continue;
        
        const secondarySub = secondarySubs[j];
        
        // 計算各種對齊分數
        const timeScore = this.calculateTimeAlignmentScore(primarySub, secondarySub);
        const contentScore = this.calculateContentSimilarity(primarySub.text, secondarySub.text);
        const positionScore = this.calculatePositionScore(i, j, primarySubs.length, secondarySubs.length);
        
        // 混合分數計算
        const hybridScore = this.calculateHybridScore(timeScore, contentScore, positionScore);
        
        if (hybridScore >= this.minAlignmentScore) {
          candidates.push({
            index: j,
            subtitle: secondarySub,
            timeScore: timeScore,
            contentScore: contentScore,
            positionScore: positionScore,
            hybridScore: hybridScore
          });
        }
      }
      
      // 選擇最佳候選
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.hybridScore - a.hybridScore);
        const bestCandidate = candidates[0];
        
        aligned.push(this.createAlignedSubtitle(
          primarySub, 
          bestCandidate.subtitle, 
          bestCandidate.hybridScore, 
          'hybrid'
        ));
        usedSecondaryIndices.add(bestCandidate.index);
        this.alignmentStats.hybridAlignments++;
      } else {
        // 沒有匹配的次要字幕
        aligned.push(this.createAlignedSubtitle(primarySub, null, 0, 'hybrid'));
      }
    }
    
    // 添加未匹配的次要字幕
    for (let j = 0; j < secondarySubs.length; j++) {
      if (!usedSecondaryIndices.has(j)) {
        aligned.push(this.createAlignedSubtitle(null, secondarySubs[j], 0, 'hybrid'));
      }
    }
    
    return aligned;
  }

  /**
   * 增強的內容相似度對齊
   */
  alignByEnhancedContent(primarySubs, secondarySubs) {
    debugLog('使用增強內容相似度對齊策略');
    
    const aligned = [];
    const usedSecondaryIndices = new Set();
    
    for (let i = 0; i < primarySubs.length; i++) {
      const primarySub = primarySubs[i];
      const matches = [];
      
      for (let j = 0; j < secondarySubs.length; j++) {
        if (usedSecondaryIndices.has(j)) continue;
        
        const secondarySub = secondarySubs[j];
        
        // 使用多種相似度算法
        const basicSimilarity = this.calculateContentSimilarity(primarySub.text, secondarySub.text);
        const semanticSimilarity = this.calculateSemanticSimilarity(primarySub.text, secondarySub.text);
        const structuralSimilarity = this.calculateStructuralSimilarity(primarySub.text, secondarySub.text);
        
        const combinedScore = (basicSimilarity * 0.4) + (semanticSimilarity * 0.4) + (structuralSimilarity * 0.2);
        
        if (combinedScore >= this.contentThreshold) {
          matches.push({
            index: j,
            subtitle: secondarySub,
            score: combinedScore
          });
        }
      }
      
      // 選擇最佳匹配
      if (matches.length > 0) {
        matches.sort((a, b) => b.score - a.score);
        const bestMatch = matches[0];
        
        aligned.push(this.createAlignedSubtitle(primarySub, bestMatch.subtitle, bestMatch.score, 'enhanced-content'));
        usedSecondaryIndices.add(bestMatch.index);
      } else {
        aligned.push(this.createAlignedSubtitle(primarySub, null, 0, 'enhanced-content'));
      }
    }
    
    // 添加未匹配的次要字幕
    for (let j = 0; j < secondarySubs.length; j++) {
      if (!usedSecondaryIndices.has(j)) {
        aligned.push(this.createAlignedSubtitle(null, secondarySubs[j], 0, 'enhanced-content'));
      }
    }
    
    return aligned;
  }

  /**
   * 計算時間重疊
   */
  calculateTimeOverlap(sub1, sub2) {
    const start1 = sub1.startTime || 0;
    const end1 = sub1.endTime || 0;
    const start2 = sub2.startTime || 0;
    const end2 = sub2.endTime || 0;
    
    const overlapStart = Math.max(start1, start2);
    const overlapEnd = Math.min(end1, end2);
    
    return Math.max(0, overlapEnd - overlapStart);
  }

  /**
   * 計算時間對齊分數
   */
  calculateTimeAlignmentScore(sub1, sub2) {
    const overlap = this.calculateTimeOverlap(sub1, sub2);
    const duration1 = (sub1.endTime || 0) - (sub1.startTime || 0);
    const duration2 = (sub2.endTime || 0) - (sub2.startTime || 0);
    
    if (duration1 === 0 && duration2 === 0) return 0;
    
    const avgDuration = (duration1 + duration2) / 2;
    const score = overlap / avgDuration;
    
    return Math.min(1, Math.max(0, score));
  }

  /**
   * 計算內容相似度
   */
  calculateContentSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    // 預處理文本
    const clean1 = this.preprocessText(text1);
    const clean2 = this.preprocessText(text2);
    
    // 使用多種相似度算法
    const jaroSimilarity = this.calculateJaroSimilarity(clean1, clean2);
    const levenshteinSimilarity = this.calculateLevenshteinSimilarity(clean1, clean2);
    const cosineSimilarity = this.calculateCosineSimilarity(clean1, clean2);
    
    // 組合分數
    return (jaroSimilarity * 0.4) + (levenshteinSimilarity * 0.3) + (cosineSimilarity * 0.3);
  }

  /**
   * 計算語義相似度
   */
  calculateSemanticSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    // 提取關鍵詞
    const keywords1 = this.extractKeywords(text1);
    const keywords2 = this.extractKeywords(text2);
    
    // 計算關鍵詞重疊
    const intersection = keywords1.filter(word => keywords2.includes(word));
    const union = [...new Set([...keywords1, ...keywords2])];
    
    return union.length === 0 ? 0 : intersection.length / union.length;
  }

  /**
   * 計算結構相似度
   */
  calculateStructuralSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    // 比較文本結構特徵
    const features1 = this.extractStructuralFeatures(text1);
    const features2 = this.extractStructuralFeatures(text2);
    
    let similarity = 0;
    const keys = Object.keys(features1);
    
    for (const key of keys) {
      const diff = Math.abs(features1[key] - features2[key]);
      const max = Math.max(features1[key], features2[key]);
      similarity += max === 0 ? 1 : 1 - (diff / max);
    }
    
    return similarity / keys.length;
  }

  /**
   * 計算位置分數
   */
  calculatePositionScore(index1, index2, total1, total2) {
    const pos1 = index1 / total1;
    const pos2 = index2 / total2;
    
    return 1 - Math.abs(pos1 - pos2);
  }

  /**
   * 計算混合分數
   */
  calculateHybridScore(timeScore, contentScore, positionScore) {
    // 權重配置
    const weights = {
      time: 0.4,
      content: 0.5,
      position: 0.1
    };
    
    return (timeScore * weights.time) + 
           (contentScore * weights.content) + 
           (positionScore * weights.position);
  }

  /**
   * Jaro相似度計算
   */
  calculateJaroSimilarity(s1, s2) {
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;
    
    const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
    const matches = [];
    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);
    
    // 找到匹配的字符
    for (let i = 0; i < s1.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, s2.length);
      
      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches.push(s1[i]);
        break;
      }
    }
    
    if (matches.length === 0) return 0;
    
    // 計算轉置數
    let transpositions = 0;
    let k = 0;
    
    for (let i = 0; i < s1.length; i++) {
      if (!s1Matches[i]) continue;
      
      while (!s2Matches[k]) k++;
      
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }
    
    return (matches.length / s1.length + 
            matches.length / s2.length + 
            (matches.length - transpositions / 2) / matches.length) / 3;
  }

  /**
   * Levenshtein相似度計算
   */
  calculateLevenshteinSimilarity(s1, s2) {
    const distance = this.calculateLevenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    
    return maxLength === 0 ? 1 : 1 - (distance / maxLength);
  }

  /**
   * Levenshtein距離計算
   */
  calculateLevenshteinDistance(s1, s2) {
    const matrix = Array.from({ length: s1.length + 1 }, () => Array(s2.length + 1).fill(0));
    
    for (let i = 0; i <= s1.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= s1.length; i++) {
      for (let j = 1; j <= s2.length; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,     // deletion
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }
    
    return matrix[s1.length][s2.length];
  }

  /**
   * 餘弦相似度計算
   */
  calculateCosineSimilarity(text1, text2) {
    const vector1 = this.textToVector(text1);
    const vector2 = this.textToVector(text2);
    
    const keys = new Set([...Object.keys(vector1), ...Object.keys(vector2)]);
    
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    
    for (const key of keys) {
      const val1 = vector1[key] || 0;
      const val2 = vector2[key] || 0;
      
      dotProduct += val1 * val2;
      norm1 += val1 * val1;
      norm2 += val2 * val2;
    }
    
    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * 文本向量化
   */
  textToVector(text) {
    const words = text.toLowerCase().split(/\s+/);
    const vector = {};
    
    for (const word of words) {
      vector[word] = (vector[word] || 0) + 1;
    }
    
    return vector;
  }

  /**
   * 預處理文本
   */
  preprocessText(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')  // 移除標點符號
      .replace(/\s+/g, ' ')     // 標準化空格
      .trim();
  }

  /**
   * 提取關鍵詞
   */
  extractKeywords(text) {
    const stopWords = new Set(['的', '是', '在', '了', '和', 'with', 'the', 'a', 'an', 'and', 'or', 'but']);
    const words = this.preprocessText(text).split(/\s+/);
    
    return words.filter(word => word.length > 2 && !stopWords.has(word));
  }

  /**
   * 提取結構特徵
   */
  extractStructuralFeatures(text) {
    return {
      length: text.length,
      wordCount: text.split(/\s+/).length,
      sentenceCount: text.split(/[.!?]+/).length,
      avgWordLength: text.split(/\s+/).reduce((sum, word) => sum + word.length, 0) / text.split(/\s+/).length
    };
  }

  /**
   * 創建對齊字幕對象
   */
  createAlignedSubtitle(primarySub, secondarySub, score, method) {
    const startTime = primarySub?.startTime || secondarySub?.startTime || 0;
    const endTime = primarySub?.endTime || secondarySub?.endTime || 0;
    
    return {
      startTime: startTime,
      endTime: endTime,
      primaryText: primarySub?.text || '',
      secondaryText: secondarySub?.text || '',
      alignmentScore: score,
      alignmentMethod: method,
      hasPrimary: !!primarySub,
      hasSecondary: !!secondarySub,
      duration: endTime - startTime
    };
  }

  /**
   * 後處理對齊結果
   */
  postProcessAlignment(alignedSubtitles) {
    // 按時間排序
    alignedSubtitles.sort((a, b) => a.startTime - b.startTime);
    
    // 合併相鄰的相同字幕
    const merged = [];
    let current = null;
    
    for (const aligned of alignedSubtitles) {
      if (!current) {
        current = aligned;
        continue;
      }
      
      // 檢查是否可以合併
      if (this.canMergeAligned(current, aligned)) {
        current = this.mergeAligned(current, aligned);
      } else {
        merged.push(current);
        current = aligned;
      }
    }
    
    if (current) {
      merged.push(current);
    }
    
    return merged;
  }

  /**
   * 檢查是否可以合併對齊字幕
   */
  canMergeAligned(aligned1, aligned2) {
    const timeDiff = aligned2.startTime - aligned1.endTime;
    const isSameText = aligned1.primaryText === aligned2.primaryText && 
                      aligned1.secondaryText === aligned2.secondaryText;
    
    return timeDiff <= 1 && isSameText; // 1秒內且文本相同
  }

  /**
   * 合併對齊字幕
   */
  mergeAligned(aligned1, aligned2) {
    return {
      ...aligned1,
      endTime: aligned2.endTime,
      duration: aligned2.endTime - aligned1.startTime,
      alignmentScore: Math.max(aligned1.alignmentScore, aligned2.alignmentScore)
    };
  }

  /**
   * 重置統計信息
   */
  resetStats() {
    this.alignmentStats = {
      totalPairs: 0,
      successfulAlignments: 0,
      timeBasedAlignments: 0,
      contentBasedAlignments: 0,
      hybridAlignments: 0,
      averageScore: 0
    };
  }

  /**
   * 計算統計信息
   */
  calculateStats(alignedSubtitles) {
    this.alignmentStats.totalPairs = alignedSubtitles.length;
    this.alignmentStats.successfulAlignments = alignedSubtitles.filter(sub => 
      sub.hasPrimary && sub.hasSecondary
    ).length;
    
    const scores = alignedSubtitles.map(sub => sub.alignmentScore);
    this.alignmentStats.averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }

  /**
   * 獲取統計信息
   */
  getStats() {
    return { ...this.alignmentStats };
  }

  /**
   * 設置配置
   */
  setConfig(config) {
    if (config.timeTolerance !== undefined) {
      this.timeTolerance = config.timeTolerance;
    }
    if (config.contentThreshold !== undefined) {
      this.contentThreshold = config.contentThreshold;
    }
    if (config.minAlignmentScore !== undefined) {
      this.minAlignmentScore = config.minAlignmentScore;
    }
    
    debugLog('對齊引擎配置已更新:', config);
  }

  /**
   * 獲取配置
   */
  getConfig() {
    return {
      timeTolerance: this.timeTolerance,
      contentThreshold: this.contentThreshold,
      minAlignmentScore: this.minAlignmentScore
    };
  }
}

// 創建單例實例
const subtitleAligner = new SubtitleAligner();

/**
 * 對齊字幕
 */
export function alignSubtitles(primarySubs, secondarySubs, strategy = 'hybrid') {
  return subtitleAligner.alignSubtitles(primarySubs, secondarySubs, strategy);
}

/**
 * 獲取對齊統計
 */
export function getAlignmentStats() {
  return subtitleAligner.getStats();
}

/**
 * 設置對齊配置
 */
export function setAlignmentConfig(config) {
  subtitleAligner.setConfig(config);
}

/**
 * 獲取對齊配置
 */
export function getAlignmentConfig() {
  return subtitleAligner.getConfig();
}

/**
 * 獲取對齊引擎實例
 */
export function getSubtitleAligner() {
  return subtitleAligner;
}

debugLog('字幕對齊引擎模組已載入');
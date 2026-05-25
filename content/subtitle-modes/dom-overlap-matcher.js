/**
 * DOM Overlap Matcher
 *
 * 負責收集 Netflix 原生字幕 DOM 文字，與 page script raw TTML pool 中的候選做 overlap match，
 * 回傳最佳匹配的候選與歸屬判斷所需資料。
 *
 * 設計原則：
 * 1. 不做 active slot 修改，只做分析與匹配
 * 2. 不鬆綁 gate
 * 3. 結果只供呼叫端判斷，不直接套用到 active slot
 */

import { sendMessageToPageScript } from '../system/messaging.js';
import { getCurrentTimestamp, getVideoId } from '../core/video-info.js';
import { parseSubtitle } from '../utils/subtitle-parser.js';
import { playbackContextManager } from '../core/playback-context-manager.js';

class DOMOverlapMatcher {
  constructor(options = {}) {
    // 調試開關
    this.debug = options.debug || false;

    // Netflix 原生字幕 DOM 選擇器
    this.subtitleSelector = '.player-timedtext-text-container';

    // cue 時間窗口 (±750ms)
    this.cueWindowMs = 750;

    // score 分母下限，避免極短 DOM text 因同分母過小產生高分誤判
    this.minComparableUnits = 4;

    // 最近一筆 DOM sample
    this.lastSample = null;

    // 內部 debug 事件暫存
    this.debugEvents = [];
    this.maxDebugEvents = 20;

    // MutationObserver for reactive DOM watching
    this.observer = null;
    this._observedContainer = null;
    this._rootObserver = null;
    this._bodyObserver = null;
    this._bodyObserverTimeout = null;
    this._debounceTimer = null;
    this._maxDebounceTimer = null;
    this._pendingMatch = false;
    this.isMatching = false;
    this.activeLanguage = null;
    this.onMatch = null;
  }

  // ==================== Visibility Helper ====================

  /**
   * 檢查 DOM 元素是否可見（排除隱藏元素）
   * @param {Element} el
   * @returns {boolean}
   */
  _isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  // ==================== Debug ====================

  log(...args) {
    if (this.debug) {
      console.log('[DOMOverlapMatcher]', ...args);
    }
  }

  recordDebugEvent(type, data = {}) {
    this.debugEvents.push({
      type,
      timestamp: Date.now(),
      ...data
    });

    if (this.debugEvents.length > this.maxDebugEvents) {
      this.debugEvents.splice(0, this.debugEvents.length - this.maxDebugEvents);
    }
  }

  // ==================== Reactive DOM Watching (MutationObserver) ====================

  /**
   * Start watching for DOM subtitle mutations.
   * Creates a MutationObserver on .player-timedtext-text-container with 300ms debounce.
   * @param {string} languageCode - Target language to match against
   * @param {Function} onMatch - Callback invoked with findBestMatch result
   * @returns {boolean} true if successfully started, false if already watching
   */
  startWatching(languageCode, onMatch) {
    if (this.observer || this._bodyObserver) {
      this.log('Already watching, skipping');
      return false;
    }

    this.activeLanguage = languageCode;
    this.onMatch = onMatch;

    const container = document.querySelector(this.subtitleSelector);
    if (container) {
      this._reattachDirectObserver(container);
      this._startRootObserver();
      this.log('MutationObserver + root observer started on', this.subtitleSelector);
      this.recordDebugEvent('WATCH_STARTED', { languageCode, selector: this.subtitleSelector });
    } else {
      // Container not found yet — observe body to detect when it appears
      this.log('Subtitle container not found, watching body for appearance');
      this._bodyObserver = new MutationObserver(() => this._handleBodyMutation());
      this._bodyObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
      this._bodyObserverTimeout = setTimeout(() => this._handleBodyObserverTimeout(), 30000);
      this.recordDebugEvent('WATCH_BODY_OBSERVER_STARTED', {
        languageCode,
        selector: this.subtitleSelector,
        timeout: 30000
      });
    }

    return true;
  }

  /**
   * Stop watching: disconnect observer, clear debounce timer and state.
   */
  stopWatching() {
    if (this._rootObserver) {
      this._rootObserver.disconnect();
      this._rootObserver = null;
    }
    if (this._bodyObserver) {
      this._bodyObserver.disconnect();
      this._bodyObserver = null;
    }
    if (this._bodyObserverTimeout) {
      clearTimeout(this._bodyObserverTimeout);
      this._bodyObserverTimeout = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
      this.log('MutationObserver disconnected');
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._maxDebounceTimer) {
      clearTimeout(this._maxDebounceTimer);
      this._maxDebounceTimer = null;
    }
    this._observedContainer = null;
    this._pendingMatch = false;
    this.isMatching = false;
    this.onMatch = null;
    this.activeLanguage = null;
    this.recordDebugEvent('WATCH_STOPPED', {});
  }

  /**
   * @returns {boolean} Whether any observer is currently active
   */
  isWatching() {
    return this.observer !== null || this._rootObserver !== null || this._bodyObserver !== null;
  }

  /**
   * MutationObserver callback: if currently matching, mark pending and return;
   * otherwise schedule debounced match with max wait.
   */
  _handleMutation() {
    if (this.isMatching) {
      this._pendingMatch = true;
      this.recordDebugEvent('MUTATION_PENDING', {});
      return;
    }
    this._scheduleMatch();
  }

  /**
   * Debounce scheduling with max wait.
   * First mutation sets both a 300ms debounce timer and a 1000ms max wait timer.
   * Subsequent mutations reset only the debounce timer; the max wait timer
   * ensures the match eventually fires even under high-frequency mutations.
   */
  _scheduleMatch() {
    // Clear existing debounce
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // Set max wait timer on first schedule only
    if (!this._maxDebounceTimer) {
      this._maxDebounceTimer = setTimeout(() => {
        this._maxDebounceTimer = null;
        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
          this._debounceTimer = null;
        }
        this.recordDebugEvent('MATCH_DEBOUNCE_MAX_WAIT', {});
        this._executeMatch();
      }, 1000);
    }

    // Set debounce timer
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (this._maxDebounceTimer) {
        clearTimeout(this._maxDebounceTimer);
        this._maxDebounceTimer = null;
      }
      this._executeMatch();
    }, 300);
  }

  /**
   * Body MutationObserver callback: detect when .player-timedtext-text-container appears.
   * When found, disconnect body observer, clear timeout, reattach direct observer,
   * and start root replacement observer.
   */
  _handleBodyMutation() {
    const container = document.querySelector(this.subtitleSelector);
    if (!container) return;

    // Container appeared — switch to direct observer on the container
    this.log('Subtitle container appeared, switching to direct observer');
    if (this._bodyObserver) {
      this._bodyObserver.disconnect();
      this._bodyObserver = null;
    }
    if (this._bodyObserverTimeout) {
      clearTimeout(this._bodyObserverTimeout);
      this._bodyObserverTimeout = null;
    }

    this._reattachDirectObserver(container);
    this._startRootObserver();
    this.recordDebugEvent('WATCH_CONTAINER_FOUND_AND_ATTACHED', { selector: this.subtitleSelector });
  }

  /**
   * Timeout handler: called if the subtitle container never appears within 30s.
   * Disconnects the body observer and stops watching.
   */
  _handleBodyObserverTimeout() {
    this.log('Timeout waiting for subtitle container, stopping');
    this.recordDebugEvent('WATCH_CONTAINER_TIMEOUT', { selector: this.subtitleSelector });
    this.stopWatching();
  }

  /**
   * Start lightweight root observer to detect container replacement.
   * Watches document.body for childList/subtree mutations and checks
   * whether the subtitle container has been replaced.
   */
  _startRootObserver() {
    if (this._rootObserver) return; // Already started

    this._rootObserver = new MutationObserver(() => this._handleRootMutation());
    this._rootObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    this.recordDebugEvent('ROOT_OBSERVER_STARTED', { selector: this.subtitleSelector });
  }

  /**
   * Root MutationObserver callback: detect when the subtitle container node is replaced.
   * Compares current queried container against the observed reference; if different,
   * reattaches the direct observer and triggers a match.
   */
  _handleRootMutation() {
    const container = document.querySelector(this.subtitleSelector);
    if (!container) return;

    // Same container node — nothing to do
    if (container === this._observedContainer) return;

    this.log('Subtitle container node replaced, reattaching direct observer');
    this.recordDebugEvent('CONTAINER_REPLACED', {
      previousContainer: !!this._observedContainer,
      newContainer: !!container
    });

    this._reattachDirectObserver(container);

    // Trigger match on the new container (it already has text showing)
    if (!this.isMatching) {
      this._scheduleMatch();
    } else {
      this._pendingMatch = true;
    }
  }

  /**
   * Attach or reattach direct MutationObserver to the given container node.
   * Disconnects any previous direct observer first.
   */
  _reattachDirectObserver(container) {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.observer = new MutationObserver(() => this._handleMutation());
    this.observer.observe(container, {
      subtree: true,
      characterData: true,
      childList: true
    });
    this._observedContainer = container;
    this.recordDebugEvent('DIRECT_OBSERVER_ATTACHED', {});
  }

  /**
   * Debounced match execution: collect DOM sample, find best match, call onMatch callback.
   * After completion, re-runs if a pending match was queued during execution.
   */
  async _executeMatch() {
    if (this.isMatching) return;
    if (!this.activeLanguage || !this.onMatch) return;

    this.isMatching = true;
    this.recordDebugEvent('WATCH_DEBOUNCE_FIRED', {});

    try {
      const sample = this.collectDOMSample();
      if (!sample) {
        this.isMatching = false;
        return;
      }

      const result = await this.findBestMatch(this.activeLanguage, { domSample: sample });

      if (this.onMatch) {
        this.onMatch(result);
      }
    } catch (error) {
      this.log('Match handler error:', error.message);
      this.recordDebugEvent('WATCH_MATCH_ERROR', { error: error.message });
    } finally {
      this.isMatching = false;

      // If a mutation arrived while we were matching, re-schedule via debounce / max-wait
      if (this._pendingMatch) {
        this._pendingMatch = false;
        this.recordDebugEvent('PENDING_MATCH_EXECUTING', {});
        this._scheduleMatch();
      }
    }
  }

  // ==================== DOM Sample Collection ====================

  /**
   * 收集 Netflix 原生字幕 DOM 文字樣本
   * @returns {Object|null} { text, normalizedText, timestamp, collectedAt, videoId, epoch }
   */
  collectDOMSample() {
    const container = document.querySelector(this.subtitleSelector);
    if (!container) {
      this.recordDebugEvent('DOM_SAMPLE_NO_CONTAINER', { selector: this.subtitleSelector });
      return null;
    }

    // Netflix 原生字幕結構：.player-timedtext-text-container 內含多個 span
    // Netflix karaoke 模式會在同一個 container 內產生重複 span（完整行 + 分詞片段），
    // 若直接串接所有 span 會使 DOM 文字長度膨脹，導致 overlap score 偏低而通過不了門檻。
    //
    // 採樣策略（依優先順序）：
    // 1. leaf spans — 不含子 span 的葉節點 span，最接近實際顯示文字
    // 2. all spans — 降級到既有邏輯：取所有 span 去重
    // 3. container textContent — 最後手段
    const spans = container.querySelectorAll('span');

    // Strategy 1: prefer visible leaf spans (no nested span children, element visible)
    const leafTexts = [];
    for (const span of spans) {
      if (span.querySelector('span') !== null) continue;
      if (!this._isVisible(span)) continue;
      const t = (span.textContent || '').trim();
      if (t) leafTexts.push(t);
    }

    let spanTexts;
    let sampleStrategy;
    if (leafTexts.length > 0) {
      spanTexts = leafTexts;
      sampleStrategy = 'leaf-spans';
    } else {
      // Strategy 2: fallback to all spans (existing dedup logic)
      spanTexts = [];
      for (const span of spans) {
        const t = (span.textContent || '').trim();
        if (t) spanTexts.push(t);
      }
      sampleStrategy = 'all-spans';
    }

    if (spanTexts.length === 0) {
      // Strategy 3: fallback to container textContent
      const containerText = (container.textContent || '').trim();
      if (containerText) {
        spanTexts = [containerText];
        sampleStrategy = 'container-text';
      } else {
        this.recordDebugEvent('DOM_SAMPLE_EMPTY', {});
        return null;
      }
    }

    // 依長度降冪排序（最長優先），確保完整行最先被加入 collected。
    // 最終輸出仍保留原 DOM 順序，避免多行字幕被長度排序改變語意。
    const sortedTexts = spanTexts
      .map((text, index) => ({ text, index }))
      .sort((a, b) => b.text.length - a.text.length);

    const collected = [];
    const keptIndexes = new Set();
    for (const item of sortedTexts) {
      const t = item.text;
      // 若當前的 span 文字已完全包含在已收集的文字中，跳過（去重）
      if (collected.join('').includes(t)) continue;
      collected.push(t);
      keptIndexes.add(item.index);
    }

    const text = spanTexts.filter((_, index) => keptIndexes.has(index)).join('').trim();

    const context = this.getCurrentContext();
    const normalizedText = this.normalizeText(text);

    // Use real-time timestamp from video element as primary source.
    // PlaybackContext snapshot currentTime only as fallback (may be stale after autoplay,
    // e.g. during A→B episode transition).
    let timestamp = getCurrentTimestamp();
    let timestampSource = 'videoElement';
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
      const snapshotCurrentTime = context?.snapshot?.currentTime;
      if (typeof snapshotCurrentTime === 'number' && Number.isFinite(snapshotCurrentTime) && snapshotCurrentTime >= 0) {
        timestamp = snapshotCurrentTime / 1000; // Convert ms to seconds
        timestampSource = 'playbackContextFallback';
      } else {
        timestamp = 0;
        timestampSource = 'invalid';
      }
    }

    const sample = {
      text,
      normalizedText,
      timestamp,
      collectedAt: Date.now(),
      videoId: context.videoId,
      epoch: context.epoch
    };

    this.lastSample = sample;

    this.recordDebugEvent('DOM_SAMPLE_COLLECTED', {
      textLength: text.length,
      normalizedLength: normalizedText.length,
      timestamp: sample.timestamp,
      timestampSource,
      videoId: sample.videoId,
      epoch: sample.epoch,
      strategy: sampleStrategy
    });

    return sample;
  }

  /**
   * 取得目前 PlaybackContext，降級使用 video-info fallback
   */
  getCurrentContext() {
    try {
      const context = playbackContextManager.getCurrentContext();
      if (context?.videoId) {
        return context;
      }
    } catch (error) {
      this.log('getCurrentContext 失敗:', error.message);
    }

    return {
      epoch: null,
      videoId: getVideoId(),
      sessionId: null,
      state: 'fallback',
      source: 'fallback'
    };
  }

  // ==================== Candidate Fetch & Filter ====================

  /**
   * 透過 page script 取得 raw TTML pool 中符合條件的候選
   * @param {string} languageCode - 目標語言代碼
   * @returns {Array<Object>} 候選陣列
   */
  async fetchCandidates(languageCode) {
    let response;
    try {
      response = await sendMessageToPageScript({
        type: 'GET_ALL_INTERCEPTED_TTML'
      });
    } catch (error) {
      this.recordDebugEvent('CANDIDATE_FETCH_ERROR', { error: error.message });
      return [];
    }

    if (!response?.success || !response.allTTMLs) {
      this.recordDebugEvent('CANDIDATE_FETCH_FAILED', {
        error: response?.error || 'no-data'
      });
      return [];
    }

    const context = this.getCurrentContext();
    const candidates = [];
    const entries = Object.entries(response.allTTMLs);

    for (const [cacheKey, data] of entries) {
      // 語言過濾：使用 base-code fallback matching
      if (!this.matchesLanguage(data?.language, languageCode)) {
        continue;
      }

      const requestInfo = data?.requestInfo || {};

      // request session 檢查：若存在，必須為 watch-*
      const sessionId = requestInfo.sessionIdAtRequest ||
        requestInfo.playbackSnapshot?.sessionId || null;
      if (sessionId && !sessionId.startsWith('watch-')) {
        this.recordDebugEvent('CANDIDATE_SKIPPED_NON_WATCH', { cacheKey, sessionId });
        continue;
      }

      const rawContent = data?.rawContent || '';
      if (!rawContent) {
        continue;
      }

      // parse 確認
      try {
        const parseResult = parseSubtitle(rawContent);
        const subtitles = parseResult?.subtitles || [];
        if (subtitles.length === 0) {
          this.recordDebugEvent('CANDIDATE_PARSE_EMPTY', { cacheKey });
          continue;
        }

        candidates.push({
          cacheKey,
          language: data.language,
          rawContent,
          subtitles,
          subtitlesCount: subtitles.length,
          requestInfo,
          rawMetadata: data?.rawMetadata || data?.metadata || requestInfo?.rawTtmlMetadata || null,
          requestTime: requestInfo?.requestTime || data?.timestamp || 0
        });
      } catch (error) {
        this.recordDebugEvent('CANDIDATE_PARSE_ERROR', { cacheKey, error: error.message });
        continue;
      }
    }

    this.recordDebugEvent('CANDIDATES_FETCHED', {
      languageCode,
      totalRawEntries: entries.length,
      candidateCount: candidates.length
    });

    return candidates;
  }

  /**
   * 語言匹配（支援 base-code fallback）
   */
  matchesLanguage(actual, target) {
    if (!actual || !target) return false;
    if (actual.toLowerCase() === target.toLowerCase()) return true;
    // base-code fallback：如 zh-Hant → zh
    const baseA = actual.split('-')[0].toLowerCase();
    const baseB = target.split('-')[0].toLowerCase();
    return baseA === baseB;
  }

  // ==================== Text Normalization & Unitization ====================

  /**
   * 文字正規化
   * - 移除 HTML tags
   * - 移除零寬字元
   * - 正規化 <br>、換行、連續空白 → 單一空白
   * - 統一全形/半形空白
   */
  normalizeText(text) {
    if (!text) return '';
    let result = text;

    // 1. 移除 HTML tags
    result = result.replace(/<[^>]*>/g, '');

    // 2. 移除零寬字元
    result = result.replace(/[\u200B-\u200D\uFEFF]/g, '');

    // 3. 正規化 <br>（大小寫）、換行為空白
    result = result.replace(/<br\s*\/?>/gi, ' ');
    result = result.replace(/[\r\n]+/g, ' ');

    // 4. 全形空白 → 半形
    result = result.replace(/\u3000/g, ' ');

    // 5. 連續空白壓縮並 trim
    result = result.replace(/\s+/g, ' ').trim();

    return result;
  }

  /**
   * 將正規化後文字轉為比對用的 unit 陣列（逐字元，支援 CJK）
   */
  textToUnits(text) {
    if (!text) return [];
    return [...text];
  }

  // ==================== Cue Window & Scoring ====================

  /**
   * 從已解析字幕陣列中找出與指定時間匹配的 cue
   * @param {Array} subtitles - 已解析字幕陣列
   * @param {number} timestamp - 目前播放時間（秒）
   * @param {number} toleranceMs - 容忍範圍（毫秒）
   * @returns {Array} 匹配到的 cue 陣列
   */
  findMatchingCues(subtitles, timestamp, toleranceMs = 750) {
    const tolerance = toleranceMs / 1000;
    const candidates = [];

    for (const subtitle of subtitles) {
      if (subtitle.startTime == null || subtitle.endTime == null) continue;

      // 檢查是否在窗口內
      if (timestamp >= (subtitle.startTime - tolerance) &&
          timestamp <= (subtitle.endTime + tolerance)) {
        candidates.push(subtitle);
      }
    }

    // 優先回傳 exact match（不靠 tolerance 邊界）
    const exact = candidates.filter(cue =>
      timestamp >= cue.startTime && timestamp <= cue.endTime
    );

    return exact.length > 0 ? exact : candidates;
  }

  /**
   * 計算 overlap score
   * score = matchedUnits / max(domUnits.length, minComparableUnits)
   */
  computeOverlapScore(domUnits, cueUnits) {
    if (domUnits.length === 0) {
      return { score: 0, matchedUnits: 0, totalDomUnits: 0 };
    }

    let matchedCount = 0;
    const remaining = [...cueUnits];

    for (const domUnit of domUnits) {
      const idx = remaining.indexOf(domUnit);
      if (idx !== -1) {
        matchedCount++;
        remaining.splice(idx, 1); // 避免重複匹配同字元
      }
    }

    const denominator = Math.max(domUnits.length, this.minComparableUnits);
    const score = denominator > 0 ? matchedCount / denominator : 0;

    return { score, matchedUnits: matchedCount, totalDomUnits: domUnits.length };
  }

  /**
   * 檢查 score 是否通過門檻
   */
  isScorePassing(domLength, score) {
    if (domLength < 3) return false;
    if (domLength >= 6) return score >= 0.75;
    // 3-5 chars
    return score >= 0.90;
  }

  /**
   * 對單一候選評分
   * @returns {Object} 評分結果
   */
  scoreCandidate(domSample, candidate) {
    const domUnits = this.textToUnits(domSample.normalizedText);
    const domLength = domUnits.length;

    if (domLength < 3) {
      return {
        ...this.emptyScoreResult(candidate),
        failureReason: 'dom-too-short'
      };
    }

    // 找出匹配時間的 cue
    const matchingCues = this.findMatchingCues(
      candidate.subtitles,
      domSample.timestamp,
      this.cueWindowMs
    );

    if (matchingCues.length === 0) {
      return {
        ...this.emptyScoreResult(candidate),
        failureReason: 'no-cue-at-timestamp'
      };
    }

    // 合併同時間多 cue 的文字
    let cueText = '';
    for (const cue of matchingCues) {
      if (cueText) cueText += ' ';
      cueText += cue.text || '';
    }
    cueText = cueText.trim();

    if (!cueText) {
      return {
        ...this.emptyScoreResult(candidate),
        failureReason: 'cue-text-empty'
      };
    }

    const normalizedCueText = this.normalizeText(cueText);
    const cueUnits = this.textToUnits(normalizedCueText);

    const { score, matchedUnits } = this.computeOverlapScore(domUnits, cueUnits);
    const passing = this.isScorePassing(domLength, score);

    return {
      cacheKey: candidate.cacheKey,
      language: candidate.language,
      score,
      matchedUnits,
      totalDomUnits: domLength,
      totalCueUnits: cueUnits.length,
      threshold: domLength >= 6 ? 0.75 : 0.90,
      passing,
      // debug payload 保留 raw text
      domText: domSample.text,
      cueText,
      normalizedDomText: domSample.normalizedText,
      normalizedCueText,
      failureReason: passing ? null : 'score-below-threshold',
      subtitlesCount: candidate.subtitlesCount,
      requestTime: candidate.requestTime,
      requestInfo: candidate.requestInfo,
      rawMetadata: candidate.rawMetadata,
      // 保留 rawContent，讓呼叫端可用原始 TTML 重新處理匹配結果
      rawContent: candidate.rawContent
    };
  }

  /**
   * 空評分結果（候選無效時使用）
   */
  emptyScoreResult(candidate) {
    return {
      cacheKey: candidate?.cacheKey || null,
      language: candidate?.language || null,
      score: 0,
      matchedUnits: 0,
      totalDomUnits: 0,
      totalCueUnits: 0,
      threshold: 0,
      passing: false,
      domText: null,
      cueText: null,
      normalizedDomText: null,
      normalizedCueText: null,
      failureReason: 'no-candidate',
      subtitlesCount: candidate?.subtitlesCount || 0,
      requestTime: candidate?.requestTime || 0,
      requestInfo: candidate?.requestInfo || {},
      rawMetadata: candidate?.rawMetadata || null,
      rawContent: candidate?.rawContent || null
    };
  }

  // ==================== Ranking ====================

  /**
   * 對所有通過門檻的結果排名
   * 排序：score 高 → subtitlesCount 多 → requestTime 新
   */
  rankResults(results) {
    const passing = results.filter(r => r.passing);

    passing.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.subtitlesCount !== b.subtitlesCount) return b.subtitlesCount - a.subtitlesCount;
      return b.requestTime - a.requestTime;
    });

    return passing;
  }

  // ==================== Main Entry ====================

  /**
   * 主入口：收集 DOM sample → 取得候選 → 評分 → 排名 → 回傳最佳匹配
   * @param {string} languageCode - 目標語言代碼
   * @param {Object} [options] - 可選參數
   * @param {Object} [options.domSample] - 外部傳入的 DOM sample，避免重複 collect
   * @returns {Object} { matched, result, allResults, failureReason }
   */
  async findBestMatch(languageCode, options = {}) {
    this.recordDebugEvent('MATCH_STARTED', { languageCode, hasExternalSample: !!options?.domSample });

    // Step 1: 收集 DOM sample（支援外部傳入，避免同一 attempt 重複 collect）
    const domSample = options?.domSample || this.collectDOMSample();
    if (!domSample) {
      this.recordDebugEvent('MATCH_FAILED_NO_SAMPLE', { languageCode });
      return {
        matched: false,
        result: null,
        allResults: [],
        failureReason: 'no-dom-sample'
      };
    }

    // Step 2: 取得候選
    const candidates = await this.fetchCandidates(languageCode);
    if (candidates.length === 0) {
      this.recordDebugEvent('MATCH_FAILED_NO_CANDIDATES', { languageCode });
      return {
        matched: false,
        result: null,
        allResults: [],
        failureReason: 'no-candidates'
      };
    }

    // Step 3: 評分
    const allResults = candidates.map(candidate =>
      this.scoreCandidate(domSample, candidate)
    );

    // Step 4: 排名
    const ranked = this.rankResults(allResults);

    if (ranked.length === 0) {
      this.recordDebugEvent('MATCH_FAILED_NO_PASSING', {
        languageCode,
        totalCandidates: candidates.length,
        results: allResults.map(r => ({
          cacheKey: r.cacheKey,
          score: Math.round(r.score * 1000) / 1000,
          passing: r.passing,
          failureReason: r.failureReason,
          subtitlesCount: r.subtitlesCount
        }))
      });
      return {
        matched: false,
        result: null,
        allResults,
        failureReason: 'no-passing-candidate'
      };
    }

    const best = ranked[0];

    this.recordDebugEvent('MATCH_SUCCEEDED', {
      languageCode,
      cacheKey: best.cacheKey,
      score: Math.round(best.score * 1000) / 1000,
      matchedUnits: best.matchedUnits,
      domTextPreview: (best.domText || '').substring(0, 80),
      cueTextPreview: (best.cueText || '').substring(0, 80)
    });

    return {
      matched: true,
      result: best,
      allResults
    };
  }

  /**
   * 共用 match runner：collect DOM sample（或使用外部傳入的 sample） → findBestMatch。
   * Observer 與 polling 可共用此方法，避免重複 collect 與互相干擾。
   *
   * @param {string} languageCode
   * @param {Object} [options]
   * @param {Object} [options.domSample] - 外部傳入的 DOM sample
   * @param {string} [options.source] - 呼叫來源（用於 debug event）
   * @returns {Promise<Object>} findBestMatch 的結果
   */
  async runMatchOnce(languageCode, { domSample, source } = {}) {
    // Real shared match lock: if matcher is busy (observer _executeMatch or another runMatchOnce),
    // mark pending and return immediately instead of running fetchCandidates/parse in parallel.
    if (this.isMatching) {
      this._pendingMatch = true;
      this.recordDebugEvent('RUN_MATCH_ONCE_DEFERRED_MATCHER_BUSY', { languageCode, source: source || 'unknown' });
      return {
        matched: false,
        result: null,
        allResults: [],
        failureReason: 'matcher-busy'
      };
    }

    this.isMatching = true;
    this.recordDebugEvent('RUN_MATCH_ONCE', { languageCode, source: source || 'unknown' });

    try {
      return await this.findBestMatch(languageCode, { domSample });
    } finally {
      this.isMatching = false;

      // If a pending match was queued while we were matching, re-schedule via debounce / max-wait
      if (this._pendingMatch) {
        this._pendingMatch = false;
        this.recordDebugEvent('PENDING_MATCH_EXECUTING', {});
        this._scheduleMatch();
      }
    }
  }

  // ==================== Debug ====================

  /**
   * 取得 Debug 快照
   */
  getDebugInfo() {
    return {
      lastSample: this.lastSample ? {
        text: this.lastSample.text?.substring(0, 100) || '',
        normalizedText: this.lastSample.normalizedText?.substring(0, 100) || '',
        timestamp: this.lastSample.timestamp,
        collectedAt: this.lastSample.collectedAt,
        videoId: this.lastSample.videoId,
        epoch: this.lastSample.epoch
      } : null,
      debugEvents: this.debugEvents.slice(-10),
      config: {
        subtitleSelector: this.subtitleSelector,
        cueWindowMs: this.cueWindowMs,
        minComparableUnits: this.minComparableUnits
      }
    };
  }
}

export { DOMOverlapMatcher };

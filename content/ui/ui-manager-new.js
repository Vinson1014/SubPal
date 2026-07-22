/**
 * UI 管理器 - 新的模塊化 UI 協調器
 * 
 * 設計理念：
 * 1. 協調者角色：只負責協調各個 UI 組件，不直接處理 UI 操作
 * 2. 統一接口：為外部提供統一的 UI 操作接口
 * 3. 組件解耦：各個 UI 組件獨立運作，通過管理器協調
 * 4. 事件中轉：作為組件間事件傳遞的中介
 */

import { SubtitleDisplay } from './subtitle-display.js';
import { InteractionPanel } from './interaction-panel.js';
import { SubmissionDialog } from './submission-dialog.js';
import { FullscreenHandler } from './fullscreen-handler.js';
import { UIAvoidanceHandler } from './ui-avoidance-handler.js';
import { ToastManager } from './toast-manager.js';
import { getPlayerAdapter } from './netflix-player-adapter.js';
import { sendMessage, registerInternalEventHandler, dispatchInternalEvent } from '../system/messaging.js';
import { SubtitleReplacer } from '../core/subtitle-replacer.js';

const MS_PER_SECOND = 1000;

class UIManager {
  constructor() {
    this.isInitialized = false;
    this.subtitleDisplay = null;
    this.interactionPanel = null;
    this.submissionDialog = null;
    this.fullscreenHandler = null;
    this.uiAvoidanceHandler = null;
    this.toastManager = null;
    this.debugOverlay = null; // 待實現
    
    // Netflix播放器適配器
    this.playerAdapter = getPlayerAdapter();
    
    // 當前狀態
    this.currentSubtitle = null;
    this.currentMode = null;
    this.nativeSubtitleHidden = false;
    this.nativeHideReason = 'not-hidden';
    this.nativeSubtitleVisibilityUpdatedAt = null;
    this.acquisitionToastKeys = new Set();
    
    // 備援通知狀態機（fallback/recovery toast 控制）
    this.recoveryNotificationState = null;
    this._pendingRecoveryIsTransition = false;

    // 懸停事件管理
    this.hoverEventHandlers = null;
    this.lastSubtitleContainer = null;
    this.lastInteractionContainer = null;
    
    // 播放器尺寸監聽
    this.playerObserver = null;
    
    // 事件回調
    this.eventCallbacks = {
      onModeSelected: null,
      onUIReady: null,
      onError: null
    };
    this.internalEventDisposers = [];
    this._componentReinitializationPromise = null;
    this._componentGeneration = 0;
    this._pendingVideoChangeEvent = null;
    
    // 調試模式（將由 ConfigBridge 設置）
    this.debug = false;
    
    // 核心模組
    this.subtitleReplacer = null;
    this.translationBridge = null;
    this.voteBridge = null;
  }

  async initialize() {
    this.log('UI 管理器初始化中...');

    try {
      // 導入 ConfigBridge（專為 Page Context 設計）
      const { configBridge } = await import('../system/config/config-bridge.js');

      // 從 ConfigBridge 讀取配置（從本地緩存，無需 chrome API）
      this.debug = configBridge.get('debugMode');
      this.log(`調試模式設置為: ${this.debug}`);

      // 訂閱配置變更（通過 messaging 接收通知）
      configBridge.subscribe('debugMode', (newValue) => {
        this.debug = newValue;
        this.log(`調試模式已更新: ${newValue}`);
      });

      // 保存 ConfigBridge 實例供其他方法使用
      this.configBridge = configBridge;

      // 設置事件處理器
      this.setupEventHandlers();
      
      // 初始化所有UI組件
      await this.initializeComponents();
      
      // 初始化核心模組
      this.subtitleReplacer = new SubtitleReplacer();
      await this.subtitleReplacer.initialize();
      
      // 動態導入並初始化翻譯橋接器
      const { translationBridge } = await import('../core/translation-bridge.js');
      this.translationBridge = translationBridge;
      if (!this.translationBridge.isInitialized) {
        await this.translationBridge.initialize();
      }

      // 動態導入並初始化投票橋接器
      const { voteBridge } = await import('../core/vote-bridge.js');
      this.voteBridge = voteBridge;
      if (!this.voteBridge.isInitialized) {
        await this.voteBridge.initialize();
      }
      
      // 設置組件間的事件關聯
      this.setupComponentInteractions();
      
      // 設置播放器監聽
      this.setupPlayerObserver();
      
      this.isInitialized = true;
      this.log('UI 管理器初始化完成');

      // 定期檢查永久同步失敗並還原 UI
      this._permanentFailureCheckInterval = setInterval(() => {
        this.checkAndRevertPermanentFailures();
      }, 5000);

      // 觸發 UI 就緒回調
      this.triggerCallback('onUIReady');
      
    } catch (error) {
      console.error('UI 管理器初始化失敗:', error);
      this.triggerCallback('onError', error);
      throw error;
    }
  }

  // 統一的字幕顯示接口
  async showSubtitle(subtitleData) {
    if (this._componentReinitializationPromise || !this.isInitialized) {
      if (this._componentReinitializationPromise) {
        return;
      }
      console.error('UI 管理器未初始化');
      return;
    }
    const componentGeneration = this._componentGeneration;

    this.syncNativeSubtitleVisibilityForSubtitle(subtitleData, 'show-subtitle');
    
    // 檢查是否需要更新（避免重複處理相同字幕）
    if (this.shouldUpdateSubtitle(subtitleData)) {
      this.log('顯示字幕', subtitleData);
      
      // 處理字幕替換（如果啟用）
      let processedSubtitle = subtitleData;
      if (this.subtitleReplacer && this.subtitleReplacer.isInitialized) {
        try {
          const replacedSubtitle = await this.subtitleReplacer.processSubtitle(
            subtitleData, 
            subtitleData.videoId || 'unknown', 
            subtitleData.timestamp ?? Date.now() / MS_PER_SECOND
          );

          if (componentGeneration !== this._componentGeneration || !this.isInitialized) {
            return;
          }
          
          // 防禦性檢查：如果已顯示更新的字幕，跳過這次過時的更新
          if (this.currentSubtitle && this.currentSubtitle.timestamp > subtitleData.timestamp) {
            this.log('跳過過時字幕更新，已有更新的字幕顯示');
            return;
          }
          
          if (replacedSubtitle) {
            processedSubtitle = replacedSubtitle;
            this.log('字幕已替換:', {
              original: subtitleData.text,
              replaced: replacedSubtitle.text
            });
          }
        } catch (error) {
          console.error('字幕替換處理失敗:', error);
          if (componentGeneration !== this._componentGeneration || !this.isInitialized) {
            return;
          }
        }
      }
      
      // 再次檢查：非阻塞流程下可能已有更新的字幕被顯示
      if (this.currentSubtitle && this.currentSubtitle.timestamp > subtitleData.timestamp) {
        this.log('跳過過時字幕更新（二次檢查），已有更新的字幕顯示');
        return;
      }
      
      // 根據模式處理位置計算
      if (processedSubtitle.mode === 'intercept') {
        // 攔截模式：位置已在 subtitle-interceptor.js 中計算完成
        this.log('攔截模式：使用預計算位置', {
          position: processedSubtitle.position,
        });
      } else if (processedSubtitle.mode === 'dom') {
        // DOM監聽模式：直接使用原生字幕位置
        this.log('DOM監聽模式：使用原生字幕位置:', processedSubtitle.position);
      }
      
      this.currentSubtitle = processedSubtitle;

      // 顯示字幕
      this.subtitleDisplay.show(processedSubtitle);

      // 檢查是否有權威投票數據，若有則更新當前字幕
      // 但若有正在進行的 pending 投票，則跳過權威覆蓋，避免樂觀 UI 被舊數據覆蓋
      if (processedSubtitle.translationID) {
        try {
          const { voteStateByTranslation, voteQueue } = await chrome.storage.local.get([
            'voteStateByTranslation', 'voteQueue'
          ]);
          if (componentGeneration !== this._componentGeneration || !this.isInitialized) {
            return;
          }
          const authoritative = voteStateByTranslation?.[processedSubtitle.translationID];
          const hasPendingVote = voteQueue?.some(item =>
            item.translationID === processedSubtitle.translationID &&
            (item.status === 'pending' || item.status === 'syncing')
          );
          if (authoritative && !authoritative.pending && !hasPendingVote) {
            processedSubtitle = {
              ...processedSubtitle,
              myVote: authoritative.myVote,
              upvotes: authoritative.upvotes,
              downvotes: authoritative.downvotes
            };
            this.currentSubtitle = processedSubtitle;
            this.log('已應用權威投票數據:', authoritative);
          } else if (hasPendingVote) {
            this.log('跳過權威投票數據覆蓋，因為有正在進行的投票:', processedSubtitle.translationID);
          }
        } catch (e) {
          console.warn('讀取權威投票數據失敗:', e);
          if (componentGeneration !== this._componentGeneration || !this.isInitialized) {
            return;
          }
        }
      }

      // 更新投票計數和狀態
      this.updateVoteDisplay(processedSubtitle);
      
      // 在雙語模式下，為 currentSubtitle 添加 primaryContainer 引用
      if (processedSubtitle.isDualSubtitle && this.subtitleDisplay.primaryContainer) {
        this.currentSubtitle.primaryContainer = this.subtitleDisplay.primaryContainer;
        this.log('已添加 primaryContainer 引用至 currentSubtitle');
      }
      
      // 註：移除了註冊邏輯，改用動態查找 #subpal-region-container
      
      // 設置懸停事件來控制交互面板（只在首次設置或字幕變化時）
      this.setupSubtitleHoverEvents();
    }
  }

  // 統一的字幕隱藏接口
  hideSubtitle() {
    if (!this.isInitialized) {
      return;
    }

    this.log('隱藏字幕');
    this.currentSubtitle = null;
    
    // 隱藏字幕和交互面板
    this.subtitleDisplay.hide();
    this.interactionPanel.hide();
    
    // 清理懸停事件
    this.clearSubtitleHoverEvents();
  }

  // 檢查是否需要更新字幕（避免重複處理）
  shouldUpdateSubtitle(newSubtitleData) {
    if (!this.currentSubtitle) {
      return true; // 首次顯示
    }

    // 檢查主要文本是否有變化
    const hasTextChanged = this.currentSubtitle.text !== newSubtitleData.text;

    // 檢查雙語字幕的次要文本是否有變化
    const hasSecondaryTextChanged = this.hasSecondaryTextChanged(
      this.currentSubtitle.dualSubtitleData,
      newSubtitleData.dualSubtitleData
    );

    // 檢查位置是否有變化
    const hasPositionChanged = this.hasPositionChanged(this.currentSubtitle.position, newSubtitleData.position);

    // 檢查時間戳是否有顯著變化（超過 0.5 秒）
    const hasTimestampChanged = Math.abs(this.currentSubtitle.timestamp - newSubtitleData.timestamp) > 0.5;

    return hasTextChanged || hasSecondaryTextChanged || hasPositionChanged || hasTimestampChanged;
  }

  // 檢查雙語字幕的次要文本是否有變化
  hasSecondaryTextChanged(oldDualData, newDualData) {
    // 如果兩者都不存在，則沒有變化
    if (!oldDualData && !newDualData) {
      return false;
    }

    // 如果只有一個存在，則有變化
    if (!oldDualData || !newDualData) {
      return true;
    }

    // 檢查次要字幕文本是否有變化
    return oldDualData.secondaryText !== newDualData.secondaryText;
  }

  // 檢查位置是否有顯著變化
  hasPositionChanged(oldPosition, newPosition) {
    if (!oldPosition || !newPosition) {
      return true; // 任一位置為空視為變化
    }

    const threshold = 5; // 5 像素以內的變化忽略

    // 檢查 displayAlign 是否有變化（處理可能為空的情況）
    const oldDisplayAlign = oldPosition.displayAlign || null;
    const newDisplayAlign = newPosition.displayAlign || null;
    const hasDisplayAlignChanged = oldDisplayAlign !== newDisplayAlign;

    return (
      Math.abs(oldPosition.left - newPosition.left) > threshold ||
      Math.abs(oldPosition.top - newPosition.top) > threshold ||
      Math.abs(oldPosition.width - newPosition.width) > threshold ||
      Math.abs(oldPosition.height - newPosition.height) > threshold ||
      hasDisplayAlignChanged
    );
  }

  // 設置字幕懸停事件（參考舊版實現）
  setupSubtitleHoverEvents() {
    if (!this.currentSubtitle) return;
    
    const subtitleContainer = this.subtitleDisplay.getContainer();
    const interactionContainer = this.interactionPanel.getContainer();
    
    if (!subtitleContainer || !interactionContainer) {
      this.log('找不到字幕容器或交互面板容器');
      return;
    }
    
    // 檢查是否已經設置過事件監聽器（避免重複設置）
    if (this.hoverEventHandlers && 
        this.lastSubtitleContainer === subtitleContainer &&
        this.lastInteractionContainer === interactionContainer) {
      this.log('懸停事件已設置，跳過重複設置');
      return;
    }
    
    // 清理之前的事件
    this.clearSubtitleHoverEvents();
    
    // 記錄當前容器
    this.lastSubtitleContainer = subtitleContainer;
    this.lastInteractionContainer = interactionContainer;
    
    // 設置懸停事件
    this.hoverEventHandlers = {
      subtitleMouseEnter: () => {
        this.log('滑鼠進入字幕');
        this.interactionPanel.showOnHover(this.currentSubtitle);
      },
      subtitleMouseLeave: () => {
        this.log('滑鼠離開字幕');
        this.interactionPanel.hideOnHover();
      },
      interactionMouseEnter: () => {
        this.log('滑鼠進入交互面板');
        this.interactionPanel.showOnHover(this.currentSubtitle);
      },
      interactionMouseLeave: () => {
        this.log('滑鼠離開交互面板');
        this.interactionPanel.hideOnHover();
      }
    };
    
    // 綁定事件
    subtitleContainer.addEventListener('mouseenter', this.hoverEventHandlers.subtitleMouseEnter);
    subtitleContainer.addEventListener('mouseleave', this.hoverEventHandlers.subtitleMouseLeave);
    interactionContainer.addEventListener('mouseenter', this.hoverEventHandlers.interactionMouseEnter);
    interactionContainer.addEventListener('mouseleave', this.hoverEventHandlers.interactionMouseLeave);
    
    this.log('字幕懸停事件設置完成');
  }

  // 清理懸停事件
  clearSubtitleHoverEvents() {
    if (!this.hoverEventHandlers) return;
    
    // 使用記錄的容器引用進行清理
    if (this.lastSubtitleContainer && this.hoverEventHandlers.subtitleMouseEnter) {
      this.lastSubtitleContainer.removeEventListener('mouseenter', this.hoverEventHandlers.subtitleMouseEnter);
      this.lastSubtitleContainer.removeEventListener('mouseleave', this.hoverEventHandlers.subtitleMouseLeave);
    }
    
    if (this.lastInteractionContainer && this.hoverEventHandlers.interactionMouseEnter) {
      this.lastInteractionContainer.removeEventListener('mouseenter', this.hoverEventHandlers.interactionMouseEnter);
      this.lastInteractionContainer.removeEventListener('mouseleave', this.hoverEventHandlers.interactionMouseLeave);
    }
    
    this.hoverEventHandlers = null;
    this.lastSubtitleContainer = null;
    this.lastInteractionContainer = null;
  }

  /**
   * 處理 UI 閃避位置變化
   * @param {boolean} isAvoiding - 是否正在閃避
   * @param {number} offset - 偏移量（px）
   */
  handleUIAvoidanceChange(isAvoiding, offset) {
    this.log(`UI 閃避狀態變化: isAvoiding=${isAvoiding}, offset=${offset}px`);
    
    // 如果交互面板可見，同步更新其位置
    if (this.interactionPanel && this.currentSubtitle) {
      this.log('同步更新交互面板位置');
      const componentGeneration = this._componentGeneration;
      const interactionPanel = this.interactionPanel;
      const subtitleSnapshot = {
        ...this.currentSubtitle,
        position: { ...this.currentSubtitle.position }
      };
      
      // 延遲一點時間，確保字幕容器的 transform 動畫開始
      setTimeout(() => {
        if (componentGeneration !== this._componentGeneration ||
            this.interactionPanel !== interactionPanel) {
          return;
        }

        // 更新字幕位置資訊
        const newSubtitleData = {
          ...subtitleSnapshot,
          position: {
            ...subtitleSnapshot.position,
            top: subtitleSnapshot.position.top + offset
          }
        };
        interactionPanel.updatePosition(newSubtitleData);
        this.log('延遲更新交互面板位置');
      }, 250); // 250ms 延遲，讓 CSS transition 開始
    }
  }

  // 設置事件處理器
  setupEventHandlers() {
    this.disposeInternalEventHandlers();

    this.internalEventDisposers.push(registerInternalEventHandler('SUBTITLE_READINESS_CHANGED', (event) => {
      this.syncNativeSubtitleVisibility(event.readiness?.renderReadiness, event.reason || 'subtitle-readiness-changed');
      this.handleFallbackNotification(event);
    }));

    // 監聽 primary discovery DOM sample 檢測事件
    this.internalEventDisposers.push(registerInternalEventHandler('PRIMARY_DISCOVERY_DOM_SAMPLE_DETECTED', (event) => {
      this.handleDomSampleDetected(event);
    }));

    this.internalEventDisposers.push(registerInternalEventHandler('VIDEO_ID_CHANGED', (event) => {
      this.log(`🎬 檢測到影片切換: ${event.oldVideoId} -> ${event.newVideoId}`);
      this.reinitializeVideoComponents(event).catch((error) => {
        console.error('❌ 影片切換UI重新初始化失敗:', error);
        this.handleReinitializationError(error);
      });
    }));

  }

  reinitializeVideoComponents(event) {
    this._pendingVideoChangeEvent = event;
    if (this._componentReinitializationPromise) {
      return this._componentReinitializationPromise;
    }

    const generation = ++this._componentGeneration;
    this._componentReinitializationPromise = Promise.resolve().then(async () => {
      this.isInitialized = false;
      this.clearRecoveryNotificationTimers();
      this.recoveryNotificationState = null;
      this._pendingRecoveryIsTransition = false;
      this.showNativeSubtitles('video-id-changing');
      this.acquisitionToastKeys.clear();
      this.cleanupVideoComponents();

      if (this._pendingVideoChangeEvent.newVideoId === 'unknown') {
        return;
      }

      await this.initializeComponents();
      if (generation !== this._componentGeneration) {
        this.cleanupVideoComponents();
        return;
      }

      this.setupComponentInteractions();
      this.showNativeSubtitles('video-id-changed-primary-not-ready');
      this.isInitialized = true;

      const completedEvent = this._pendingVideoChangeEvent;
      if (completedEvent.oldVideoId && completedEvent.oldVideoId !== 'unknown' &&
          completedEvent.newVideoId && completedEvent.newVideoId !== 'unknown') {
        this._pendingRecoveryIsTransition = true;
      }

      dispatchInternalEvent({
        type: 'UI_COMPONENTS_REINITIALIZED',
        reason: 'VIDEO_ID_CHANGED',
        oldVideoId: completedEvent.oldVideoId,
        newVideoId: completedEvent.newVideoId,
        timestamp: Date.now()
      });
      this.log('🎉 影片切換UI重新初始化完成！');
    }).finally(() => {
      if (generation === this._componentGeneration) {
        this._pendingVideoChangeEvent = null;
      }
      this._componentReinitializationPromise = null;
    });

    return this._componentReinitializationPromise;
  }

  disposeInternalEventHandlers() {
    for (const dispose of this.internalEventDisposers) {
      dispose();
    }
    this.internalEventDisposers = [];
  }
  async initializeComponents() {
    this.log('初始化所有UI組件...');
    
    // 初始化字幕顯示組件
    this.subtitleDisplay = new SubtitleDisplay();
    await this.subtitleDisplay.initialize();
    
    // 初始化交互面板組件
    this.interactionPanel = new InteractionPanel();
    await this.interactionPanel.initialize();
    
    // 初始化提交對話框組件
    this.submissionDialog = new SubmissionDialog();
    await this.submissionDialog.initialize();
    
    // 初始化全螢幕處理器
    this.fullscreenHandler = new FullscreenHandler();
    await this.fullscreenHandler.initialize();
    
    // 初始化 UI 閃避處理器（傳入回調函數）
    this.uiAvoidanceHandler = new UIAvoidanceHandler({
      onPositionChange: (isAvoiding, offset) => {
        this.handleUIAvoidanceChange(isAvoiding, offset);
      }
    });
    await this.uiAvoidanceHandler.initialize();
    
    // 初始化 Toast 管理器
    this.toastManager = new ToastManager();
    await this.toastManager.initialize();
    
    this.log('所有UI組件初始化完成');
    
    // 攔截模式需等待 primary TTML ready 後才隱藏原生字幕。
    this.showNativeSubtitles('ui-initialized-primary-not-ready');
  }

  // 處理重新初始化錯誤
  handleReinitializationError(error) {
    this.log('嘗試恢復基本UI狀態...');
    
    try {
      // 至少嘗試初始化字幕顯示組件
      if (!this.subtitleDisplay) {
        this.subtitleDisplay = new SubtitleDisplay();
        this.subtitleDisplay.initialize().catch(e => 
          console.error('恢復字幕顯示組件失敗:', e)
        );
      }
      
      // 觸發錯誤回調
      this.triggerCallback('onError', {
        type: 'REINITIALIZATION_FAILED',
        error: error,
        message: '影片切換時UI重新初始化失敗'
      });
      
    } catch (recoveryError) {
      console.error('UI恢復也失敗了:', recoveryError);
    }
  }

  // 設置組件間的事件關聯
  setupComponentInteractions() {
    this.log('設置組件間事件關聯');
    
    // 交互面板事件處理
    this.interactionPanel.onSubmitClick(() => {
      this.handleSubmitClick();
    });
    
    this.interactionPanel.onLikeClick(() => {
      this.handleLikeClick();
    });
    
    this.interactionPanel.onDislikeClick(() => {
      this.handleDislikeClick();
    });
    
    // 提交對話框事件處理
    this.submissionDialog.onSubmit((submissionData) => {
      return this.handleSubmissionComplete(submissionData);
    });
    
    this.submissionDialog.onCancel(() => {
      this.log('用戶取消提交');
    });
    
    this.submissionDialog.onClose(() => {
      this.log('提交對話框關閉');
    });
    
    // 將 UI 組件註冊到全螢幕處理器
    this.fullscreenHandler.registerUIComponent('subtitleDisplay', this.subtitleDisplay);
    this.fullscreenHandler.registerUIComponent('interactionPanel', this.interactionPanel);
    this.fullscreenHandler.registerUIComponent('submissionDialog', this.submissionDialog);
    
    // 設置全螢幕事件回調
    this.fullscreenHandler.onFullscreenChange((isFullscreen) => {
      this.log(`全螢幕模式變更: ${isFullscreen}`);
      this.handleFullscreenChange(isFullscreen);
    });
    
    // 註：UI 閃避處理器已改用動態查找，無需註冊元素
    // 監聽器會在找到控制欄後自動啟動
  }

  // 設置播放器尺寸變化監聽
  setupPlayerObserver() {
    this.log('設置播放器監聽器');
    
    // 嘗試獲取播放器元素
    const playerElement = this.playerAdapter.getPlayerElement();
    
    if (playerElement && window.ResizeObserver) {
      this.playerObserver = new ResizeObserver(() => {
        this.log('播放器尺寸變化');
        this.onPlayerSizeChanged();
      });
      
      this.playerObserver.observe(playerElement);
      this.log('播放器監聽器設置完成');
    } else {
      this.log('無法設置播放器監聽器 - 播放器元素未找到或瀏覽器不支援 ResizeObserver');
      
      // 後備方案：使用視窗大小變化監聽
      window.addEventListener('resize', () => {
        this.onPlayerSizeChanged();
      });
    }
  }

  // 播放器尺寸變化處理
  onPlayerSizeChanged() {
    // 清除播放器適配器的緩存，強制重新計算
    this.playerAdapter.clearCache();
    
    // 只有攔截模式才需要重新計算位置
    // DOM監聽模式會自動通過原生字幕位置變化來更新
    if (this.currentSubtitle && this.currentSubtitle.mode === 'intercept' && this.currentSubtitle.dualSubtitleData.primarySubtitle.region) {
      // 更新currentSubtitle.position(雙語字幕下此position為region的position)
      if (this.currentSubtitle.position) {
        this.currentSubtitle.position = this.playerAdapter.calculatePosition(this.currentSubtitle.dualSubtitleData.primarySubtitle.region);
      }
      this.subtitleDisplay.showDualSubtitle(this.currentSubtitle)
    } else if (this.currentSubtitle && this.currentSubtitle.mode === 'dom') {
      this.log('DOM監聽模式：位置由原生字幕變化自動處理，無需重新計算');
    }
  }

  // 處理全螢幕模式變更
  handleFullscreenChange(isFullscreen) {
    this.log(`處理全螢幕模式變更: ${isFullscreen}`);
    
    // 如果有當前字幕，確保字幕在全螢幕模式下正確顯示
    if (this.currentSubtitle) {
      // 清除播放器適配器的緩存，強制重新計算
      this.playerAdapter.clearCache();
      
      // 重新顯示字幕以確保位置正確
      this.subtitleDisplay.show(this.currentSubtitle);
      
      // 退出全螢幕模式時，如果有交互面板需要重新定位
      if (this.interactionPanel && this.interactionPanel.isVisible && !isFullscreen) {
        this.interactionPanel.show(this.currentSubtitle);
        this.interactionPanel.hide();
      }
    }
    
    // 如果有提交對話框正在顯示，確保其位置正確
    if (this.submissionDialog && this.submissionDialog.isOpen) {
      // 提交對話框會自動在播放器內部重新定位
      this.log('提交對話框將在全螢幕模式下自動重新定位');
    }
  }

  // 處理提交點擊
  handleSubmitClick() {
    this.log('處理提交點擊');
    
    if (!this.currentSubtitle) {
      console.error('沒有當前字幕數據');
      return;
    }
    
    // 打開提交對話框
    this.submissionDialog.open(this.currentSubtitle);
  }

  // 處理讚點擊
  async handleVoteClick(voteType) {
    const isLike = voteType === 'like';
    const actionLabel = isLike ? '讚' : '倒讚';
    this.log(`處理${actionLabel}點擊`);

    if (!this.currentSubtitle) {
      console.error('沒有當前字幕數據');
      return;
    }

    const currentMyVote = this.currentSubtitle.myVote || null;
    const translationID = this.currentSubtitle.translationID;

    // like/dislike→none cancels; opposite/null→vote switches or adds
    let nextVoteState;
    let likeDelta = 0;
    let dislikeDelta = 0;

    if (currentMyVote === voteType) {
      nextVoteState = 'none';
      if (isLike) {
        likeDelta = -1;
      } else {
        dislikeDelta = -1;
      }
    } else {
      nextVoteState = voteType;
      if (isLike) {
        likeDelta = 1;
        if (currentMyVote === 'dislike') {
          dislikeDelta = -1;
        }
      } else {
        dislikeDelta = 1;
        if (currentMyVote === 'like') {
          likeDelta = -1;
        }
      }
    }

    const previousVoteState = currentMyVote;
    const previousCounts = {
      like: this.currentSubtitle.upvotes ?? 0,
      dislike: this.currentSubtitle.downvotes ?? 0
    };

    const apiVoteType = isLike ? 'upvote' : 'downvote';

    this.interactionPanel.setVotePending(true);

    try {
      if (translationID) {
        // 僅對 translation-target 投票應用樂觀 UI，避免 legacy 投票（無 translationID）出現錯誤的取消/切換視覺回饋
        this.currentSubtitle.myVote = nextVoteState === 'none' ? null : nextVoteState;
        this.currentSubtitle.upvotes = Math.max(0, (this.currentSubtitle.upvotes ?? 0) + likeDelta);
        this.currentSubtitle.downvotes = Math.max(0, (this.currentSubtitle.downvotes ?? 0) + dislikeDelta);

        this.interactionPanel.setVoteCounts({
          like: this.currentSubtitle.upvotes,
          dislike: this.currentSubtitle.downvotes
        });
        this.interactionPanel.setVoteState(this.currentSubtitle.myVote);

        const voteParams = {
          videoId: this.currentSubtitle.videoId || 'unknown',
          timestamp: this.currentSubtitle.timestamp ?? Date.now() / MS_PER_SECOND,
          originalSubtitle: this.currentSubtitle.original || this.currentSubtitle.text,
          voteType: apiVoteType,
          translationID: translationID,
          slotKey: this.currentSubtitle.slotKey || null,
          voteState: nextVoteState,
          previousVoteState: previousVoteState,
          previousCounts: previousCounts
        };

        const result = await this.voteBridge.enqueue(voteParams);

        if (result && result.itemId) {
          this.showToast(`點${actionLabel}已加入隊列`, 'success');
          this.log('投票已加入隊列:', result);
        } else {
          this.showToast(`點${actionLabel}失敗`, 'error');
          this.revertOptimisticVote(previousVoteState, previousCounts);
        }
      } else {
        const voteParams = {
          videoId: this.currentSubtitle.videoId || 'unknown',
          timestamp: this.currentSubtitle.timestamp ?? Date.now() / MS_PER_SECOND,
          originalSubtitle: this.currentSubtitle.original || this.currentSubtitle.text,
          voteType: apiVoteType,
          translationID: null,
          slotKey: this.currentSubtitle.slotKey || null
        };

        const result = await this.voteBridge.enqueue(voteParams);

        if (result && result.itemId) {
          this.showToast(`點${actionLabel}已加入隊列`, 'success');
          this.log('投票已加入隊列:', result);
        } else {
          this.showToast(`點${actionLabel}失敗`, 'error');
        }
      }
    } catch (error) {
      console.error(`處理點${actionLabel}時出錯:`, error);
      this.showToast(`點${actionLabel}失敗：${error.message}`, 'error');
      if (translationID) {
        this.revertOptimisticVote(previousVoteState, previousCounts);
      }
    } finally {
      this.interactionPanel.setVotePending(false);
    }
  }

  async handleLikeClick() {
    return this.handleVoteClick('like');
  }

  async handleDislikeClick() {
    return this.handleVoteClick('dislike');
  }

  updateVoteDisplay(subtitleData) {
    if (!this.interactionPanel || !this.interactionPanel.isInitialized) return;

    const hasTranslationID = !!subtitleData.translationID;

    if (hasTranslationID) {
      this.interactionPanel.setVoteCounts({
        like: subtitleData.upvotes ?? 0,
        dislike: subtitleData.downvotes ?? 0
      });
      this.interactionPanel.setVoteState(subtitleData.myVote ?? null);
    } else {
      this.interactionPanel.setVoteCounts({ like: null, dislike: null });
      this.interactionPanel.setVoteState(null);
    }

    // 檢查是否有永久同步失敗需要還原
    this.checkAndRevertPermanentFailures();
  }

  revertOptimisticVote(previousVoteState, previousCounts) {
    if (!this.currentSubtitle) return;

    this.currentSubtitle.myVote = previousVoteState;
    this.currentSubtitle.upvotes = previousCounts.like;
    this.currentSubtitle.downvotes = previousCounts.dislike;

    this.interactionPanel.setVoteCounts({
      like: previousCounts.like ?? 0,
      dislike: previousCounts.dislike ?? 0
    });
    this.interactionPanel.setVoteState(previousVoteState);
    this.interactionPanel.setVoteError('投票失敗，已還原');
  }

  async checkAndRevertPermanentFailures() {
    if (!this.currentSubtitle || !this.currentSubtitle.translationID) return;

    try {
      const { voteQueue } = await chrome.storage.local.get('voteQueue');
      if (!voteQueue || !Array.isArray(voteQueue)) return;

      const failedItem = voteQueue.find(item =>
        item.translationID === this.currentSubtitle.translationID &&
        item.status === 'failed' &&
        item.errorMetadata?.isPermanent &&
        item.previousVoteState !== undefined &&
        item.previousCounts !== undefined
      );

      if (failedItem) {
        this.log('檢測到永久同步失敗，還原樂觀 UI:', failedItem);
        this.revertOptimisticVote(failedItem.previousVoteState, failedItem.previousCounts);
        // 標記為已還原，避免重複觸發
        failedItem.status = 'failed-reverted';
        await chrome.storage.local.set({ voteQueue });
        this.showToast('投票同步永久失敗，已還原狀態', 'error');
      }
    } catch (error) {
      console.error('檢查永久同步失敗時出錯:', error);
    }
  }

  // 處理提交完成
  async handleSubmissionComplete(submissionData) {
    this.log('處理提交完成', submissionData);

    try {
      // 使用翻譯橋接器
      const result = await this.translationBridge.enqueue(submissionData);

      if (result && result.itemId) {
        this.showToast('翻譯已加入隊列', 'success');
        this.log('翻譯已加入隊列:', result);
        return { ...result, status: 'success' };
      } else {
        this.showToast('翻譯提交失敗', 'error');
        return { status: 'error', error: '翻譯提交失敗，請再試一次。' };
      }
    } catch (error) {
      console.error('提交翻譯時出錯:', error);
      this.showToast(`翻譯提交失敗：${error.message}`, 'error');
      return { status: 'error', error: error.message };
    }
  }

  // 顯示 Toast 消息（使用新的 Toast 管理器）
  showToast(message, type = 'info', options = {}) {
    this.log(`Toast: [${type}] ${message}`);
    
    if (!this.toastManager || !this.toastManager.isInitialized) {
      // 降級到控制台輸出
      console.log(`[${type.toUpperCase()}] ${message}`);
      console.warn('Toast 管理器未初始化');
      return null;
    }
    
    try {
      // 使用新的 Toast 管理器
      return this.toastManager.show(message, type, options);
    } catch (error) {
      console.log(`[${type.toUpperCase()}] ${message}`);
      console.error('Toast 顯示失敗:', error);
      return null;
    }
  }
  
  // Toast 快捷方法
  showSuccessToast(message, options = {}) {
    return this.showToast(message, 'success', options);
  }
  
  showErrorToast(message, options = {}) {
    return this.showToast(message, 'error', options);
  }
  
  showWarningToast(message, options = {}) {
    return this.showToast(message, 'warning', options);
  }
  
  showInfoToast(message, options = {}) {
    return this.showToast(message, 'info', options);
  }

  // 模式選擇處理（由字幕協調器調用）
  handleModeSelected(mode) {
    this.log(`字幕模式已選定: ${mode}`);
    this.currentMode = mode;
    
    // 根據模式調整 UI 配置
    this.configureForMode(mode);
    
    // 觸發模式選擇回調
    this.triggerCallback('onModeSelected', mode);
  }

  // 根據模式配置 UI
  configureForMode(mode) {
    this.log(`為模式 ${mode} 配置 UI`);
    
    if (mode === 'intercept') {
      // 攔截模式：支持雙語字幕，顯示更多功能
      this.interactionPanel.configure({
        showVoteButtons: true,
        showSubmitButton: true,
        position: 'bottom'
      });
      this.showNativeSubtitles('intercept-mode-primary-not-ready');
    } else if (mode === 'dom') {
      // DOM 監聽模式：基本功能
      this.interactionPanel.configure({
        showVoteButtons: true,
        showSubmitButton: true,
        position: 'bottom'
      });
      this.hideNativeSubtitles('dom-mode-active');
    }
  }

  // 設置字幕樣式
  setSubtitleStyle(styleOptions) {
    if (this.subtitleDisplay) {
      this.subtitleDisplay.setStyle(styleOptions);
      this.log('字幕樣式已更新');
    }
  }

  syncNativeSubtitleVisibilityForSubtitle(subtitleData, reason = 'subtitle-data-update') {
    if (!subtitleData) {
      this.showNativeSubtitles(`${reason}-no-subtitle-data`);
      return;
    }

    if (subtitleData.mode === 'dom') {
      this.hideNativeSubtitles(`${reason}-dom-mode`);
      return;
    }

    if (subtitleData.mode !== 'intercept') {
      return;
    }

    const renderReadiness = subtitleData.renderReadiness ||
      subtitleData.dualSubtitleData?.renderReadiness ||
      null;

    if (renderReadiness) {
      this.syncNativeSubtitleVisibility(renderReadiness, reason);
      return;
    }

    this.showNativeSubtitles(`${reason}-intercept-missing-render-readiness`);
  }

  syncNativeSubtitleVisibility(renderReadiness, reason = 'render-readiness-update') {
    if (!renderReadiness) {
      this.showNativeSubtitles(`${reason}-missing-readiness`);
      return;
    }

    if (renderReadiness.canHideNativeSubtitles) {
      this.hideNativeSubtitles(renderReadiness.nativeHideReason || reason);
      return;
    }

    this.showNativeSubtitles(renderReadiness.nativeHideReason || renderReadiness.primaryMissingReason || reason);
  }

  handleAcquisitionFailureNotification(event) {
    if (event?.reason !== 'language-acquisition-failed' || event.slot !== 'primary') {
      return;
    }

    const failureReason = event.failureReason ||
      event.readiness?.primary?.missingReason ||
      'unknown';

    // transitioning 期間仍會安排 context ready 後重試，不過早宣告最終失敗。
    if (failureReason === 'playback-context-transitioning') {
      return;
    }

    const context = event.readiness?.context || {};
    const contextKey = [
      context.videoId || 'unknown-video',
      context.epoch ?? 'unknown-epoch',
      event.languageCode || 'unknown-language',
      failureReason
    ].join('|');

    if (this.acquisitionToastKeys.has(contextKey)) {
      return;
    }

    this.acquisitionToastKeys.add(contextKey);
    if (this.acquisitionToastKeys.size > 50) {
      const oldestKey = this.acquisitionToastKeys.values().next().value;
      this.acquisitionToastKeys.delete(oldestKey);
    }

    this.showWarningToast(this.createAcquisitionFailureMessage(failureReason), {
      duration: 8000,
      showIcon: true
    });
  }

  createAcquisitionFailureMessage(reason) {
    const reasonText = {
      'only-billboard-ttml': '目前只找到預覽或非播放頁字幕資料',
      'switch-track-timeout': '切換字幕軌後仍未收到可用字幕資料',
      'parse-error': '字幕資料解析失敗',
      'parse-empty': '字幕資料沒有可用時間軸內容',
      'response-not-ttml': 'Netflix 回應不是可用字幕格式',
      'no-watch-session-ttml': '尚未找到目前播放影片的字幕資料',
      'missing-current-video-id': '暫時無法確認目前播放影片',
      'playback-context-transitioning': '播放內容正在切換'
    }[reason] || '尚未找到可用字幕資料';

    return `SubPal 未能建立自訂主字幕：${reasonText}。目前會保留 Netflix 原生字幕。`;
  }

  // ==================== 備援通知控制器 ====================

  /**
   * 判斷目前 renderReadiness 是否處於備援狀態
   * 備援狀態定義：context ready + interceptor active + primary 未就緒 + 無法隱藏原生字幕
   */
  isFallbackActive(renderReadiness) {
    if (!renderReadiness) return false;
    return renderReadiness.interceptModeActive === true &&
           renderReadiness.playbackContextReady === true &&
           renderReadiness.primarySubtitleSlotReady === false &&
           renderReadiness.canHideNativeSubtitles === false;
  }

  /**
   * 判斷主要字幕是否已就緒（可直接使用或已可隱藏原生字幕）
   */
  isPrimaryReady(renderReadiness) {
    if (!renderReadiness) return false;
    return renderReadiness.primarySubtitleSlotReady === true ||
           renderReadiness.canHideNativeSubtitles === true;
  }

  /**
   * 確保 recoveryNotificationState 存在且符合目前的 context。
   * 若 context 已變化，清除舊 timer 並建立新狀態。
   */
  ensureRecoveryNotificationState(contextId, videoId, epoch) {
    if (this.recoveryNotificationState &&
        this.recoveryNotificationState.contextId === contextId) {
      return; // 同 context，沿用現有狀態
    }

    this.clearRecoveryNotificationTimers();
    this.recoveryNotificationState = {
      contextId,
      videoId,
      epoch,
      isTransition: this._pendingRecoveryIsTransition || false,
      lastReadiness: null,
      initialFallbackTimer: null,
      transitionFallbackTimer: null,
      longRecoveryTimer: null,
      initialFallbackShown: false,
      transitionFallbackShown: false,
      longRecoveryFailureShown: false,
      domSampleDetected: false
    };
    this._pendingRecoveryIsTransition = false; // 消費轉場標記
  }

  /** 排程初始載入備援通知（8 秒後顯示） */
  scheduleInitialFallbackNotice() {
    const state = this.recoveryNotificationState;
    if (!state) return;
    if (state.initialFallbackTimer) return; // 已排程
    if (state.initialFallbackShown) return; // 已顯示

    state.initialFallbackTimer = setTimeout(() => {
      // 重新檢查最新狀態
      if (!this.isRecoveryStateStillValid(state)) return;
      if (this.isPrimaryReady(state.lastReadiness?.renderReadiness)) return;
      if (!this.isFallbackActive(state.lastReadiness?.renderReadiness)) return;

      state.initialFallbackShown = true;
      state.initialFallbackTimer = null;
      this.showInfoToast('SubPal 正在嘗試取得字幕，目前暫時顯示 Netflix 原生字幕。', {
        duration: 4000
      });
    }, 8000);
  }

  /** 排程轉場備援通知（3 秒後顯示） */
  scheduleTransitionFallbackNotice() {
    const state = this.recoveryNotificationState;
    if (!state) return;
    if (state.transitionFallbackTimer) return;
    if (state.transitionFallbackShown) return;

    state.transitionFallbackTimer = setTimeout(() => {
      if (!this.isRecoveryStateStillValid(state)) return;
      if (this.isPrimaryReady(state.lastReadiness?.renderReadiness)) return;
      if (!this.isFallbackActive(state.lastReadiness?.renderReadiness)) return;

      state.transitionFallbackShown = true;
      state.transitionFallbackTimer = null;
      this.showInfoToast('SubPal 正在重新同步本集字幕，目前暫時顯示 Netflix 原生字幕。', {
        duration: 4000
      });
    }, 3000);
  }

  /** 排程長時間復原逾時通知（DOM sample 後 15 秒） */
  scheduleLongRecoveryTimeout() {
    const state = this.recoveryNotificationState;
    if (!state) return;
    if (state.longRecoveryTimer) return;
    if (state.longRecoveryFailureShown) return;
    if (!state.domSampleDetected) return; // 無 DOM sample 不啟動逾時

    state.longRecoveryTimer = setTimeout(() => {
      if (!this.isRecoveryStateStillValid(state)) return;
      if (this.isPrimaryReady(state.lastReadiness?.renderReadiness)) return;
      if (!this.isFallbackActive(state.lastReadiness?.renderReadiness)) return;

      state.longRecoveryFailureShown = true;
      state.longRecoveryTimer = null;
      this.showInfoToast('SubPal 暫時無法同步本集字幕。你可以繼續使用 Netflix 原生字幕，或重新整理頁面讓 SubPal 重新攔截。', {
        duration: 8000
      });
    }, 15000);
  }

  /**
   * 確認 recovery state 的 context 仍與最新 context 一致，
   * 且仍有 lastReadiness 供判斷（避免 timer callback 時 state 已 stale）
   */
  isRecoveryStateStillValid(state) {
    if (!this.recoveryNotificationState) return false;
    if (this.recoveryNotificationState !== state) return false;
    if (!state.lastReadiness) return false;
    return true;
  }

  /** 清除所有備援通知計時器 */
  clearRecoveryNotificationTimers() {
    const state = this.recoveryNotificationState;
    if (!state) return;

    if (state.initialFallbackTimer) {
      clearTimeout(state.initialFallbackTimer);
      state.initialFallbackTimer = null;
    }
    if (state.transitionFallbackTimer) {
      clearTimeout(state.transitionFallbackTimer);
      state.transitionFallbackTimer = null;
    }
    if (state.longRecoveryTimer) {
      clearTimeout(state.longRecoveryTimer);
      state.longRecoveryTimer = null;
    }
  }

  /** 重置備援通知狀態 */
  resetRecoveryNotificationState() {
    this.clearRecoveryNotificationTimers();
    this.recoveryNotificationState = null;
    this._pendingRecoveryIsTransition = false;
  }

  /**
   * 處理 SUBTITLE_READINESS_CHANGED 事件，驅動備援通知狀態機
   */
  handleFallbackNotification(event) {
    const readiness = event.readiness;
    if (!readiness) return;

    const context = readiness.context;
    const renderReadiness = readiness.renderReadiness;
    if (!context || !renderReadiness) return;

    const videoId = context.videoId;
    const epoch = context.epoch;
    if (!videoId || videoId === 'unknown' || context.state !== 'ready') {
      // context 無效或尚未 ready：清除計時器但保留 state 供後續恢復
      this.clearRecoveryNotificationTimers();
      return;
    }

    const contextId = `${videoId}|${epoch}`;

    // 確保狀態存在於正確的 context
    this.ensureRecoveryNotificationState(contextId, videoId, epoch);

    // 更新最新 readiness
    const state = this.recoveryNotificationState;
    state.lastReadiness = readiness;

    // 復原成功檢查：primary ready 或 native 已可隱藏
    if (this.isPrimaryReady(renderReadiness)) {
      this.clearRecoveryNotificationTimers();
      return;
    }

    // 非備援狀態：清除計時器
    if (!this.isFallbackActive(renderReadiness)) {
      this.clearRecoveryNotificationTimers();
      return;
    }

    // 備援中：依據是否為轉場 context 排程對應 toast
    if (state.isTransition) {
      this.scheduleTransitionFallbackNotice();
    } else {
      this.scheduleInitialFallbackNotice();
    }
  }

  /**
   * 處理 PRIMARY_DISCOVERY_DOM_SAMPLE_DETECTED 事件
   * 當第一個 DOM sample 被檢測到且備援仍活躍時，啟動 long recovery 逾時（15 秒）
   */
  handleDomSampleDetected(event) {
    if (!this.recoveryNotificationState) return;

    // 確認 event 的 context 與目前 notification state 一致
    const videoId = event.videoId;
    const epoch = event.epoch;
    if (this.recoveryNotificationState.videoId !== videoId ||
        this.recoveryNotificationState.epoch !== epoch) return;

    // 確認備援仍活躍
    const renderReadiness = this.recoveryNotificationState.lastReadiness?.renderReadiness;
    if (!renderReadiness) return;
    if (!this.isFallbackActive(renderReadiness)) return;
    if (this.isPrimaryReady(renderReadiness)) return;

    // 標記 DOM sample 已檢測並啟動 15 秒逾時
    this.recoveryNotificationState.domSampleDetected = true;
    this.scheduleLongRecoveryTimeout();
  }

  // 獲取當前狀態
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      currentMode: this.currentMode,
      hasCurrentSubtitle: !!this.currentSubtitle,
      nativeSubtitle: {
        hidden: !!document.getElementById('subpal-hide-native-subtitles'),
        nativeSubtitleHidden: !!document.getElementById('subpal-hide-native-subtitles'),
        nativeHideReason: this.nativeHideReason,
        lastRecordedHiddenState: this.nativeSubtitleHidden,
        updatedAt: this.nativeSubtitleVisibilityUpdatedAt
      },
      acquisitionNotifications: {
        shownKeys: this.acquisitionToastKeys.size
      },
      components: {
        subtitleDisplay: this.subtitleDisplay?.getStatus(),
        interactionPanel: this.interactionPanel?.getStatus(),
        submissionDialog: this.submissionDialog?.getStatus(),
        fullscreenHandler: this.fullscreenHandler?.getStatus(),
        uiAvoidanceHandler: this.uiAvoidanceHandler?.getStatus(),
        toastManager: this.toastManager?.getStatus()
      }
    };
  }

  // 註冊事件回調
  onModeSelected(value) {
    if (typeof value === 'function') {
      this.eventCallbacks.onModeSelected = value;
      return;
    }

    this.handleModeSelected(value);
  }

  onUIReady(callback) {
    this.eventCallbacks.onUIReady = callback;
  }

  onError(callback) {
    this.eventCallbacks.onError = callback;
  }

  // 觸發回調
  triggerCallback(callbackName, data = null) {
    const callback = this.eventCallbacks[callbackName];
    if (callback && typeof callback === 'function') {
      this.log(`觸發回調: ${callbackName}`);
      callback(data);
    }
  }

  // 清理資源
  cleanup() {
    this.log('清理 UI 管理器資源...');
    
    // 清理備援通知計時器與轉場標記
    this.resetRecoveryNotificationState();

    this.disposeInternalEventHandlers();
    
    // 清理播放器監聽器
    if (this.playerObserver) {
      this.playerObserver.disconnect();
      this.playerObserver = null;
      this.log('播放器監聽器已清理');
    }
    
    this.cleanupVideoComponents();

    if (this.subtitleReplacer) {
      this.subtitleReplacer.cleanup();
      this.subtitleReplacer = null;
    }

    // 清除永久失敗檢查計時器，避免 interval leak
    if (this._permanentFailureCheckInterval) {
      clearInterval(this._permanentFailureCheckInterval);
      this._permanentFailureCheckInterval = null;
      this.log('永久失敗檢查計時器已清除');
    }

    this._componentGeneration += 1;
    this._pendingVideoChangeEvent = null;
    this.isInitialized = false;
    this.currentSubtitle = null;
    this.currentMode = null;
    this.acquisitionToastKeys.clear();
    this.eventCallbacks = {};

    this.log('UI 管理器資源清理完成');
  }

  cleanupVideoComponents() {
    this.clearSubtitleHoverEvents();

    if (this.subtitleDisplay) {
      this.subtitleDisplay.cleanup();
      this.subtitleDisplay = null;
    }
    
    if (this.interactionPanel) {
      this.interactionPanel.cleanup();
      this.interactionPanel = null;
    }
    
    if (this.submissionDialog) {
      this.submissionDialog.cleanup();
      this.submissionDialog = null;
    }
    
    if (this.fullscreenHandler) {
      this.fullscreenHandler.cleanup();
      this.fullscreenHandler = null;
    }
    
    if (this.uiAvoidanceHandler) {
      this.uiAvoidanceHandler.cleanup();
      this.uiAvoidanceHandler = null;
    }
    
    if (this.toastManager) {
      this.toastManager.cleanup();
      this.toastManager = null;
    }
    this.currentSubtitle = null;
    this.currentMode = null;
  }

  // 恢復原生字幕（移除隱藏CSS）
  showNativeSubtitles(reason = 'showNativeSubtitles-called') {
    const styleElement = document.getElementById('subpal-hide-native-subtitles');
    if (styleElement) {
      styleElement.remove();
      this.log('✅ 已移除CSS規則，恢復Netflix原生字幕');
    }
    this.nativeSubtitleHidden = false;
    this.nativeHideReason = reason;
    this.nativeSubtitleVisibilityUpdatedAt = Date.now();
  }

  // 隱藏原生字幕
  hideNativeSubtitles(reason = 'hideNativeSubtitles-called') {
    this.log('隱藏Netflix原生字幕...');
    
    // 檢查是否已經注入過樣式，避免重複注入
    if (document.getElementById('subpal-hide-native-subtitles')) {
      this.log('原生字幕隱藏樣式已存在，無需重複注入');
      this.nativeSubtitleHidden = true;
      this.nativeHideReason = `${reason}-style-already-present`;
      this.nativeSubtitleVisibilityUpdatedAt = Date.now();
      return;
    }
    
    // 創建 style 元素
    const styleElement = document.createElement('style');
    styleElement.id = 'subpal-hide-native-subtitles';
    
    // 設置高優先級 CSS 規則來隱藏原生字幕
    styleElement.textContent = `
      .player-timedtext, .player-timedtext-text-container {
        clip-path: polygon(0 0, 0 0, 0 0, 0 0) !important;
        pointer-events: none !important;
      }
    `;
    
    // 將 style 元素添加到 head 中
    document.head.appendChild(styleElement);
    this.nativeSubtitleHidden = true;
    this.nativeHideReason = reason;
    this.nativeSubtitleVisibilityUpdatedAt = Date.now();
    this.log('✅ 已注入CSS規則隱藏Netflix原生字幕');
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[UIManager] ${message}`, ...args);
    }
  }
}

export { UIManager };

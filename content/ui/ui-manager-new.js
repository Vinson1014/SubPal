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
import { sendMessage, registerInternalEventHandler } from '../system/messaging.js';
import { SubtitleReplacer } from '../core/subtitle-replacer.js';

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
    
    // 調試模式
    this.debug = true;
    
    // 核心模組
    this.subtitleReplacer = null;
    this.translationManager = null;
    this.voteManager = null;
  }

  async initialize() {
    this.log('UI 管理器初始化中...');
    
    try {
      // 載入調試模式設置
      await this.loadDebugMode();
      
      // 設置事件處理器
      this.setupEventHandlers();
      
      // 初始化所有UI組件
      await this.initializeComponents();
      
      // 初始化核心模組
      this.subtitleReplacer = new SubtitleReplacer();
      await this.subtitleReplacer.initialize();
      
      // 動態導入並初始化翻譯管理器
      const { translationManager } = await import('../core/translation-manager.js');
      this.translationManager = translationManager;
      if (!this.translationManager.isInitialized) {
        await this.translationManager.initialize();
      }
      
      // 動態導入並初始化投票管理器  
      const { voteManager } = await import('../core/vote-manager.js');
      this.voteManager = voteManager;
      if (!this.voteManager.isInitialized) {
        await this.voteManager.initialize();
      }
      
      // 設置組件間的事件關聯
      this.setupComponentInteractions();
      
      // 設置播放器監聽
      this.setupPlayerObserver();
      
      this.isInitialized = true;
      this.log('UI 管理器初始化完成');
      
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
    if (!this.isInitialized) {
      console.error('UI 管理器未初始化');
      return;
    }
    
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
            subtitleData.timestamp || Date.now() / 1000
          );
          
          if (replacedSubtitle) {
            processedSubtitle = replacedSubtitle;
            this.log('字幕已替換:', {
              original: subtitleData.text,
              replaced: replacedSubtitle.text
            });
          }
        } catch (error) {
          console.error('字幕替換處理失敗:', error);
        }
      }
      
      // 根據模式處理位置計算
      if (processedSubtitle.mode === 'intercept') {
        // 攔截模式：位置已在 subtitle-interceptor.js 中計算完成
        this.log('攔截模式：使用預計算位置', {
          position: processedSubtitle.position,
          region: processedSubtitle.originalData.region
        });
      } else if (processedSubtitle.mode === 'dom') {
        // DOM監聽模式：直接使用原生字幕位置
        this.log('DOM監聽模式：使用原生字幕位置:', processedSubtitle.position);
      }
      
      this.currentSubtitle = processedSubtitle;
      
      // 顯示字幕
      this.subtitleDisplay.show(processedSubtitle);
      
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
      
      // 延遲一點時間，確保字幕容器的 transform 動畫開始
      setTimeout(() => {
        // 更新字幕位置資訊
        const newSubtitleData = {
          ...this.currentSubtitle,
          position: {
            ...this.currentSubtitle.position,
            top: this.currentSubtitle.position.top + offset
          }
        };
        this.interactionPanel.updatePosition(newSubtitleData);
        this.log('延遲更新交互面板位置');
      }, 250); // 250ms 延遲，讓 CSS transition 開始
    }
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

  // 設置事件處理器
  setupEventHandlers() {
    // 監聽調試模式變更
    registerInternalEventHandler('TOGGLE_DEBUG_MODE', (message) => {
      this.debug = message.debugMode;
      this.log('調試模式設置已更新:', this.debug);
    });

    // 監聽影片切換事件 - 統一重新初始化所有UI組件
    registerInternalEventHandler('VIDEO_ID_CHANGED', async (event) => {
      this.log(`🎬 檢測到影片切換: ${event.oldVideoId} -> ${event.newVideoId}`);
      
      try {
        // 1. 清理所有UI組件
        this.cleanup();
        this.log('✅ UI組件清理完成');
        
        // 2. 檢查新的 videoID 是否有效
        if (event.newVideoId === 'unknown') {
          this.log('用戶離開播放頁面，UI已清理，等待重新進入播放頁面');
          this.isInitialized = false;
          return; // 不重新初始化，等待用戶重新進入播放頁面
        }
        
        // 3. 如果是有效videoID，直接重新初始化
        this.log('🔄 開始UI重新初始化...');
        await this.initializeComponents();
        this.log('✅ UI組件重新初始化完成');
        
        // 4. 重新設置組件間關聯
        this.setupComponentInteractions();
        this.log('✅ 組件關聯重新設置完成');
        
        // 5. 重新隱藏原生字幕（確保新影片的原生字幕被隱藏）
        this.hideNativeSubtitles();
        
        this.isInitialized = true;
        this.log('🎉 影片切換UI重新初始化完成！');
        
      } catch (error) {
        console.error('❌ 影片切換UI重新初始化失敗:', error);
        // 如果重新初始化失敗，嘗試恢復基本狀態
        this.handleReinitializationError(error);
      }
    });
  }

  // 初始化所有UI組件
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
    
    // 初始化完成後隱藏原生字幕
    this.hideNativeSubtitles();
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
      this.handleSubmissionComplete(submissionData);
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
  async handleLikeClick() {
    this.log('處理讚點擊');
    
    if (!this.currentSubtitle) {
      console.error('沒有當前字幕數據');
      return;
    }
    
    try {
      const voteParams = {
        videoID: this.currentSubtitle.videoId || 'unknown',
        timestamp: this.currentSubtitle.timestamp || Date.now() / 1000,
        originalSubtitle: this.currentSubtitle.original || this.currentSubtitle.text,
        voteType: 'upvote',
        translationID: this.currentSubtitle.translationID || null
      };
      
      const result = await this.voteManager.vote(voteParams, this.currentSubtitle);
      
      if (result.success) {
        this.showToast('點讚成功！', 'success');
        this.log('投票成功:', result);
      } else {
        this.showToast(result.message || '點讚失敗', result.queued ? 'warning' : 'error');
      }
    } catch (error) {
      console.error('處理點讚時出錯:', error);
      this.showToast(`點讚失敗：${error.message}`, 'error');
    }
  }

  // 處理倒讚點擊
  async handleDislikeClick() {
    this.log('處理倒讚點擊');
    
    if (!this.currentSubtitle) {
      console.error('沒有當前字幕數據');
      return;
    }
    
    try {
      const voteParams = {
        videoID: this.currentSubtitle.videoId || 'unknown',
        timestamp: this.currentSubtitle.timestamp || Date.now() / 1000,
        originalSubtitle: this.currentSubtitle.original || this.currentSubtitle.text,
        voteType: 'downvote',
        translationID: this.currentSubtitle.translationID || null
      };
      
      const result = await this.voteManager.vote(voteParams, this.currentSubtitle);
      
      if (result.success) {
        this.showToast('點倒讚成功！', 'success');
        this.log('投票成功:', result);
      } else {
        this.showToast(result.message || '點倒讚失敗', result.queued ? 'warning' : 'error');
      }
    } catch (error) {
      console.error('處理點倒讚時出錯:', error);
      this.showToast(`點倒讚失敗：${error.message}`, 'error');
    }
  }

  // 處理提交完成
  async handleSubmissionComplete(submissionData) {
    this.log('處理提交完成', submissionData);
    
    try {
      // 使用新的翻譯管理器
      const result = await this.translationManager.submitTranslation(submissionData);
      
      if (result.success) {
        if (result.queued) {
          this.showToast(`翻譯已加入隊列，排隊位置：${result.queuePosition}`, 'info');
        } else {
          this.showToast('翻譯提交成功！', 'success');
        }
        this.log('翻譯提交成功:', result);
      } else {
        this.showToast(result.message || '翻譯提交失敗', 'error');
      }
    } catch (error) {
      console.error('提交翻譯時出錯:', error);
      this.showToast(`翻譯提交失敗：${error.message}`, 'error');
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

  // 模式選擇回調（由字幕協調器調用）
  onModeSelected(mode) {
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
    } else if (mode === 'dom') {
      // DOM 監聽模式：基本功能
      this.interactionPanel.configure({
        showVoteButtons: true,
        showSubmitButton: true,
        position: 'bottom'
      });
    }
  }

  // 設置字幕樣式
  setSubtitleStyle(styleOptions) {
    if (this.subtitleDisplay) {
      this.subtitleDisplay.setStyle(styleOptions);
      this.log('字幕樣式已更新');
    }
  }

  // 獲取當前狀態
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      currentMode: this.currentMode,
      hasCurrentSubtitle: !!this.currentSubtitle,
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
  onModeSelected(callback) {
    this.eventCallbacks.onModeSelected = callback;
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
    
    // 清理懸停事件
    this.clearSubtitleHoverEvents();
    
    // 清理播放器監聽器
    if (this.playerObserver) {
      this.playerObserver.disconnect();
      this.playerObserver = null;
      this.log('播放器監聽器已清理');
    }
    
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
    
    if (this.subtitleReplacer) {
      this.subtitleReplacer.cleanup();
      this.subtitleReplacer = null;
    }
    
    this.isInitialized = false;
    this.currentSubtitle = null;
    this.currentMode = null;
    this.eventCallbacks = {};
    
    this.log('UI 管理器資源清理完成');
  }

  // 隱藏原生字幕
  hideNativeSubtitles() {
    this.log('隱藏Netflix原生字幕...');
    
    // 檢查是否已經注入過樣式，避免重複注入
    if (document.getElementById('subpal-hide-native-subtitles')) {
      this.log('原生字幕隱藏樣式已存在，無需重複注入');
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
    this.log('✅ 已注入CSS規則隱藏Netflix原生字幕');
  }

  log(message, ...args) {
    if (this.debug) {
      console.log(`[UIManager] ${message}`, ...args);
    }
  }
}

export { UIManager };
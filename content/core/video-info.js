/**
 * SubPal - 視頻信息模塊（重構版）
 * 
 * 專責於獲取當前播放視頻的 ID、時間戳和相關信息
 * 利用 Netflix Player API 提供更準確的數據
 */

import { sendMessage, onMessage, dispatchInternalEvent } from '../system/messaging.js';

class VideoInfoManager {
    constructor() {
        this.currentVideoId = null;
        this.currentVideoTitle = null;
        this.debug = false; // 將由 ConfigBridge 設置
        
        // Netflix Player API 相關
        this.playerHelper = null;
        this.videoPlayer = null;
        this.sessionId = null;
        this.playerAPI = null;
        
        // 後備視頻元素
        this.videoElement = null;
        this.checkInterval = null;
        
        // 綁定事件處理函數以保持 this 上下文
        this.boundHandleVideoPlay = this.handleVideoPlay.bind(this);
        this.boundHandleVideoPause = this.handleVideoPause.bind(this);
        this.boundHandleVideoSeeked = this.handleVideoSeeked.bind(this);
        
        this.isInitialized = false;
    }

    /**
     * 初始化視頻信息模塊
     */
    async initialize() {
        if (this.isInitialized) return;

        try {
            console.log('初始化視頻信息模塊...');

            // 初始化 ConfigBridge 並讀取配置
            const { configBridge } = await import('../system/config/config-bridge.js');

            // 讀取 debugMode
            this.debug = configBridge.get('debugMode');
            this.log(`調試模式設置為: ${this.debug}`);

            // 訂閱 debugMode 變更
            configBridge.subscribe('debugMode', (newValue) => {
                this.debug = newValue;
                this.log(`調試模式已更新: ${newValue}`);
            });

            this.configBridge = configBridge;

            // 嘗試初始化 Netflix Player API
            await this.initializeNetflixAPI();

            // 設置後備視頻元素檢測
            this.setupVideoElementFallback();

            // 提取初始視頻信息
            await this.extractVideoInfo();

            // 設置定期檢查
            this.startPeriodicCheck();

            // 監聽頁面變化
            this.setupPageChangeListeners();

            this.isInitialized = true;
            this.log('視頻信息模塊初始化完成');
        } catch (error) {
            console.error('VideoInfoManager 初始化失敗:', error);
            throw error;
        }
    }

    /**
     * 初始化 Netflix Player API
     */
    async initializeNetflixAPI() {
        try {
            // 檢查 Netflix API 是否可用
            if (!window.netflix?.appContext?.state?.playerApp) {
                this.log('Netflix Player API 不可用，使用後備方案');
                return false;
            }
            
            const playerApp = window.netflix.appContext.state.playerApp;
            this.playerAPI = playerApp.getAPI();
            
            // 獲取播放會話
            const sessions = this.playerAPI.getOpenPlaybackSessions();
            if (!sessions || sessions.length === 0) {
                this.log('沒有找到活躍的播放會話');
                return false;
            }
            
            this.sessionId = sessions[0].sessionId;
            this.videoPlayer = this.playerAPI.videoPlayer.getVideoPlayerBySessionId(this.sessionId);
            
            this.log('Netflix Player API 初始化成功');
            return true;
            
        } catch (error) {
            this.log('初始化 Netflix Player API 失敗:', error);
            return false;
        }
    }

    /**
     * 設置後備視頻元素檢測
     */
    setupVideoElementFallback() {
        // 尋找視頻元素作為後備方案
        this.findVideoElement();
        
        // 監聽 DOM 變化以檢測新的視頻元素
        const observer = new MutationObserver(() => {
            if (!this.videoElement) {
                this.findVideoElement();
            }
        });
        
        observer.observe(document, { 
            subtree: true, 
            childList: true 
        });
    }

    /**
     * 尋找視頻元素（後備方案）
     */
    findVideoElement() {
        const videos = document.querySelectorAll('video');
        if (videos.length === 0) return;
        
        // 優先選擇正在播放的視頻
        for (const video of videos) {
            if (!video.paused) {
                this.videoElement = video;
                this.setupVideoEventListeners(video);
                this.log('找到播放中的視頻元素作為後備方案');
                return;
            }
        }
        
        // 如果沒有播放中的，選擇最後一個
        this.videoElement = videos[videos.length - 1];
        this.setupVideoEventListeners(this.videoElement);
        this.log('使用最後一個視頻元素作為後備方案');
    }

    /**
     * 為視頻元素設置事件監聽器
     */
    setupVideoEventListeners(videoElement) {
        if (!videoElement) return;
        
        // 移除舊的監聽器
        videoElement.removeEventListener('play', this.boundHandleVideoPlay);
        videoElement.removeEventListener('pause', this.boundHandleVideoPause);
        videoElement.removeEventListener('seeked', this.boundHandleVideoSeeked);
        
        // 添加新的監聽器
        videoElement.addEventListener('play', this.boundHandleVideoPlay);
        videoElement.addEventListener('pause', this.boundHandleVideoPause);
        videoElement.addEventListener('seeked', this.boundHandleVideoSeeked);
    }

    /**
     * 處理視頻播放事件
     */
    handleVideoPlay(event) {
        this.log('視頻播放事件觸發');
        
        // 更新當前有效的視頻元素
        if (event && event.target) {
            this.videoElement = event.target;
        }
        
        try {
            dispatchInternalEvent({
                type: 'PLAYER_STATE_CHANGED',
                state: 'play',
                timestamp: this.getCurrentTimestamp(),
                videoId: this.getVideoId()
            });
        } catch (error) {
            console.error('發送播放狀態內部事件失敗:', error);
        }
    }

    /**
     * 處理視頻暫停事件
     */
    handleVideoPause(event) {
        this.log('視頻暫停事件觸發');
        
        // 更新當前有效的視頻元素
        if (event && event.target) {
            this.videoElement = event.target;
        }
        
        try {
            dispatchInternalEvent({
                type: 'PLAYER_STATE_CHANGED',
                state: 'pause',
                timestamp: this.getCurrentTimestamp(),
                videoId: this.getVideoId()
            });
        } catch (error) {
            console.error('發送暫停狀態內部事件失敗:', error);
        }
    }

    /**
     * 處理視頻跳轉事件
     */
    handleVideoSeeked(event) {
        this.log('視頻跳轉事件觸發');
        
        // 更新當前有效的視頻元素
        if (event && event.target) {
            this.videoElement = event.target;
        }
        
        try {
            dispatchInternalEvent({
                type: 'PLAYER_STATE_CHANGED',
                state: 'seeked',
                timestamp: this.getCurrentTimestamp(),
                videoId: this.getVideoId()
            });
        } catch (error) {
            console.error('發送跳轉狀態內部事件失敗:', error);
        }
    }

    /**
     * 提取視頻信息
     */
    async extractVideoInfo() {
        const videoId = this.extractVideoId();
        const videoTitle = await this.extractVideoTitle();
        
        // 檢查是否有變化
        if (videoId !== this.currentVideoId) {
            const oldVideoId = this.currentVideoId;
            this.currentVideoId = videoId;
            this.currentVideoTitle = videoTitle;
            
            // 保存到存儲
            await this.saveVideoInfo();
            
            // 通知視頻變更
            if (oldVideoId !== null) {
                try {
                    // 發送內部事件（給 content script 組件）
                    dispatchInternalEvent({
                        type: 'VIDEO_ID_CHANGED',
                        oldVideoId: oldVideoId,
                        newVideoId: videoId
                    });
                    
                    // 同時發送到 page script（給 netflix-page-script.js）
                    window.dispatchEvent(new CustomEvent('messageToContentScript', {
                        detail: {
                            messageId: `video-info-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                            message: {
                                type: 'VIDEO_ID_CHANGED',
                                oldVideoId: oldVideoId,
                                newVideoId: videoId,
                                source: 'video-info-manager'
                            }
                        }
                    }));
                    
                    this.log(`視頻切換事件已發送: ${oldVideoId} -> ${videoId}`);
                } catch (error) {
                    console.error('發送視頻 ID 變動事件失敗:', error);
                }
            }
            
            this.log('視頻信息更新:', { videoId, videoTitle });
        }
    }

    /**
     * 提取視頻 ID
     */
    extractVideoId() {
        // 方法 1: 從 Netflix Player API 獲取
        // if (this.playerAPI && this.sessionId) {
        //     try {
        //         const metadata = this.playerAPI.getActiveVideoMetadata();
        //         if (metadata && metadata.videoId) {
        //             this.log('從 Netflix API 獲取視頻 ID:', metadata.videoId);
        //             return metadata.videoId.toString();
        //         }
        //     } catch (error) {
        //         this.log('從 Netflix API 獲取視頻 ID 失敗:', error);
        //     }
        // }
        
        // 方法 2: 從 URL 提取
        const urlMatch = location.href.match(/netflix\.com\/watch\/(\d+)/);
        if (urlMatch && urlMatch[1]) {
            this.log('從 URL 提取視頻 ID:', urlMatch[1]);
            return urlMatch[1];
        }
        
        // 方法 3: 從 DOM 元素提取（後備）
        // const videoIdFromDOM = this.extractVideoIdFromDOM();
        // if (videoIdFromDOM) {
        //     this.debugLog('從 DOM 提取視頻 ID:', videoIdFromDOM);
        //     return videoIdFromDOM;
        // }
        
        this.log('無法提取視頻 ID，使用 unknown');
        return 'unknown';
    }

    /**
     * 從 DOM 元素提取視頻 ID（後備方案）
     */
    extractVideoIdFromDOM() {
        // 檢查視頻元素的 data 屬性
        if (this.videoElement?.hasAttribute('data-videoid')) {
            return this.videoElement.getAttribute('data-videoid');
        }
        
        // 檢查所有視頻元素
        const videos = document.querySelectorAll('video[data-videoid]');
        if (videos.length > 0) {
            return videos[0].getAttribute('data-videoid');
        }
        
        // 檢查 Netflix banner 容器
        const bannerContainer = document.querySelector('.billboard .VideoContainer[data-videoid]');
        if (bannerContainer) {
            return bannerContainer.getAttribute('data-videoid');
        }
        
        return null;
    }

    /**
     * 提取視頻標題
     */
    async extractVideoTitle() {
        // 方法 1: 從 Netflix Player API 獲取
        if (this.playerAPI && this.sessionId) {
            try {
                const metadata = this.playerAPI.getActiveVideoMetadata();
                if (metadata && metadata.title) {
                    this.log('從 Netflix API 獲取視頻標題:', metadata.title);
                    return metadata.title;
                }
            } catch (error) {
                this.log('從 Netflix API 獲取視頻標題失敗:', error);
            }
        }
        
        // 方法 2: 從頁面 DOM 提取（後備）
        const titleSelectors = [
            '.video-title h4',
            '.title-title', 
            'h1[data-uia="video-title"]',
            '[data-uia="title-field"]'
        ];
        
        for (const selector of titleSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
                const title = element.textContent.trim();
                this.log('從 DOM 獲取視頻標題:', title);
                return title;
            }
        }
        
        return 'Unknown Title';
    }

    /**
     * 獲取當前播放時間戳
     */
    getCurrentTimestamp() {
        // 方法 1: 從 Netflix Player API 獲取（返回毫秒，需轉換為秒）
        if (this.videoPlayer) {
            try {
                const currentTimeMs = this.videoPlayer.getCurrentTime();
                if (typeof currentTimeMs === 'number' && currentTimeMs >= 0) {
                    // Netflix API 返回毫秒，轉換為秒（保持完整精度）
                    return currentTimeMs / 1000;
                }
            } catch (error) {
                this.log('從 Netflix API 獲取時間戳失敗:', error);
            }
        }
        
        // 方法 2: 從視頻元素獲取（後備）
        if (this.videoElement) {
            return this.videoElement.currentTime;
        }
        
        // 方法 3: 如果還沒初始化完成，嘗試立即查找視頻元素
        if (!this.isInitialized) {
            const videos = document.querySelectorAll('video');
            for (const video of videos) {
                if (!video.paused && video.currentTime > 0) {
                    this.log('緊急查找到播放中的視頻元素');
                    return video.currentTime;
                }
            }
            // 如果沒有播放中的，使用最後一個視頻元素
            if (videos.length > 0) {
                const lastVideo = videos[videos.length - 1];
                this.log('緊急使用最後一個視頻元素');
                return lastVideo.currentTime;
            }
        }
        
        return 0;
    }

    /**
     * 檢查播放狀態
     */
    isPlaying() {
        // 方法 1: 從 Netflix Player API 獲取
        if (this.videoPlayer) {
            try {
                return this.videoPlayer.isPlaying();
            } catch (error) {
                this.log('從 Netflix API 獲取播放狀態失敗:', error);
            }
        }
        
        // 方法 2: 從視頻元素獲取（後備）
        if (this.videoElement) {
            return !this.videoElement.paused;
        }
        
        return false;
    }

    /**
     * 設置頁面變化監聽器
     */
    setupPageChangeListeners() {
        // 監聽 URL 變化
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                this.log('URL 變化，重新檢查視頻信息');
                setTimeout(() => {
                    this.initializeNetflixAPI();
                    this.extractVideoInfo();
                }, 1000);
            }
        });
        
        urlObserver.observe(document, { 
            subtree: true, 
            childList: true 
        });
        
        // 監聽 popstate 事件
        window.addEventListener('popstate', () => {
            setTimeout(() => {
                this.initializeNetflixAPI();
                this.extractVideoInfo();
            }, 1000);
        });
    }

    /**
     * 開始定期檢查
     */
    startPeriodicCheck() {
        this.checkInterval = setInterval(() => {
            this.extractVideoInfo();
        }, 3000);
    }

    /**
     * 停止定期檢查
     */
    stopPeriodicCheck() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    /**
     * 保存視頻信息到存儲
     */
    async saveVideoInfo() {
        try {
            await sendMessage({
                type: 'SAVE_VIDEO_INFO',
                data: {
                    currentVideoId: this.currentVideoId,
                    currentVideoTitle: this.currentVideoTitle,
                    currentVideoLanguage: 'unknown'
                }
            });
            
            this.log('視頻信息已保存到存儲');
        } catch (error) {
            console.error('保存視頻信息時出錯:', error);
        }
    }

    /**
     * 調試日誌
     */
    log(message, ...args) {
        if (this.debug) {
            console.log(`[VideoInfo] ${message}`, ...args);
        }
    }

    /**
     * 獲取當前視頻 ID
     */
    getVideoId() {
        // 移除 unknown 判定
        // if (!this.currentVideoId || this.currentVideoId === 'unknown') {
        if (!this.currentVideoId) {
            this.currentVideoId = this.extractVideoId();
        }
        return this.currentVideoId;
    }

    /**
     * 獲取當前視頻標題
     */
    getVideoTitle() {
        return this.currentVideoTitle || 'Unknown Title';
    }

    /**
     * 獲取視頻語言（已廢棄）
     */
    getVideoLanguage() {
        return 'unknown';
    }

    /**
     * 銷毀模塊
     */
    destroy() {
        this.stopPeriodicCheck();
        this.isInitialized = false;
        this.log('視頻信息模塊已銷毀');
    }
}

// 創建模塊實例
const videoInfoManager = new VideoInfoManager();

// 導出函數（保持與舊版兼容的 API）
export function initVideoInfo() {
    return videoInfoManager.initialize();
}

export function getVideoId() {
    return videoInfoManager.getVideoId();
}

export function getVideoTitle() {
    return videoInfoManager.getVideoTitle();
}

export function getVideoLanguage() {
    return videoInfoManager.getVideoLanguage();
}

export function getCurrentTimestamp() {
    return videoInfoManager.getCurrentTimestamp();
}

// 導出管理器實例供高級用法
export { videoInfoManager };
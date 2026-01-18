// 教學頁面 JavaScript 邏輯
// 使用 config-schema.js 作為配置的單一真相來源

import {
    SUPPORTED_LANGUAGES,
    getDefaultValues
} from './content/system/config/config-schema.js';

// ==================== 配置管理（與 options.js 相同邏輯） ====================

const DEFAULT_CONFIG = getDefaultValues();

/**
 * 從嵌套對象中獲取值（支援點記法）
 */
function getNestedValue(obj, path) {
    const keys = path.split('.');
    let value = obj;
    for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
            value = value[key];
        } else {
            return undefined;
        }
    }
    return value;
}

/**
 * 載入所有配置
 */
async function loadConfig() {
    const flatKeys = Object.keys(DEFAULT_CONFIG);
    const rootKeys = [...new Set(flatKeys.map(k => k.split('.')[0]))];
    const result = await chrome.storage.local.get(rootKeys);
    const config = {};
    for (const flatKey of flatKeys) {
        const value = getNestedValue(result, flatKey);
        config[flatKey] = value !== undefined ? value : DEFAULT_CONFIG[flatKey];
    }
    return config;
}

/**
 * 將扁平化鍵轉換為嵌套對象結構
 */
function flatToNested(flatItems) {
    const nested = {};
    for (const [key, value] of Object.entries(flatItems)) {
        const keys = key.split('.');
        const lastKey = keys.pop();
        let current = nested;
        for (const k of keys) {
            if (!(k in current)) {
                current[k] = {};
            }
            current = current[k];
        }
        current[lastKey] = value;
    }
    return nested;
}

/**
 * 深度合併兩個對象
 */
function deepMerge(existing, updates) {
    const result = { ...existing };
    for (const [key, value] of Object.entries(updates)) {
        if (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            key in result &&
            result[key] !== null &&
            typeof result[key] === 'object' &&
            !Array.isArray(result[key])
        ) {
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * 保存單個配置項
 */
async function saveConfig(key, value) {
    const nested = flatToNested({ [key]: value });
    const rootKey = key.split('.')[0];
    const existing = await chrome.storage.local.get([rootKey]);
    const merged = deepMerge(existing, nested);
    await chrome.storage.local.set(merged);
    console.log(`[Tutorial] 配置已保存: ${key} =`, value);
}

/**
 * 批量保存配置
 */
async function saveConfigMultiple(items) {
    const nested = flatToNested(items);
    const rootKeys = [...new Set(Object.keys(items).map(k => k.split('.')[0]))];
    const existing = await chrome.storage.local.get(rootKeys);
    const merged = deepMerge(existing, nested);
    await chrome.storage.local.set(merged);
    console.log(`[Tutorial] 批量保存 ${Object.keys(items).length} 個配置`);
}

/**
 * RGBA 轉 Hex + Opacity
 */
function parseRgba(rgba) {
    const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!match) {
        return { hex: '#000000', opacity: 1 };
    }
    const r = parseInt(match[1]).toString(16).padStart(2, '0');
    const g = parseInt(match[2]).toString(16).padStart(2, '0');
    const b = parseInt(match[3]).toString(16).padStart(2, '0');
    const opacity = match[4] ? parseFloat(match[4]) : 1;
    return { hex: `#${r}${g}${b}`, opacity };
}

/**
 * Hex + Opacity 轉 RGBA
 */
function toRgba(hex, opacity) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// ==================== Tutorial Manager Class ====================

class TutorialManager {
    constructor() {
        this.currentStep = 1;
        this.totalSteps = 5;
        this.highlightTargets = [];
        this.animationTimeouts = [];

        // UI Manager 相關
        this.subtitleContainer = null;
        this.interactionButtons = null;
        this.isHovering = false;
        this.hoverTimer = null;

        // 提交表單狀態
        this.isSubmitFormOpen = false;

        // 統一的定時器管理
        this.highlightTimer = null;
        this.hoverGuideTimer = null;

        // popup檢測相關
        this.popupDetectionInterval = null;
        this.popupDetected = localStorage.getItem('subpal-tutorial-popup-detected') === 'true';

        this.init();
    }
    
    init() {
        // 確保DOM完全載入後再初始化
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.setupEventListeners();
                this.setupHighlightSystem();
                this.startTutorial();
            });
        } else {
            this.setupEventListeners();
            this.setupHighlightSystem();
            this.startTutorial();
        }
    }
    
    setupEventListeners() {
        // 導航按鈕
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        const finishBtn = document.getElementById('finish-btn');
        const skipBtn = document.getElementById('skip-btn');
        
        if (prevBtn) prevBtn.addEventListener('click', () => this.previousStep());
        if (nextBtn) nextBtn.addEventListener('click', () => this.nextStep());
        if (finishBtn) finishBtn.addEventListener('click', () => this.finishTutorial());
        if (skipBtn) skipBtn.addEventListener('click', () => this.skipTutorial());
        
        // 步驟指示器點擊
        document.querySelectorAll('.step').forEach(step => {
            step.addEventListener('click', () => {
                const stepNumber = parseInt(step.dataset.step);
                this.goToStep(stepNumber);
            });
        });
        
        // 添加全域事件委託來處理提交按鈕點擊
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('submit-btn') || e.target.closest('.submit-btn')) {
                console.log('通過事件委託捕獲到提交按鈕點擊');
                e.preventDefault();
                e.stopPropagation();
                this.showSubmitForm();
            }
            
        });
        
        // 第五頁完成按鈕事件
        const step5NetflixBtn = document.getElementById('step5-netflix-btn');
        const step5CloseBtn = document.getElementById('step5-close-btn');
        
        if (step5NetflixBtn) {
            step5NetflixBtn.addEventListener('click', () => {
                console.log('[Tutorial] 第五頁開啟Netflix並關閉教學');
                // 先記錄教學完成狀態
                this.markTutorialCompleted();
                // 然後開啟Netflix並關閉教學
                window.open('https://netflix.com', '_blank');
                setTimeout(() => {
                    window.close();
                }, 500);
            });
        }
        
        if (step5CloseBtn) {
            step5CloseBtn.addEventListener('click', () => {
                console.log('[Tutorial] 第五頁關閉教學');
                // 先記錄教學完成狀態
                this.markTutorialCompleted();
                window.close();
            });
        }
        
        // 鍵盤導航
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') this.previousStep();
            if (e.key === 'ArrowRight') this.nextStep();
            if (e.key === 'Escape') this.hideHighlight();
        });
    }
    
    setupHighlightSystem() {
        this.highlightOverlay = document.getElementById('highlight-overlay');
        this.highlightTooltip = document.getElementById('highlight-tooltip');
        
        // 定義每個步驟的高亮目標
        this.highlightTargets = {
            1: [],
            2: [
                {
                    selector: '#subtitle-assistant-container',
                    message: '將滑鼠移動到這個字幕區域上方',
                    delay: 2000,
                    condition: () => !this.isHovering // 只有在沒有hover時才顯示
                }
            ],
            3: [], // 第3步（字幕樣式設定）不使用高亮
            4: [], // 第4步（擴充功能面板）不使用高亮，改用箭頭指向真實位置
            5: []  // 第5步（完成教學）
        };
    }
    
    startTutorial() {
        // 重置popup檢測狀態，確保每次開始教學時都是全新的體驗
        this.popupDetected = false;
        localStorage.removeItem('subpal-tutorial-popup-detected');
        
        this.goToStep(1);
    }
    
    goToStep(stepNumber) {
        console.log('切換到步驟:', stepNumber);
        
        if (stepNumber < 1 || stepNumber > this.totalSteps) return;
        
        // 清除之前的動畫和定時器
        this.clearAnimationTimeouts();
        this.clearAllHighlightTimers();
        this.hideHighlight();
        
        // 如果離開第四頁，清除箭頭和恭喜訊息，停止popup檢測
        if (this.currentStep === 4 && stepNumber !== 4) {
            const realArrow = document.getElementById('real-extension-arrow');
            if (realArrow) {
                realArrow.remove();
            }
            this.hideStep4Congratulation();
            this.stopPopupDetection();
        }
        
        // 如果回到第四頁且之前已經檢測過popup，重新顯示恭喜訊息
        if (stepNumber === 4 && this.popupDetected) {
            setTimeout(() => {
                this.showStep4Congratulation();
            }, 1000); // 等箭頭顯示後再顯示恭喜訊息
        }
        
        // 更新當前步驟
        this.currentStep = stepNumber;
        
        // 更新步驟顯示
        this.updateStepDisplay();
        
        // 更新步驟指示器
        this.updateStepIndicator();
        
        // 更新導航按鈕
        this.updateNavigationButtons();
        
        // 開始步驟特定的動畫和高亮
        this.startStepAnimations();
        
        // 步驟特定邏輯
        this.handleStepSpecificLogic();
    }
    
    updateStepDisplay() {
        // 隱藏所有步驟
        document.querySelectorAll('.tutorial-step').forEach(step => {
            step.classList.remove('active');
        });
        
        // 顯示當前步驟
        const currentStepElement = document.getElementById(`step-${this.currentStep}`);
        if (currentStepElement) {
            currentStepElement.classList.add('active');
        }
    }
    
    updateStepIndicator() {
        document.querySelectorAll('.step').forEach((step, index) => {
            const stepNumber = index + 1;
            step.classList.remove('active', 'completed');
            
            if (stepNumber === this.currentStep) {
                step.classList.add('active');
            } else if (stepNumber < this.currentStep) {
                step.classList.add('completed');
            }
        });
    }
    
    updateNavigationButtons() {
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        const finishBtn = document.getElementById('finish-btn');
        
        // 上一步按鈕
        if (prevBtn) {
            prevBtn.disabled = this.currentStep === 1;
        }
        
        // 下一步/完成按鈕
        if (this.currentStep === this.totalSteps) {
            if (nextBtn) nextBtn.classList.add('hidden');
            if (finishBtn) finishBtn.classList.remove('hidden');
        } else {
            if (nextBtn) nextBtn.classList.remove('hidden');
            if (finishBtn) finishBtn.classList.add('hidden');
        }
    }
    
    startStepAnimations() {
        // 啟動高亮效果
        const targets = this.highlightTargets[this.currentStep];
        if (targets) {
            targets.forEach(target => {
                this.scheduleHighlight(target.selector, target.message, target.delay, target.condition);
            });
        }
    }
    
    handleStepSpecificLogic() {
        switch (this.currentStep) {
            case 1:
                // 歡迎頁面，無需特殊邏輯
                break;
            case 2:
                // 初始化模擬的字幕 UI
                setTimeout(() => this.initSubtitleUI(), 500);
                break;
            case 3:
                // 字幕樣式設定頁面
                setTimeout(() => this.initSubtitleStyleCustomization(), 500);
                break;
            case 4:
                // 重設瀏覽器演示
                this.resetBrowserDemo();
                // 顯示指向真實擴充功能按鈕位置的箭頭
                setTimeout(() => this.showExtensionGuideArrow(), 1000);
                // 開始檢測真實popup開啟
                this.startPopupDetection();
                break;
            case 5:
                // 完成頁面，無需特殊邏輯
                break;
        }
    }
    
    // 初始化字幕 UI（模擬真實插件行為）
    initSubtitleUI() {
        this.subtitleContainer = document.getElementById('subtitle-assistant-container');
        this.interactionButtons = document.getElementById('subtitle-assistant-buttons');
        
        if (this.subtitleContainer && this.interactionButtons) {
            // 移除舊的事件監聽器
            const newSubtitleContainer = this.subtitleContainer.cloneNode(true);
            const newInteractionButtons = this.interactionButtons.cloneNode(true);
            
            this.subtitleContainer.parentNode.replaceChild(newSubtitleContainer, this.subtitleContainer);
            this.interactionButtons.parentNode.replaceChild(newInteractionButtons, this.interactionButtons);
            
            this.subtitleContainer = newSubtitleContainer;
            this.interactionButtons = newInteractionButtons;
            
            // 添加事件監聽器
            this.subtitleContainer.addEventListener('mouseenter', this.showInteractionButtons.bind(this));
            this.subtitleContainer.addEventListener('mouseleave', this.hideInteractionButtons.bind(this));
            this.interactionButtons.addEventListener('mouseenter', this.showInteractionButtons.bind(this));
            this.interactionButtons.addEventListener('mouseleave', this.hideInteractionButtons.bind(this));
            
            // 添加按鈕點擊事件
            const submitBtn = this.interactionButtons.querySelector('.submit-btn');
            const upvoteBtn = this.interactionButtons.querySelector('.upvote');
            const downvoteBtn = this.interactionButtons.querySelector('.downvote');
            
            console.log('找到的按鈕:', { submitBtn, upvoteBtn, downvoteBtn });
            
            if (submitBtn) {
                submitBtn.addEventListener('click', (e) => {
                    console.log('提交按鈕被點擊');
                    e.preventDefault();
                    e.stopPropagation();
                    this.showSubmitForm();
                });
                console.log('提交按鈕事件監聽器已添加');
            } else {
                console.error('找不到提交按鈕');
            }
            
            if (upvoteBtn) upvoteBtn.addEventListener('click', () => this.showSuccessMessage('模擬投票成功！'));
            if (downvoteBtn) downvoteBtn.addEventListener('click', () => this.showSuccessMessage('模擬投票成功！'));
        }
        
        // 延遲顯示引導（5秒無操作時才顯示）
        this.scheduleResumeHighlight(5000);
    }
    
    // 顯示互動按鈕（基於真實 UI Manager 邏輯）
    showInteractionButtons() {
        if (this.interactionButtons && this.subtitleContainer) {
            this.interactionButtons.style.display = 'flex';
            
            // 計算位置（在字幕右上角）
            const rect = this.subtitleContainer.getBoundingClientRect();
            const playerContainer = document.getElementById('player-container');
            const playerRect = playerContainer.getBoundingClientRect();
            
            // 相對於播放器容器的位置
            const relativeTop = rect.top - playerRect.top - this.interactionButtons.offsetHeight - 8;
            const relativeLeft = rect.right - playerRect.left - this.interactionButtons.offsetWidth / 2;
            
            this.interactionButtons.style.position = 'absolute';
            this.interactionButtons.style.top = `${relativeTop}px`;
            this.interactionButtons.style.left = `${relativeLeft}px`;
            
            this.isHovering = true;
            if (this.hoverTimer) {
                clearTimeout(this.hoverTimer);
                this.hoverTimer = null;
            }
            
            // 立即清理所有定時器和提示
            this.clearAllHighlightTimers();
            this.hideHoverGuide();
            this.hideHighlight();
        }
    }
    
    hideInteractionButtons() {
        this.isHovering = false;
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
            if (!this.isHovering && this.interactionButtons) {
                this.interactionButtons.style.display = 'none';
                
                // 鼠標離開後3秒恢復提示
                this.scheduleResumeHighlight(3000);
            }
        }, 300);
    }
    
    showHoverGuide() {
        const guide = document.getElementById('hover-guide');
        if (guide && this.currentStep === 2 && !this.isSubmitFormOpen) {
            guide.style.display = 'flex';
        }
    }
    
    hideHoverGuide() {
        const guide = document.getElementById('hover-guide');
        if (guide) {
            guide.style.display = 'none';
        }
    }
    
    resetBrowserDemo() {
        // 移除任何現有的真實位置箭頭
        const existingArrow = document.getElementById('real-extension-arrow');
        if (existingArrow) {
            existingArrow.remove();
        }
    }
    
    // 顯示指向真實擴充功能按鈕位置的箭頭
    showExtensionGuideArrow() {
        // 移除舊箭頭
        const existingArrow = document.getElementById('real-extension-arrow');
        if (existingArrow) {
            existingArrow.remove();
        }
        
        // 創建指向真實瀏覽器擴充功能按鈕的紅色箭頭
        const realArrow = document.createElement('div');
        realArrow.id = 'real-extension-arrow';
        realArrow.innerHTML = `
            <div class="real-arrow-content">
                <div class="real-arrow-text">
                    <div class="arrow-instruction">請點擊瀏覽器右上角的</div>
                    <div class="arrow-extension-icon">🧩</div>
                    <div class="arrow-instruction">擴充功能按鈕</div>
                </div>
                <div class="real-arrow-curved">
                    <svg class="arrow-svg" width="250" height="400" viewBox="0 0 250 120">
                        <path d="M 40 100 Q 150 60 200 -60" stroke="#F59E0B" stroke-width="5" fill="none" marker-end="url(#arrowhead)" />
                        <defs>
                            <marker id="arrowhead" markerWidth="12" markerHeight="10" refX="10" refY="5" orient="auto">
                                <polygon points="0 0, 12 5, 0 10" fill="#F59E0B" />
                            </marker>
                        </defs>
                    </svg>
                </div>
            </div>
        `;
        
        realArrow.style.cssText = `
            position: fixed;
            top: 120px;
            right: 300px;
            z-index: 2000;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            animation: bounce 1.5s infinite;
            pointer-events: none;
        `;
        
        document.body.appendChild(realArrow);
        
        // 添加箭頭樣式
        if (!document.querySelector('#real-arrow-styles')) {
            const style = document.createElement('style');
            style.id = 'real-arrow-styles';
            style.textContent = `
                .real-arrow-content {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 0.5rem;
                    position: relative;
                }
                
                .real-arrow-text {
                    background: #F59E0B;
                    color: white;
                    padding: 1rem 1.5rem;
                    border-radius: 12px;
                    text-align: center;
                    box-shadow: 0 4px 20px rgba(245, 158, 11, 0.3);
                    position: relative;
                    white-space: nowrap;
                    max-width: 200px;
                }
                
                .arrow-instruction {
                    font-size: 1rem;
                    font-weight: 500;
                    line-height: 1.2;
                }
                
                .arrow-extension-icon {
                    font-size: 1.5rem;
                    margin: 0.3rem 0;
                }
                
                .real-arrow-curved svg {
                    filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
                }
                
                .arrow-svg {
                    position: absolute;
                    top: -150px;
                    right: -200px;
                }
                
                @media (max-width: 768px) {
                    #real-extension-arrow {
                        top: 80px !important;
                        right: 120px !important;
                    }
                    
                    .real-arrow-text {
                        padding: 0.8rem 1rem;
                        font-size: 0.9rem;
                    }
                    
                    .arrow-instruction {
                        font-size: 0.9rem;
                    }
                    
                    .arrow-extension-icon {
                        font-size: 1.3rem;
                    }
                    
                    .real-arrow-curved svg {
                        width: 180px;
                        height: 100px;
                    }
                }
                
                @media (max-width: 480px) {
                    #real-extension-arrow {
                        top: 60px !important;
                        right: 80px !important;
                    }
                    
                    .real-arrow-curved svg {
                        width: 150px;
                        height: 80px;
                    }
                }
            `;
            document.head.appendChild(style);
        }
        
        // 箭頭會持續顯示直到離開第三頁
    }
    
    scheduleHighlight(selector, message, delay, condition) {
        // 清理現有的高亮定時器
        this.clearAllHighlightTimers();
        
        this.highlightTimer = setTimeout(() => {
            // 實時檢查所有條件
            if (this.isSubmitFormOpen || this.isHovering || this.currentStep !== 2) {
                return;
            }
            // 檢查條件（如果有的話）
            if (condition && !condition()) {
                return;
            }
            this.highlightElement(selector, message);
        }, delay);
    }
    
    highlightElement(selector, message) {
        const element = document.querySelector(selector);
        if (!element) return;
        
        const rect = element.getBoundingClientRect();
        const scrollY = window.scrollY;
        const scrollX = window.scrollX;
        
        // 顯示遮罩
        if (this.highlightOverlay) {
            this.highlightOverlay.classList.add('active');
        }
        
        // 創建高亮區域
        this.createHighlightArea(rect, scrollX, scrollY);
        
        // 顯示提示
        this.showTooltip(message, rect, scrollX, scrollY);
        
        // 自動隱藏
        setTimeout(() => {
            this.hideHighlight();
        }, 5000);
    }
    
    createHighlightArea(rect, scrollX, scrollY) {
        // 移除舊的高亮區域
        const existingHighlight = document.querySelector('.highlight-area');
        if (existingHighlight) {
            existingHighlight.remove();
        }
        
        // 創建新的高亮區域
        const highlightArea = document.createElement('div');
        highlightArea.className = 'highlight-area';
        highlightArea.style.cssText = `
            position: absolute;
            top: ${rect.top + scrollY - 10}px;
            left: ${rect.left + scrollX - 10}px;
            width: ${rect.width + 20}px;
            height: ${rect.height + 20}px;
            background: rgba(245, 158, 11, 0.3);
            border: 3px solid #F59E0B;
            border-radius: 8px;
            z-index: 1001;
            pointer-events: none;
            animation: highlightPulse 2s infinite;
        `;
        
        document.body.appendChild(highlightArea);
    }
    
    showTooltip(message, rect, scrollX, scrollY) {
        if (!this.highlightTooltip) return;
        
        this.highlightTooltip.textContent = message;
        this.highlightTooltip.classList.add('active');
        
        // 計算提示位置
        let tooltipX = rect.left + scrollX + rect.width / 2;
        let tooltipY = rect.top + scrollY - 60;
        
        // 邊界檢查
        const tooltipRect = this.highlightTooltip.getBoundingClientRect();
        if (tooltipX + tooltipRect.width / 2 > window.innerWidth) {
            tooltipX = window.innerWidth - tooltipRect.width / 2 - 20;
        }
        if (tooltipX - tooltipRect.width / 2 < 0) {
            tooltipX = tooltipRect.width / 2 + 20;
        }
        if (tooltipY < 0) {
            tooltipY = rect.bottom + scrollY + 20;
        }
        
        this.highlightTooltip.style.left = `${tooltipX - tooltipRect.width / 2}px`;
        this.highlightTooltip.style.top = `${tooltipY}px`;
    }
    
    hideHighlight() {
        if (this.highlightOverlay) {
            this.highlightOverlay.classList.remove('active');
        }
        if (this.highlightTooltip) {
            this.highlightTooltip.classList.remove('active');
        }
        
        // 移除高亮區域
        const highlightArea = document.querySelector('.highlight-area');
        if (highlightArea) {
            highlightArea.remove();
        }
    }
    
    clearAnimationTimeouts() {
        this.animationTimeouts.forEach(timeout => clearTimeout(timeout));
        this.animationTimeouts = [];
        
        // 清除真實位置箭頭（只有在離開第三頁時才清除）
        if (this.currentStep !== 3) {
            const realArrow = document.getElementById('real-extension-arrow');
            if (realArrow) {
                realArrow.remove();
            }
        }
    }
    
    // 清理所有相關定時器的方法
    clearAllHighlightTimers() {
        if (this.highlightTimer) {
            clearTimeout(this.highlightTimer);
            this.highlightTimer = null;
        }
        if (this.hoverGuideTimer) {
            clearTimeout(this.hoverGuideTimer);
            this.hoverGuideTimer = null;
        }
    }
    
    // 統一的恢復提示方法
    scheduleResumeHighlight(delay = 5000) {
        // 清理現有定時器
        this.clearAllHighlightTimers();
        
        this.hoverGuideTimer = setTimeout(() => {
            // 確保在正確的條件下才恢復提示
            if (!this.isHovering && this.currentStep === 2 && !this.isSubmitFormOpen) {
                this.showHoverGuide();
                this.scheduleHighlight('#subtitle-assistant-container', '將滑鼠移動到這個字幕區域上方', 0);
            }
        }, delay);
    }
    
    nextStep() {
        if (this.currentStep < this.totalSteps) {
            this.goToStep(this.currentStep + 1);
        }
    }
    
    previousStep() {
        if (this.currentStep > 1) {
            this.goToStep(this.currentStep - 1);
        }
    }
    
    // 顯示模擬提交表單
    showSubmitForm() {
        const overlay = document.getElementById('tutorial-submit-overlay');
        
        if (overlay) {
            // 設置提交表單開啟狀態
            this.isSubmitFormOpen = true;
            
            // 清理所有定時器和提示
            this.clearAllHighlightTimers();
            this.hideHoverGuide();
            this.hideHighlight();
            
            overlay.classList.add('show');
            
            // 設置事件監聽器
            this.setupSubmitFormListeners();
            
            // 自動焦點到翻譯輸入框
            setTimeout(() => {
                const translationInput = document.getElementById('tutorial-translation-input');
                if (translationInput) {
                    translationInput.focus();
                    translationInput.select();
                }
            }, 100);
        }
    }
    
    // 隱藏模擬提交表單
    hideSubmitForm() {
        const overlay = document.getElementById('tutorial-submit-overlay');
        if (overlay) {
            overlay.classList.remove('show');
            
            // 重置提交表單狀態
            this.isSubmitFormOpen = false;
            
            // 關閉表單後，10秒冷卻時間再恢復提示（避免畫面閃爍）
            if (this.currentStep === 2) {
                this.scheduleResumeHighlight(10000);
            }
        }
    }
    
    // 設置提交表單的事件監聽器
    setupSubmitFormListeners() {
        // 移除舊的事件監聽器（避免重複綁定）
        const cancelBtn = document.getElementById('tutorial-cancel-btn');
        const submitBtn = document.getElementById('tutorial-submit-btn');
        
        if (cancelBtn) {
            cancelBtn.replaceWith(cancelBtn.cloneNode(true));
            const newCancelBtn = document.getElementById('tutorial-cancel-btn');
            newCancelBtn.addEventListener('click', () => this.hideSubmitForm());
        }
        
        if (submitBtn) {
            submitBtn.replaceWith(submitBtn.cloneNode(true));
            const newSubmitBtn = document.getElementById('tutorial-submit-btn');
            newSubmitBtn.addEventListener('click', () => this.handleSubmitFormSubmission());
        }
        
        // 點擊遮罩層關閉表單
        const overlay = document.getElementById('tutorial-submit-overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.hideSubmitForm();
                }
            });
        }
        
        // ESC鍵關閉表單
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                this.hideSubmitForm();
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
    }
    
    // 處理模擬提交表單的提交
    handleSubmitFormSubmission() {
        const translationInput = document.getElementById('tutorial-translation-input');
        const reasonInput = document.getElementById('tutorial-reason-input');
        const languageSelect = document.getElementById('tutorial-language-select');
        
        const translation = translationInput?.value.trim();
        const reason = reasonInput?.value.trim();
        const language = languageSelect?.value;
        
        // 簡單驗證
        if (!translation) {
            this.showValidationError('請輸入修正翻譯');
            translationInput?.focus();
            return;
        }
        
        if (!reason) {
            this.showValidationError('請填寫調整原因');
            reasonInput?.focus();
            return;
        }
        
        if (!language) {
            this.showValidationError('請選擇字幕語言');
            languageSelect?.focus();
            return;
        }
        
        // 模擬提交成功
        this.hideSubmitForm();
        this.showSuccessMessage('模擬提交翻譯成功！感謝您的貢獻');
    }
    
    // 顯示驗證錯誤
    showValidationError(message) {
        // 創建錯誤提示
        const errorDiv = document.createElement('div');
        errorDiv.className = 'validation-error';
        errorDiv.textContent = message;
        errorDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #f44336;
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            z-index: 15000;
            animation: slideInRight 0.3s ease-out;
            box-shadow: 0 4px 20px rgba(244, 67, 54, 0.3);
        `;
        
        document.body.appendChild(errorDiv);
        
        // 自動移除
        setTimeout(() => {
            errorDiv.style.animation = 'slideOutRight 0.3s ease-in';
            setTimeout(() => {
                if (errorDiv.parentNode) {
                    errorDiv.remove();
                }
            }, 300);
        }, 3000);
    }
    
    // 顯示第四頁恭喜訊息
    showStep4Congratulation() {
        const congratulation = document.getElementById('step4-congratulation');
        if (congratulation) {
            congratulation.classList.add('show');
            
            // 同時隱藏指導箭頭，因為用戶已經完成操作
            const realArrow = document.getElementById('real-extension-arrow');
            if (realArrow) {
                realArrow.style.opacity = '0.3';
                realArrow.style.pointerEvents = 'none';
            }
            
            // 不再自動隱藏恭喜訊息 - 讓它永遠顯示
            // setTimeout(() => {
            //     this.hideStep4Congratulation();
            // }, 3000);
        }
    }
    
    // 隱藏第四頁恭喜訊息
    hideStep4Congratulation() {
        const congratulation = document.getElementById('step4-congratulation');
        if (congratulation) {
            congratulation.classList.remove('show');
        }
        
        // 恢復指導箭頭
        const realArrow = document.getElementById('real-extension-arrow');
        if (realArrow) {
            realArrow.style.opacity = '1';
            realArrow.style.pointerEvents = 'none';
        }
    }
    
    // 開始檢測真實popup開啟
    startPopupDetection() {
        // 如果已經檢測過popup，直接顯示恭喜訊息，不需要重複檢測
        if (this.popupDetected) {
            setTimeout(() => {
                this.showStep4Congratulation();
            }, 1000);
            return;
        }
        
        // 避免重複檢測
        if (this.popupDetectionInterval) {
            clearInterval(this.popupDetectionInterval);
        }
        
        console.log('[Tutorial] 開始檢測popup開啟...');
        
        // 每2秒檢測一次作為備用機制 (主要檢測靠POPUP_API_REQUEST消息)
        this.popupDetectionInterval = setInterval(() => {
            this.checkForPopup();
        }, 2000);
        
        // 監聽chrome extension的消息傳遞系統
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener((message) => {
                // 檢測 POPUP_API_REQUEST 消息，這表示popup已經開啟並在發送API請求
                if (message && message.type === 'POPUP_API_REQUEST') {
                    console.log('[Tutorial] 檢測到POPUP_API_REQUEST，popup已開啟');
                    this.onPopupDetected();
                }
                return false; // 不需要異步響應
            });
        }
    }
    
    // 停止popup檢測
    stopPopupDetection() {
        if (this.popupDetectionInterval) {
            clearInterval(this.popupDetectionInterval);
            this.popupDetectionInterval = null;
        }
        console.log('[Tutorial] 停止popup檢測');
    }
    
    // 檢測popup是否開啟 (輔助方法，主要靠監聽POPUP_API_REQUEST)
    checkForPopup() {
        // 備用方法: 檢測是否有popup.html的iframe (罕見情況)
        const popupIframes = document.querySelectorAll('iframe[src*="popup.html"]');
        
        if (popupIframes.length > 0) {
            console.log('[Tutorial] 檢測到popup iframe (備用方法)');
            this.onPopupDetected();
            return;
        }
        
        // 主要檢測方式已改為監聽 POPUP_API_REQUEST 消息
        // 這個定期檢測只是作為備用機制
    }
    
    // 當檢測到popup開啟時
    onPopupDetected() {
        if (this.popupDetected || this.currentStep !== 4) {
            return; // 避免重複觸發或不在第四步時觸發
        }
        
        this.popupDetected = true;
        
        // 保存到localStorage
        localStorage.setItem('subpal-tutorial-popup-detected', 'true');
        
        console.log('[Tutorial] Popup已開啟！顯示恭喜訊息');
        
        // 停止檢測
        this.stopPopupDetection();
        
        // 顯示恭喜訊息
        this.showStep4Congratulation();
    }
    
    // 移除模擬互動功能，只保留引導到真實擴充功能按鈕的功能
    
    showSuccessMessage(message) {
        // 創建成功提示
        const successDiv = document.createElement('div');
        successDiv.className = 'success-message';
        successDiv.textContent = message;
        successDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--tutorial-secondary);
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            z-index: 2000;
            animation: slideInRight 0.3s ease-out;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        `;
        
        document.body.appendChild(successDiv);
        
        // 自動移除
        setTimeout(() => {
            successDiv.style.animation = 'slideOutRight 0.3s ease-in';
            setTimeout(() => {
                if (successDiv.parentNode) {
                    successDiv.remove();
                }
            }, 300);
        }, 2000);
        
        // 添加動畫樣式
        if (!document.querySelector('#success-animations')) {
            const style = document.createElement('style');
            style.id = 'success-animations';
            style.textContent = `
                @keyframes slideInRight {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOutRight {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
                @keyframes highlightPulse {
                    0%, 100% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.05); opacity: 0.7; }
                }
            `;
            document.head.appendChild(style);
        }
    }
    
    finishTutorial() {
        // 記錄教學完成狀態
        this.markTutorialCompleted();
        
        // 直接關閉教學頁面（只有最後一頁的按鈕才會到這裡）
        window.close();
    }
    
    skipTutorial() {
        // 顯示跳過教學的確認視窗
        this.showSkipConfirmation();
    }
    
    showSkipConfirmation() {
        const confirmationDiv = document.createElement('div');
        confirmationDiv.className = 'skip-confirmation';
        confirmationDiv.innerHTML = `
            <div class="skip-confirmation-content">
                <h3>確認跳過教學？</h3>
                <p>您確定要離開教學嗎？</p>
                <div class="skip-confirmation-buttons">
                    <button id="skip-confirm-yes" class="skip-btn-yes">是，離開教學</button>
                    <button id="skip-confirm-no" class="skip-btn-no">繼續教學</button>
                </div>
            </div>
        `;
        
        confirmationDiv.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 4000;
            animation: fadeIn 0.3s ease-out;
        `;
        
        document.body.appendChild(confirmationDiv);
        
        // 添加樣式
        if (!document.querySelector('#skip-confirmation-styles')) {
            const style = document.createElement('style');
            style.id = 'skip-confirmation-styles';
            style.textContent = `
                .skip-confirmation-content {
                    background: var(--color-card-bg);
                    padding: 2rem;
                    border-radius: 12px;
                    text-align: center;
                    max-width: 400px;
                    animation: slideInUp 0.3s ease-out;
                }
                .skip-confirmation-content h3 {
                    color: var(--tutorial-primary);
                    margin-bottom: 1rem;
                    font-size: 1.5rem;
                }
                .skip-confirmation-content p {
                    color: var(--color-gray);
                    margin-bottom: 1.5rem;
                    line-height: 1.5;
                }
                .skip-confirmation-buttons {
                    display: flex;
                    gap: 1rem;
                    justify-content: center;
                }
                .skip-btn-yes, .skip-btn-no {
                    padding: 0.8rem 1.5rem;
                    border: none;
                    border-radius: 8px;
                    font-size: 1rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.3s ease;
                }
                .skip-btn-yes {
                    background: #f44336;
                    color: white;
                }
                .skip-btn-yes:hover {
                    background: #d32f2f;
                    transform: translateY(-2px);
                }
                .skip-btn-no {
                    background: var(--tutorial-primary);
                    color: white;
                }
                .skip-btn-no:hover {
                    background: var(--tutorial-secondary);
                    transform: translateY(-2px);
                }
            `;
            document.head.appendChild(style);
        }
        
        // 添加事件監聽器
        const yesBtn = document.getElementById('skip-confirm-yes');
        const noBtn = document.getElementById('skip-confirm-no');
        
        if (yesBtn) {
            yesBtn.addEventListener('click', () => {
                console.log('[Tutorial] 確認跳過教學');
                this.markTutorialCompleted();
                this.hideSkipConfirmation();
                setTimeout(() => {
                    window.close();
                }, 300);
            });
        }
        
        if (noBtn) {
            noBtn.addEventListener('click', () => {
                console.log('[Tutorial] 繼續教學');
                this.hideSkipConfirmation();
            });
        }
        
        // ESC鍵關閉確認試窗
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                this.hideSkipConfirmation();
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
    }
    
    hideSkipConfirmation() {
        const confirmationDiv = document.querySelector('.skip-confirmation');
        if (confirmationDiv) {
            confirmationDiv.style.animation = 'fadeOut 0.3s ease-in';
            setTimeout(() => {
                if (confirmationDiv.parentNode) {
                    confirmationDiv.remove();
                }
            }, 300);
        }
    }
    
    // 獨立的方法來記錄教學完成狀態
    markTutorialCompleted() {
        // 記錄教學完成狀態到擴充功能的儲存空間
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ tutorialCompleted: true }, () => {
                console.log('[Tutorial] Tutorial completion status saved');
            });
        }
        
        // 同時記錄到 localStorage 作為備份
        localStorage.setItem('subpal-tutorial-completed', 'true');
        
        // 清除popup檢測狀態，下次重新開始教學時會重置
        localStorage.removeItem('subpal-tutorial-popup-detected');
    }
    
    // 移除不必要的完成確認頁面邏輯
    // showCompletionMessage() 和 hideCompletionMessage() 方法已被移除
    // 現在直接透過第五頁的按鈕執行相應動作
    
    // === 字幕樣式自定義功能（使用新的 config 系統） ===

    // 初始化字幕樣式自定義功能
    async initSubtitleStyleCustomization() {
        console.log('[Tutorial] 初始化字幕樣式自定義功能');

        // 動態生成語言選項
        this.populateLanguageSelects();

        // 設置事件監聽器
        this.setupSubtitleStyleListeners();

        // 載入配置並恢復 UI
        await this.restoreSubtitleUI();
    }

    // 動態生成語言選項
    populateLanguageSelects() {
        const primarySelect = document.getElementById('tutorialPrimaryLanguageSelect');
        const secondarySelect = document.getElementById('tutorialSecondaryLanguageSelect');

        if (primarySelect) {
            primarySelect.innerHTML = '';
            for (const lang of SUPPORTED_LANGUAGES) {
                primarySelect.add(new Option(lang.name, lang.code));
            }
        }

        if (secondarySelect) {
            secondarySelect.innerHTML = '';
            for (const lang of SUPPORTED_LANGUAGES) {
                secondarySelect.add(new Option(lang.name, lang.code));
            }
        }

        console.log(`[Tutorial] 已載入 ${SUPPORTED_LANGUAGES.length} 種語言選項`);
    }

    // 恢復 UI 狀態（從新的 config 系統載入）
    async restoreSubtitleUI() {
        try {
            const config = await loadConfig();
            console.log('[Tutorial] 載入配置:', config);

            // 字幕模式
            const isDualMode = config['subtitle.dualModeEnabled'];
            const singleModeRadio = document.getElementById('tutorialSingleMode');
            const dualModeRadio = document.getElementById('tutorialDualMode');
            if (singleModeRadio && dualModeRadio) {
                singleModeRadio.checked = !isDualMode;
                dualModeRadio.checked = isDualMode;
            }

            // 語言設定
            const primaryLanguageSelect = document.getElementById('tutorialPrimaryLanguageSelect');
            const secondaryLanguageSelect = document.getElementById('tutorialSecondaryLanguageSelect');
            if (primaryLanguageSelect) {
                primaryLanguageSelect.value = config['subtitle.primaryLanguage'];
            }
            if (secondaryLanguageSelect) {
                secondaryLanguageSelect.value = config['subtitle.secondaryLanguage'];
            }

            // 主要字幕樣式
            this.updateStyleControls('tutorialPrimary', {
                fontSize: config['subtitle.style.primary.fontSize'],
                textColor: config['subtitle.style.primary.textColor'],
                backgroundColor: config['subtitle.style.primary.backgroundColor']
            });

            // 次要字幕樣式
            this.updateStyleControls('tutorialSecondary', {
                fontSize: config['subtitle.style.secondary.fontSize'],
                textColor: config['subtitle.style.secondary.textColor'],
                backgroundColor: config['subtitle.style.secondary.backgroundColor']
            });

            // 更新 UI 顯示狀態
            this.updateSubtitleModeUI(isDualMode);
            this.updatePreview(config);

        } catch (error) {
            console.error('[Tutorial] 載入配置失敗:', error);
        }
    }

    // 更新樣式控制項
    updateStyleControls(prefix, styleConfig) {
        const fontSizeSlider = document.getElementById(`${prefix}FontSize`);
        const fontSizeValue = document.getElementById(`${prefix}FontSizeValue`);
        const textColorPicker = document.getElementById(`${prefix}TextColor`);
        const textColorHex = document.getElementById(`${prefix}TextColorHex`);
        const backgroundColorPicker = document.getElementById(`${prefix}BackgroundColor`);
        const backgroundColorHex = document.getElementById(`${prefix}BackgroundColorHex`);
        const backgroundOpacitySlider = document.getElementById(`${prefix}BackgroundOpacity`);
        const backgroundOpacityValue = document.getElementById(`${prefix}BackgroundOpacityValue`);

        if (fontSizeSlider && fontSizeValue) {
            fontSizeSlider.value = styleConfig.fontSize;
            fontSizeValue.textContent = styleConfig.fontSize;
        }

        if (textColorPicker) {
            textColorPicker.value = styleConfig.textColor;
            if (textColorHex) {
                textColorHex.textContent = styleConfig.textColor;
            }
        }

        if (backgroundColorPicker && backgroundOpacitySlider && backgroundOpacityValue) {
            const { hex, opacity } = parseRgba(styleConfig.backgroundColor);
            backgroundColorPicker.value = hex;
            backgroundOpacitySlider.value = opacity;
            backgroundOpacityValue.textContent = opacity.toFixed(2);
            if (backgroundColorHex) {
                backgroundColorHex.textContent = hex;
            }
        }
    }

    // 更新字幕模式 UI
    updateSubtitleModeUI(isDualMode) {
        const secondaryLanguageSelect = document.getElementById('tutorialSecondaryLanguageSelect');
        const secondaryPreview = document.getElementById('tutorialSecondaryPreview');
        const secondaryPanel = document.getElementById('tutorialSecondaryPanel');

        // 控制次要語言選擇器的 disabled 狀態
        if (secondaryLanguageSelect) {
            secondaryLanguageSelect.disabled = !isDualMode;
        }

        // 控制次要語言預覽的顯示
        if (secondaryPreview) {
            secondaryPreview.style.display = isDualMode ? 'block' : 'none';
        }

        // 控制次要語言樣式面板的 disabled 狀態
        if (secondaryPanel) {
            secondaryPanel.classList.toggle('disabled', !isDualMode);
            // 同時控制面板內所有輸入控制項的 disabled 狀態
            const inputs = secondaryPanel.querySelectorAll('input');
            inputs.forEach(input => {
                input.disabled = !isDualMode;
            });
        }
    }

    // 更新預覽
    async updatePreview(config = null) {
        if (!config) {
            config = await loadConfig();
        }

        const primaryPreview = document.getElementById('tutorialPrimaryPreview');
        const secondaryPreview = document.getElementById('tutorialSecondaryPreview');

        if (primaryPreview) {
            this.applyPreviewStyles(primaryPreview, {
                fontSize: config['subtitle.style.primary.fontSize'],
                textColor: config['subtitle.style.primary.textColor'],
                backgroundColor: config['subtitle.style.primary.backgroundColor']
            });
        }

        if (secondaryPreview && config['subtitle.dualModeEnabled']) {
            this.applyPreviewStyles(secondaryPreview, {
                fontSize: config['subtitle.style.secondary.fontSize'],
                textColor: config['subtitle.style.secondary.textColor'],
                backgroundColor: config['subtitle.style.secondary.backgroundColor']
            });
        }
    }

    // 應用預覽樣式
    applyPreviewStyles(element, styleConfig) {
        if (!element || !styleConfig) return;

        Object.assign(element.style, {
            fontSize: `${styleConfig.fontSize}px`,
            color: styleConfig.textColor,
            backgroundColor: styleConfig.backgroundColor,
            fontFamily: 'Arial, sans-serif',
            textAlign: 'center',
            borderRadius: '4px',
            textShadow: '1px 1px 1px rgba(0, 0, 0, 0.5)',
            padding: '8px 16px',
            display: 'inline-block',
            minWidth: '120px',
            margin: '2px 5px'
        });
    }
    
    // 設置字幕樣式事件監聽器
    setupSubtitleStyleListeners() {
        // 模式切換
        const singleModeRadio = document.getElementById('tutorialSingleMode');
        const dualModeRadio = document.getElementById('tutorialDualMode');

        if (singleModeRadio) {
            singleModeRadio.addEventListener('change', async () => {
                if (singleModeRadio.checked) {
                    await saveConfig('subtitle.dualModeEnabled', false);
                    this.updateSubtitleModeUI(false);
                }
            });
        }

        if (dualModeRadio) {
            dualModeRadio.addEventListener('change', async () => {
                if (dualModeRadio.checked) {
                    await saveConfig('subtitle.dualModeEnabled', true);
                    this.updateSubtitleModeUI(true);
                }
            });
        }

        // 語言選擇器
        const primaryLanguageSelect = document.getElementById('tutorialPrimaryLanguageSelect');
        const secondaryLanguageSelect = document.getElementById('tutorialSecondaryLanguageSelect');

        if (primaryLanguageSelect) {
            primaryLanguageSelect.addEventListener('change', async (e) => {
                await saveConfig('subtitle.primaryLanguage', e.target.value);
            });
        }

        if (secondaryLanguageSelect) {
            secondaryLanguageSelect.addEventListener('change', async (e) => {
                await saveConfig('subtitle.secondaryLanguage', e.target.value);
            });
        }

        // 主要字幕樣式控制項
        this.setupStyleControlListeners('tutorialPrimary', 'subtitle.style.primary');

        // 次要字幕樣式控制項
        this.setupStyleControlListeners('tutorialSecondary', 'subtitle.style.secondary');

        // 重置樣式按鈕
        const resetStylesBtn = document.getElementById('tutorialResetStyles');
        if (resetStylesBtn) {
            resetStylesBtn.addEventListener('click', () => this.resetStyles());
        }
    }
    
    // 設置樣式控制項監聽器
    setupStyleControlListeners(prefix, keyPrefix) {
        const fontSizeSlider = document.getElementById(`${prefix}FontSize`);
        const fontSizeValue = document.getElementById(`${prefix}FontSizeValue`);
        const textColorPicker = document.getElementById(`${prefix}TextColor`);
        const textColorHex = document.getElementById(`${prefix}TextColorHex`);
        const backgroundColorPicker = document.getElementById(`${prefix}BackgroundColor`);
        const backgroundColorHex = document.getElementById(`${prefix}BackgroundColorHex`);
        const backgroundOpacitySlider = document.getElementById(`${prefix}BackgroundOpacity`);
        const backgroundOpacityValue = document.getElementById(`${prefix}BackgroundOpacityValue`);
        const preview = document.getElementById(`${prefix}Preview`);

        if (fontSizeSlider && fontSizeValue) {
            fontSizeSlider.addEventListener('input', async (e) => {
                const size = parseInt(e.target.value);
                fontSizeValue.textContent = size;
                if (preview) {
                    preview.style.fontSize = `${size}px`;
                }
                await saveConfig(`${keyPrefix}.fontSize`, size);
            });
        }

        if (textColorPicker) {
            textColorPicker.addEventListener('input', (e) => {
                if (preview) {
                    preview.style.color = e.target.value;
                }
                if (textColorHex) {
                    textColorHex.textContent = e.target.value;
                }
            });
            textColorPicker.addEventListener('change', async (e) => {
                await saveConfig(`${keyPrefix}.textColor`, e.target.value);
            });
        }

        if (backgroundColorPicker && backgroundOpacitySlider && backgroundOpacityValue) {
            const updateBackgroundColor = async (shouldSave = true) => {
                const hex = backgroundColorPicker.value;
                const opacity = parseFloat(backgroundOpacitySlider.value);
                const rgba = toRgba(hex, opacity);
                if (preview) {
                    preview.style.backgroundColor = rgba;
                }
                if (backgroundColorHex) {
                    backgroundColorHex.textContent = hex;
                }
                if (shouldSave) {
                    await saveConfig(`${keyPrefix}.backgroundColor`, rgba);
                }
            };

            backgroundColorPicker.addEventListener('input', () => updateBackgroundColor(false));
            backgroundColorPicker.addEventListener('change', () => updateBackgroundColor(true));

            backgroundOpacitySlider.addEventListener('input', async (e) => {
                const opacity = parseFloat(e.target.value);
                backgroundOpacityValue.textContent = opacity.toFixed(2);
                await updateBackgroundColor(true);
            });
        }
    }

    // 重置樣式為預設值
    async resetStyles() {
        if (!confirm('確定要重置所有樣式設定嗎？')) {
            return;
        }

        const defaultStyleConfig = {
            'subtitle.dualModeEnabled': DEFAULT_CONFIG['subtitle.dualModeEnabled'],
            'subtitle.primaryLanguage': DEFAULT_CONFIG['subtitle.primaryLanguage'],
            'subtitle.secondaryLanguage': DEFAULT_CONFIG['subtitle.secondaryLanguage'],
            'subtitle.style.primary.fontSize': DEFAULT_CONFIG['subtitle.style.primary.fontSize'],
            'subtitle.style.primary.textColor': DEFAULT_CONFIG['subtitle.style.primary.textColor'],
            'subtitle.style.primary.backgroundColor': DEFAULT_CONFIG['subtitle.style.primary.backgroundColor'],
            'subtitle.style.secondary.fontSize': DEFAULT_CONFIG['subtitle.style.secondary.fontSize'],
            'subtitle.style.secondary.textColor': DEFAULT_CONFIG['subtitle.style.secondary.textColor'],
            'subtitle.style.secondary.backgroundColor': DEFAULT_CONFIG['subtitle.style.secondary.backgroundColor']
        };

        await saveConfigMultiple(defaultStyleConfig);
        await this.restoreSubtitleUI();
        this.showSuccessMessage('樣式已重置為預設值');
        console.log('[Tutorial] 樣式已重置為預設值');
    }
}

// 初始化教學管理器
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing tutorial...');
    new TutorialManager();
});

// 防止意外關閉
window.addEventListener('beforeunload', (e) => {
    const tutorialCompleted = localStorage.getItem('subpal-tutorial-completed');
    if (!tutorialCompleted) {
        e.preventDefault();
        return '您確定要離開教學頁面嗎？';
    }
});
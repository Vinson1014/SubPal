// 教學頁面 JavaScript 邏輯

class TutorialManager {
    constructor() {
        this.currentStep = 1;
        this.totalSteps = 4;
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
        
        // 第四頁完成按鈕事件
        const step4NetflixBtn = document.getElementById('step4-netflix-btn');
        const step4CloseBtn = document.getElementById('step4-close-btn');
        
        if (step4NetflixBtn) {
            step4NetflixBtn.addEventListener('click', () => {
                console.log('[Tutorial] 第四頁開啟Netflix並關閉教學');
                // 先記錄教學完成狀態
                this.markTutorialCompleted();
                // 然後開啟Netflix並關閉教學
                window.open('https://netflix.com', '_blank');
                setTimeout(() => {
                    window.close();
                }, 500);
            });
        }
        
        if (step4CloseBtn) {
            step4CloseBtn.addEventListener('click', () => {
                console.log('[Tutorial] 第四頁關閉教學');
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
            3: [], // 第3步不使用高亮，改用箭頭指向真實位置
            4: []
        };
    }
    
    startTutorial() {
        this.goToStep(1);
    }
    
    goToStep(stepNumber) {
        console.log('切換到步驟:', stepNumber);
        
        if (stepNumber < 1 || stepNumber > this.totalSteps) return;
        
        // 清除之前的動畫和定時器
        this.clearAnimationTimeouts();
        this.clearAllHighlightTimers();
        this.hideHighlight();
        
        // 如果離開第三頁，清除箭頭和恭喜訊息，停止popup檢測
        if (this.currentStep === 3 && stepNumber !== 3) {
            const realArrow = document.getElementById('real-extension-arrow');
            if (realArrow) {
                realArrow.remove();
            }
            this.hideStep3Congratulation();
            this.stopPopupDetection();
        }
        
        // 如果回到第三頁且之前已經檢測過popup，重新顯示恭喜訊息
        if (stepNumber === 3 && this.popupDetected) {
            setTimeout(() => {
                this.showStep3Congratulation();
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
                // 重設瀏覽器演示
                this.resetBrowserDemo();
                // 顯示指向真實擴充功能按鈕位置的箭頭
                setTimeout(() => this.showExtensionGuideArrow(), 1000);
                // 開始檢測真實popup開啟
                this.startPopupDetection();
                break;
            case 4:
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
    
    // 顯示第三頁恭喜訊息
    showStep3Congratulation() {
        const congratulation = document.getElementById('step3-congratulation');
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
            //     this.hideStep3Congratulation();
            // }, 3000);
        }
    }
    
    // 隱藏第三頁恭喜訊息
    hideStep3Congratulation() {
        const congratulation = document.getElementById('step3-congratulation');
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
                this.showStep3Congratulation();
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
        if (this.popupDetected || this.currentStep !== 3) {
            return; // 避免重複觸發或不在第三步時觸發
        }
        
        this.popupDetected = true;
        
        // 保存到localStorage
        localStorage.setItem('subpal-tutorial-popup-detected', 'true');
        
        console.log('[Tutorial] Popup已開啟！顯示恭喜訊息');
        
        // 停止檢測
        this.stopPopupDetection();
        
        // 顯示恭喜訊息
        this.showStep3Congratulation();
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
    // 現在直接透過第四頁的按鈕執行相應動作
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
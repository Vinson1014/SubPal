# 錯誤事故專題索引

此目錄保存 [`../error_experience.md`](../error_experience.md) 防錯索引背後的完整事故脈絡。主索引用於每次必讀；只有遇到相關觸發條件或需要追查驗證證據時，才讀取下列專題。

## 既有 15 個事件落點

1. Queue 項目卡在 `syncing` 導致永遠不再重試 → [`queue-recovery-and-acknowledgement.md`](queue-recovery-and-acknowledgement.md)
2. Netflix 換片後自訂字幕樣式失效 → [`netflix-spa-ui-lifecycle.md`](netflix-spa-ui-lifecycle.md)
3. Phase 4 跨執行世界回歸與失效的瀏覽器驗證 → [`mv3-execution-world-and-live-evidence.md`](mv3-execution-world-and-live-evidence.md)
4. UIManager 在 Netflix SPA 換片後失去初始化狀態 → [`netflix-spa-ui-lifecycle.md`](netflix-spa-ui-lifecycle.md)
5. Phase 6/7 片尾任務 runtime 驗證與視覺 QA 教訓 → [`netflix-endscreen-lifecycle-and-visual-qa.md`](netflix-endscreen-lifecycle-and-visual-qa.md)
6. 權限與身份邊界誤判讓設定、隊列與字幕投影互相污染 → [`authority-identity-and-transport-contracts.md`](authority-identity-and-transport-contracts.md)
7. Type B countdown 轉 recommendation trailer 時任務卡消失 → [`netflix-endscreen-lifecycle-and-visual-qa.md`](netflix-endscreen-lifecycle-and-visual-qa.md)
8. 已顯示片尾任務卡被 inactive 訊號誤拆 → [`netflix-endscreen-lifecycle-and-visual-qa.md`](netflix-endscreen-lifecycle-and-visual-qa.md)
9. 換集事件早於 URL 與播放器 UI 恢復誤判 → [`netflix-endscreen-lifecycle-and-visual-qa.md`](netflix-endscreen-lifecycle-and-visual-qa.md)
10. 文件契約與提案邊界 → [`documentation-contracts.md`](documentation-contracts.md)
11. contribution-input 契約修補教訓 → [`authority-identity-and-transport-contracts.md`](authority-identity-and-transport-contracts.md)
12. contribution Port 同源漂移、stale worker 與非持久探針邊界 → [`authority-identity-and-transport-contracts.md`](authority-identity-and-transport-contracts.md)
13. 本地 queue 已持久化卻仍顯示 UI 假失敗 → [`queue-recovery-and-acknowledgement.md`](queue-recovery-and-acknowledgement.md)
14. 字幕 replacement fetch 因跨 world epoch 與片尾 owner 耦合失效 → [`subtitle-fetch-coordination.md`](subtitle-fetch-coordination.md)
15. 舊自訂端點遷移不可靜默改道 → [`authority-identity-and-transport-contracts.md`](authority-identity-and-transport-contracts.md)

每個專題均連回主索引及本頁，以維持雙向追溯。

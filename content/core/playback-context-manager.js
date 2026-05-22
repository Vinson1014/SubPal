/**
 * PlaybackContextManager
 *
 * 統一管理目前 Netflix 播放 session / videoId / track 狀態。
 * 目前先作為診斷與後續 gate 的狀態來源，不直接改變字幕顯示行為。
 */

import { sendMessageToPageScript, registerInternalEventHandler, dispatchInternalEvent } from '../system/messaging.js';

class PlaybackContextManager {
  constructor() {
    this.isInitialized = false;
    this.context = this.createInitialContext();
    this.debugEvents = [];
    this.maxDebugEvents = 50;
    this.pollInterval = null;
    this.pollIntervalMs = 3000;
  }

  createInitialContext() {
    return {
      epoch: 0,
      videoId: null,
      sessionId: null,
      currentTrack: null,
      state: 'transitioning',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      source: 'initial',
      snapshot: null,
      selectedSessionReason: null,
      sessionSelectionConfidence: 'none'
    };
  }

  async initialize() {
    if (this.isInitialized) {
      return true;
    }

    this.setupEventHandlers();
    await this.refreshContext('initialize');
    this.startPolling();
    this.isInitialized = true;
    return true;
  }

  setupEventHandlers() {
    registerInternalEventHandler('VIDEO_ID_CHANGED', (event) => {
      this.handleVideoChanged(event);
    });
  }

  startPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    this.pollInterval = setInterval(() => {
      this.refreshContext('poll').catch(error => {
        this.recordDebugEvent('REFRESH_FAILED', {
          reason: 'poll',
          error: error.message
        });
      });
    }, this.pollIntervalMs);
  }

  async handleVideoChanged(event) {
    const newVideoId = event.newVideoId || event.videoId || null;
    const oldVideoId = event.oldVideoId || this.context.videoId;

    this.context = {
      ...this.context,
      epoch: this.context.epoch + 1,
      videoId: newVideoId,
      state: 'transitioning',
      updatedAt: Date.now(),
      source: 'VIDEO_ID_CHANGED'
    };

    this.recordDebugEvent('VIDEO_ID_CHANGED', {
      oldVideoId,
      newVideoId,
      epoch: this.context.epoch
    });

    this.dispatchContextChanged('VIDEO_ID_CHANGED');

    // Netflix SPA 切換時 player session 可能稍晚才 ready，延遲刷新一次。
    setTimeout(() => {
      this.refreshContext('video-change-delay').catch(error => {
        this.recordDebugEvent('REFRESH_FAILED', {
          reason: 'video-change-delay',
          error: error.message
        });
      });
    }, 1000);
  }

  async refreshContext(reason = 'manual') {
    const response = await sendMessageToPageScript({
      type: 'GET_SUBPAL_DEBUG_SNAPSHOT'
    });

    const playback = response?.debugSnapshot?.playback || null;
    const nextContext = this.deriveContextFromPlayback(playback, reason);
    const changed = this.hasContextChanged(this.context, nextContext);

    if (changed) {
      const shouldAdvanceEpoch =
        this.context.videoId !== nextContext.videoId ||
        this.context.sessionId !== nextContext.sessionId;

      nextContext.epoch = shouldAdvanceEpoch ? this.context.epoch + 1 : this.context.epoch;
      nextContext.startedAt = shouldAdvanceEpoch ? Date.now() : this.context.startedAt;
      this.context = nextContext;

      this.recordDebugEvent('CONTEXT_REFRESHED', {
        reason,
        epoch: this.context.epoch,
        videoId: this.context.videoId,
        sessionId: this.context.sessionId,
        state: this.context.state,
        selectedSessionReason: this.context.selectedSessionReason,
        sessionSelectionConfidence: this.context.sessionSelectionConfidence,
        currentTrack: this.context.currentTrack
      });

      this.dispatchContextChanged(reason);
    } else {
      this.context = {
        ...this.context,
        snapshot: playback,
        updatedAt: Date.now(),
        source: reason
      };
    }

    return this.context;
  }

  deriveContextFromPlayback(playback, source) {
    const selectedSessionId = playback?.selectedSessionId || playback?.sessionId || null;
    const selectedSessionIdString = selectedSessionId ? String(selectedSessionId) : null;
    const selectedSessionReason = playback?.selectedSessionReason || null;
    const sessionSelectionConfidence = playback?.sessionSelectionConfidence || 'none';
    const hasTrustedWatchSession =
      selectedSessionIdString &&
      selectedSessionIdString.startsWith('watch-') &&
      ['high', 'medium'].includes(sessionSelectionConfidence) &&
      selectedSessionReason !== 'player-helper-session-fallback' &&
      selectedSessionReason !== 'first-open-session-fallback';

    const activeVideoId = playback?.playerApiVideoId ||
      playback?.movieId ||
      playback?.pageUrlVideoId ||
      null;

    const currentTrack = playback?.currentTrack ? {
      code: playback.currentTrack.code || null,
      name: playback.currentTrack.name || null,
      trackId: playback.currentTrack.trackId || null,
      trackType: playback.currentTrack.trackType || null,
      rawTrackType: playback.currentTrack.rawTrackType || null
    } : null;

    return {
      epoch: this.context.epoch,
      videoId: activeVideoId ? String(activeVideoId) : null,
      sessionId: selectedSessionIdString,
      currentTrack,
      state: activeVideoId && hasTrustedWatchSession ? 'ready' : 'transitioning',
      startedAt: this.context.startedAt,
      updatedAt: Date.now(),
      source,
      snapshot: playback,
      selectedSessionReason,
      sessionSelectionConfidence
    };
  }

  hasContextChanged(current, next) {
    return (
      current.videoId !== next.videoId ||
      current.sessionId !== next.sessionId ||
      current.state !== next.state ||
      current.selectedSessionReason !== next.selectedSessionReason ||
      current.sessionSelectionConfidence !== next.sessionSelectionConfidence ||
      this.getTrackKey(current.currentTrack) !== this.getTrackKey(next.currentTrack)
    );
  }

  getTrackKey(track) {
    if (!track) return '';
    return [
      track.code || '',
      track.trackId || '',
      track.trackType || '',
      track.rawTrackType || ''
    ].join('|');
  }

  dispatchContextChanged(reason) {
    dispatchInternalEvent({
      type: 'PLAYBACK_CONTEXT_CHANGED',
      reason,
      context: this.getCurrentContext()
    });
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

  getCurrentContext() {
    return {
      ...this.context,
      currentTrack: this.context.currentTrack ? { ...this.context.currentTrack } : null
    };
  }

  isCurrentEpoch(epoch) {
    return this.context.epoch === epoch;
  }

  getStatus() {
    return {
      isInitialized: this.isInitialized,
      context: this.getCurrentContext(),
      recentEvents: this.debugEvents.slice(-20)
    };
  }

  cleanup() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.isInitialized = false;
  }
}

const playbackContextManager = new PlaybackContextManager();

export { PlaybackContextManager, playbackContextManager };

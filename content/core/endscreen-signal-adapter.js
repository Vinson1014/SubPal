const INACTIVE_DEBOUNCE_MS = 500;

class EndscreenSignalAdapter {
  constructor({ document, Observer, schedule, cancel, getContext, controller, onInactive }) {
    if (!document || typeof Observer !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function' || typeof getContext !== 'function' ||
      typeof controller?.observe !== 'function' || typeof controller.dismiss !== 'function' ||
      (onInactive !== undefined && typeof onInactive !== 'function')) {
      throw new TypeError('EndscreenSignalAdapter requires injected dependencies');
    }

    this.document = document;
    this.Observer = Observer;
    this.schedule = schedule;
    this.cancel = cancel;
    this.getContext = getContext;
    this.controller = controller;
    this.onInactive = onInactive ?? (() => {});
    this.observer = null;
    this.mediaListeners = new Map();
    this.pendingJob = null;
    this.pendingInactiveJob = null;
    this.started = false;
    this.onMediaSignal = () => this.queueObservation();
    this.onDocumentClick = (event) => this.forwardDismissal(event);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.document.addEventListener('click', this.onDocumentClick);
    this.observer = new this.Observer(() => this.queueObservation());
    this.observer.observe(this.document, { childList: true, subtree: true, attributes: true });
    this.refreshMediaListeners();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.document.removeEventListener('click', this.onDocumentClick);
    this.observer.disconnect();
    this.observer = null;
    if (this.pendingJob !== null) this.cancel(this.pendingJob);
    this.pendingJob = null;
    if (this.pendingInactiveJob !== null) this.cancel(this.pendingInactiveJob);
    this.pendingInactiveJob = null;
    for (const [media, listeners] of this.mediaListeners) {
      for (const type of listeners) media.removeEventListener(type, this.onMediaSignal);
    }
    this.mediaListeners.clear();
  }

  queueObservation() {
    if (!this.started || this.pendingJob !== null) return;
    this.pendingJob = this.schedule(() => {
      this.pendingJob = null;
      if (!this.started) return;
      this.refreshMediaListeners();
      const candidate = this.getCandidate();
      if (candidate) {
        if (this.pendingInactiveJob !== null) this.cancel(this.pendingInactiveJob);
        this.pendingInactiveJob = null;
        this.controller.observe(candidate.observation);
      } else if (this.pendingInactiveJob === null) {
        this.pendingInactiveJob = this.schedule(() => {
          this.pendingInactiveJob = null;
          if (!this.started) return;
          this.refreshMediaListeners();
          const confirmedCandidate = this.getCandidate();
          if (confirmedCandidate) {
            this.controller.observe(confirmedCandidate.observation);
            return;
          }
          if (this.getRecommendationShell(null)) return;
          this.onInactive();
        }, INACTIVE_DEBOUNCE_MS);
      }
    });
  }

  refreshMediaListeners() {
    const mediaNodes = new Set(this.document.querySelectorAll('video'));
    for (const [media, listeners] of this.mediaListeners) {
      if (mediaNodes.has(media)) continue;
      for (const type of listeners) media.removeEventListener(type, this.onMediaSignal);
      this.mediaListeners.delete(media);
    }
    for (const media of mediaNodes) {
      if (this.mediaListeners.has(media)) continue;
      const listeners = ['ended', 'pause', 'play', 'timeupdate'];
      for (const type of listeners) media.addEventListener(type, this.onMediaSignal);
      this.mediaListeners.set(media, listeners);
    }
  }

  forwardDismissal(event) {
    if (!this.started) return;
    const candidate = this.getCandidate();
    if (candidate?.actionMarker.contains(event.target)) this.controller.dismiss(candidate.observation.context);
  }

  getCandidate() {
    const context = this.getContext();
    if (!this.isTrustedContext(context)) return null;

    const media = this.onlyConnected(this.document.querySelectorAll('video'));
    if (!media || media.readyState !== 4 || !this.hasFiniteTimeline(media)) return null;

    if (media.ended) return null;
    const watchCreditsCta = this.onlyLive(this.document.querySelectorAll('[data-uia="watch-credits-seamless-button"]'));
    const nextEpisodeCta = this.onlyLive(this.document.querySelectorAll('[data-uia="next-episode-seamless-button"]'));
    const state2Root = !media.paused && watchCreditsCta && nextEpisodeCta && this.sharedPlayerOwner(media, [watchCreditsCta, nextEpisodeCta]);
    if (state2Root) {
      return {
        root: state2Root,
        actionMarker: nextEpisodeCta,
        observation: {
          context,
          snapshot: { currentTime: media.currentTime, duration: media.duration, state: 'playing' },
          variant: 'state-2-credits',
          evidence: { watchCreditsCta: true, nextEpisodeCta: true }
        }
      };
    }

    const recommendationShell = this.getRecommendationShell(media);
    if (!recommendationShell) return null;
    const { root, markers } = recommendationShell;
    return {
      root,
      actionMarker: markers[2],
      observation: {
        context,
        snapshot: { currentTime: media.currentTime, duration: media.duration, state: media.paused ? 'paused' : 'playing' },
        variant: 'recommendation-preview',
        evidence: { promotedPreview: true }
      }
    };
  }

  onlyLive(nodes) {
    const candidates = Array.from(nodes).filter((node) => this.isLive(node));
    return candidates.length === 1 ? candidates[0] : null;
  }

  onlyConnected(nodes) {
    const candidates = Array.from(nodes).filter((node) => node?.isConnected);
    return candidates.length === 1 ? candidates[0] : null;
  }

  getRecommendationShell(media) {
    const markers = [
      this.onlyLive(this.document.querySelectorAll('[data-uia="background-video-container"]')),
      this.onlyLive(this.document.querySelectorAll('[data-uia="promoted-video"]')),
      this.onlyLive(this.document.querySelectorAll('[data-uia="postplay-background-play"]'))
    ];
    if (markers.includes(null)) return null;
    const root = this.sharedWatchVideoOwner(media, markers);
    return root ? { root, markers } : null;
  }

  isLive(node) {
    if (!node?.isConnected || node.visible === false || node.hidden) return false;
    if (typeof node.getClientRects !== 'function') return true;
    if (node.getClientRects().length === 0) return false;
    for (let current = node; current && current !== this.document; current = current.parentNode) {
      if (current.hidden) return false;
      const style = this.document.defaultView?.getComputedStyle?.(current);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || Number(style?.opacity) === 0) return false;
    }
    return true;
  }

  hasFiniteTimeline(media) {
    return Number.isFinite(media.currentTime) && Number.isFinite(media.duration) && media.duration > 0 && media.currentTime >= 0;
  }

  sharedWatchVideoOwner(media, markers) {
    const watchVideoRoots = Array.from(this.document.querySelectorAll('[data-uia="watch-video"]')).filter((candidate) =>
      this.isLive(candidate) &&
      (!media || candidate.contains(media)) &&
      markers.every((marker) => candidate.contains(marker))
    );
    return watchVideoRoots.length === 1 ? watchVideoRoots[0] : null;
  }

  sharedPlayerOwner(media, markers) {
    const playerRoots = Array.from(this.document.querySelectorAll('[data-uia="player"]')).filter((candidate) =>
      candidate !== this.document &&
      this.isLive(candidate) &&
      candidate.contains(media) &&
      markers.every((marker) => candidate.contains(marker))
    );
    return playerRoots.length === 1 ? playerRoots[0] : null;
  }

  isTrustedContext(context) {
    return context?.state === 'ready' &&
      typeof context.videoId === 'string' && context.videoId.length > 0 &&
      typeof context.sessionId === 'string' && context.sessionId.startsWith('watch-') &&
      Number.isInteger(context.epoch) && context.epoch >= 0;
  }
}

export { EndscreenSignalAdapter };

class EndscreenSignalAdapter {
  constructor({ document, Observer, schedule, cancel, getContext, controller }) {
    if (!document || typeof Observer !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function' || typeof getContext !== 'function' ||
      typeof controller?.observe !== 'function' || typeof controller.dismiss !== 'function') {
      throw new TypeError('EndscreenSignalAdapter requires injected dependencies');
    }

    this.document = document;
    this.Observer = Observer;
    this.schedule = schedule;
    this.cancel = cancel;
    this.getContext = getContext;
    this.controller = controller;
    this.observer = null;
    this.mediaListeners = new Map();
    this.pendingJob = null;
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
      if (candidate) this.controller.observe(candidate.observation);
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

    const media = this.onlyLive(this.document.querySelectorAll('video'));
    if (!media || media.readyState !== 4 || !this.hasFiniteTimeline(media)) return null;

    if (media.ended || media.paused) return null;
    const watchCreditsCta = this.onlyLive(this.document.querySelectorAll('[data-uia="watch-credits-seamless-button"]'));
    const nextEpisodeCta = this.onlyLive(this.document.querySelectorAll('[data-uia="next-episode-seamless-button"]'));
    const state2Root = watchCreditsCta && nextEpisodeCta && this.sharedPlayerOwner(media, [watchCreditsCta, nextEpisodeCta]);
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

    const markers = [
      this.onlyLive(this.document.querySelectorAll('[data-uia="background-video"]')),
      this.onlyLive(this.document.querySelectorAll('[data-uia="promoted-video"]')),
      this.onlyLive(this.document.querySelectorAll('[data-uia="postplay-background-play"]'))
    ];
    if (markers.includes(null)) return null;
    const root = this.sharedOwner(media, markers);
    if (!root) return null;
    return {
      root,
      actionMarker: markers[2],
      observation: {
        context,
        snapshot: { currentTime: media.currentTime, duration: media.duration, state: 'playing' },
        variant: 'recommendation-preview',
        evidence: { promotedPreview: true }
      }
    };
  }

  onlyLive(nodes) {
    const candidates = Array.from(nodes).filter((node) => this.isLive(node));
    return candidates.length === 1 ? candidates[0] : null;
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

  sharedOwner(media, markers) {
    const root = media.parentNode;
    if (!root || root === this.document || !this.isLive(root)) return null;
    if (markers.every((marker) => marker.parentNode === root)) return root;

    const playerRoots = [];
    for (let candidate = root.parentNode; candidate && candidate !== this.document; candidate = candidate.parentNode) {
      if (candidate.dataset?.uia === 'player' && this.isLive(candidate) && markers.every((marker) => candidate.contains(marker))) {
        playerRoots.push(candidate);
      }
    }
    return playerRoots.length === 1 ? playerRoots[0] : null;
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

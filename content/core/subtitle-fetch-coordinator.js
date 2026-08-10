import { buildSlotKey } from '../utils/slot-key.js';

const FETCH_DURATION_SECONDS = 180;
const PREFETCH_THRESHOLD_SECONDS = 60;
const PLAYBACK_TICK_MS = 15_000;
const SEEK_DEBOUNCE_MS = 250;
const MAX_IN_FLIGHT = 2;
const MAX_BATCH_SIZE = 1_000;
const MAX_SUBTITLE_TEXT_LENGTH = 10_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000];

function failure(kind, code, retryable = false) {
  return { ok: false, error: { kind, code, retryable } };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContext(context) {
  if (!isRecord(context) || context.state !== 'ready' ||
      typeof context.videoId !== 'string' || !context.videoId ||
      typeof context.sessionId !== 'string' || !context.sessionId.startsWith('watch-') ||
      !Number.isInteger(context.epoch) || context.epoch < 0) {
    return null;
  }
  return {
    videoId: context.videoId,
    sessionId: context.sessionId,
    localEpoch: context.epoch
  };
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function validateOptionalFields(item) {
  const nullableStrings = ['translationID', 'contributorUserID', 'slotKeySource', 'clientVersion', 'status'];
  if (nullableStrings.some((key) =>
    item[key] !== undefined && item[key] !== null && typeof item[key] !== 'string')) {
    return false;
  }
  if (item.myVote !== undefined && item.myVote !== null && typeof item.myVote !== 'string') {
    return false;
  }
  return ['upvotes', 'downvotes'].every((key) =>
    item[key] === undefined || (typeof item[key] === 'number' && Number.isFinite(item[key])));
}

function validateSubtitleBatch(items, request) {
  if (!Array.isArray(items) || items.length > MAX_BATCH_SIZE) {
    return failure('invalid', 'subtitle-response-invalid', false);
  }

  const normalized = [];
  for (const item of items) {
    if (!isRecord(item) || item.videoID !== request.videoId ||
        !Number.isFinite(item.timestamp) || item.timestamp < request.start || item.timestamp >= request.end ||
        typeof item.originalSubtitle !== 'string' || !item.originalSubtitle.trim() ||
        item.originalSubtitle.length > MAX_SUBTITLE_TEXT_LENGTH ||
        typeof item.suggestedSubtitle !== 'string' ||
        item.suggestedSubtitle.length > MAX_SUBTITLE_TEXT_LENGTH ||
        typeof item.languageCode !== 'string' || !item.languageCode.trim() ||
        typeof item.slotKey !== 'string' || !item.slotKey ||
        !validateOptionalFields(item)) {
      return failure('invalid', 'subtitle-response-invalid', false);
    }

    const canonicalSlotKey = buildSlotKey({
      videoID: item.videoID,
      originalSubtitle: item.originalSubtitle,
      languageCode: item.languageCode,
      timestamp: item.timestamp
    });
    if (!canonicalSlotKey || item.slotKey !== canonicalSlotKey) {
      return failure('invalid', 'subtitle-response-invalid', false);
    }
    normalized.push({ ...item, slotKey: canonicalSlotKey });
  }

  return { ok: true, value: normalized };
}

class SubtitleFetchCoordinator {
  constructor({
    query,
    getCurrentTime = () => NaN,
    onSnapshot = async () => {},
    onRequest = () => {},
    onLog = () => {},
    clock = () => Date.now(),
    setTimeoutFn = (...args) => globalThis.setTimeout(...args),
    clearTimeoutFn = (id) => globalThis.clearTimeout(id),
    setIntervalFn = (...args) => globalThis.setInterval(...args),
    clearIntervalFn = (id) => globalThis.clearInterval(id)
  }) {
    this.query = query;
    this.getCurrentTime = getCurrentTime;
    this.onSnapshot = onSnapshot;
    this.onRequest = onRequest;
    this.onLog = onLog;
    this.clock = clock;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;

    this.cache = new Map();
    this.intervals = [];
    this.failures = new Map();
    this.inFlight = new Map();
    this.pendingDemand = null;
    this.context = null;
    this.scopeKey = null;
    this.sourceGeneration = 0;
    this.sequence = 0;
    this.playbackTimer = null;
    this.seekTimer = null;
    this.lastKnownTime = NaN;
  }

  activateContext(context, sourceGeneration = this.sourceGeneration) {
    const normalized = normalizeContext(context);
    if (!normalized || !Number.isInteger(sourceGeneration) || sourceGeneration < 0) {
      return false;
    }
    const nextScopeKey = [
      normalized.videoId,
      normalized.sessionId,
      normalized.localEpoch,
      sourceGeneration
    ].join('|');
    if (nextScopeKey === this.scopeKey) return true;

    this.settlePending(failure('stale-context', 'subtitle-query-stale-context', false));
    this.cache.clear();
    this.intervals = [];
    this.failures.clear();
    this.inFlight.clear();
    this.context = normalized;
    this.scopeKey = nextScopeKey;
    this.sourceGeneration = sourceGeneration;
    return true;
  }

  ensureCoverage(currentTime, { reason = 'subtitle-demand' } = {}) {
    const timestamp = Number(currentTime);
    this.lastKnownTime = timestamp;
    if (!this.context || !Number.isFinite(timestamp) || timestamp < 0) {
      return Promise.resolve(failure('stale-context', 'subtitle-query-stale-context', false));
    }

    const coverageEnd = this.getContinuousCoverageEnd(timestamp);
    if (coverageEnd <= timestamp) {
      return this.requestAt(this.failedRangeStartFor(timestamp) ?? timestamp, { reason });
    }
    if (coverageEnd - timestamp < PREFETCH_THRESHOLD_SECONDS) {
      return this.requestAt(coverageEnd, {
        reason: 'prefetch',
        isPrefetch: true
      });
    }
    return Promise.resolve({ ok: true, value: { coveredUntil: coverageEnd, fetched: false } });
  }

  forceRefreshAt(currentTime, options = {}) {
    const timestamp = Number(currentTime);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      return Promise.resolve(failure('invalid', 'subtitle-query', false));
    }
    return this.requestAt(timestamp, {
      ...options,
      force: true,
      reason: options.reason || 'force-refresh'
    });
  }

  invalidateAt(currentTime) {
    const timestamp = Number(currentTime);
    if (!Number.isFinite(timestamp)) return 0;
    const previousCount = this.intervals.length;
    this.intervals = this.intervals.filter((interval) =>
      interval.status === 'in-progress' ||
      timestamp < interval.start || timestamp >= interval.end);
    for (const [start, state] of this.failures) {
      if (timestamp >= state.start && timestamp < state.end) this.failures.delete(start);
    }
    return previousCount - this.intervals.length;
  }

  getReplacement(slotKey) {
    return typeof slotKey === 'string' ? this.cache.get(slotKey) ?? null : null;
  }

  handlePlayerState(state, currentTime) {
    if (state === 'play') {
      this.clearPlaybackTimer();
      void this.ensureCoverage(currentTime, { reason: 'play' });
      this.playbackTimer = this.setIntervalFn(() => {
        const observedTime = Number(this.getCurrentTime());
        const timestamp = Number.isFinite(observedTime) ? observedTime : this.lastKnownTime;
        void this.ensureCoverage(timestamp, { reason: 'tick' });
      }, PLAYBACK_TICK_MS);
      return;
    }
    if (state === 'pause') {
      this.clearPlaybackTimer();
      return;
    }
    if (state === 'seeked') {
      this.lastKnownTime = Number(currentTime);
      if (this.seekTimer !== null) this.clearTimeoutFn(this.seekTimer);
      this.seekTimer = this.setTimeoutFn(() => {
        this.seekTimer = null;
        void this.ensureCoverage(this.lastKnownTime, { reason: 'seeked' });
      }, SEEK_DEBOUNCE_MS);
    }
  }

  getContinuousCoverageEnd(currentTime) {
    let cursor = currentTime;
    const active = this.intervals
      .filter((interval) => interval.status === 'in-progress' || interval.status === 'completed')
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let extended = true;
    while (extended) {
      extended = false;
      for (const interval of active) {
        if (interval.start <= cursor && interval.end > cursor) {
          cursor = interval.end;
          extended = true;
        }
      }
    }
    return cursor;
  }

  failedRangeStartFor(timestamp) {
    const failures = this.intervals
      .filter((interval) => interval.status === 'failed' &&
        timestamp >= interval.start && timestamp < interval.end)
      .sort((left, right) => right.sequence - left.sequence);
    return failures[0]?.start ?? null;
  }

  requestAt(startTimestamp, options = {}) {
    const start = Number(startTimestamp);
    if (!this.context || !Number.isFinite(start) || start < 0) {
      return Promise.resolve(failure('stale-context', 'subtitle-query-stale-context', false));
    }
    const request = {
      videoId: this.context.videoId,
      start,
      end: start + FETCH_DURATION_SECONDS,
      reason: options.reason || 'subtitle-demand',
      force: options.force === true,
      isPrefetch: options.isPrefetch === true,
      requestStartedAt: Number.isFinite(options.requestStartedAt) ? options.requestStartedAt : this.clock(),
      reconciliationItemId: typeof options.reconciliationItemId === 'string' ? options.reconciliationItemId : null,
      scopeKey: this.scopeKey
    };

    if (!request.force && this.intervals.some((interval) =>
      (interval.status === 'in-progress' || interval.status === 'completed') &&
      interval.start <= request.start && interval.end >= request.end)) {
      return Promise.resolve({ ok: true, value: { coveredUntil: request.end, fetched: false } });
    }

    const failureState = this.failures.get(request.start);
    if (!request.force && failureState) {
      if (failureState.suppressed || this.clock() < failureState.nextEligibleAt) {
        return Promise.resolve(failure('domain-rejected', 'subtitle-fetch-cooldown', false));
      }
    }

    if (this.inFlight.size >= MAX_IN_FLIGHT) {
      if (request.isPrefetch) {
        return Promise.resolve(failure('domain-rejected', 'subtitle-prefetch-dropped', true));
      }
      return new Promise((resolve) => {
        this.settlePending(failure('cancelled', 'subtitle-demand-superseded', false));
        this.pendingDemand = { request, resolve };
      });
    }
    return this.startRequest(request);
  }

  async startRequest(request) {
    const sequence = ++this.sequence;
    const requestId = `subtitle-fetch-${sequence}`;
    const interval = {
      start: request.start,
      end: request.end,
      status: 'in-progress',
      timestamp: this.clock(),
      sequence,
      requestId,
      reason: request.reason,
      scopeKey: request.scopeKey
    };
    this.intervals.push(interval);
    this.inFlight.set(sequence, interval);
    try {
      this.onRequest({ requestId, reason: request.reason, start: request.start, end: request.end });
    } catch {
      // 統計 callback 不得影響 fetch state machine。
    }
    this.safeLog({ requestId, reason: request.reason, range: [request.start, request.end], resultCode: 'started' });

    let result;
    try {
      result = await this.query({
        videoId: request.videoId,
        timestamp: request.start,
        duration: FETCH_DURATION_SECONDS
      });
    } catch {
      result = failure('domain-rejected', 'subtitle-fetch-failed', true);
    }

    try {
      if (request.scopeKey !== this.scopeKey) {
        interval.status = 'stale';
        return failure('stale-context', 'subtitle-query-stale-context', false);
      }

      if (result?.ok === true) {
        const validated = validateSubtitleBatch(result.value?.subtitles, request);
        if (!validated.ok) {
          this.recordFailure(interval, validated.error);
          return validated;
        }
        const newerOverlapExists = this.intervals.some((candidate) =>
          candidate.sequence > sequence && rangesOverlap(candidate, interval));
        if (newerOverlapExists) {
          interval.status = 'superseded';
          return failure('stale-context', 'subtitle-response-superseded', false);
        }

        for (const [slotKey, cached] of this.cache) {
          if (Number.isFinite(cached.timestamp) &&
              cached.timestamp >= request.start && cached.timestamp < request.end) {
            this.cache.delete(slotKey);
          }
        }
        for (const item of validated.value) {
          this.cache.set(item.slotKey, { ...item, cacheTime: this.clock() });
        }
        try {
          await this.onSnapshot(validated.value, {
            start: request.start,
            end: request.end,
            requestStartedAt: request.requestStartedAt,
            reconciliationItemId: request.reconciliationItemId
          });
        } catch {
          // 本地 reconciliation callback 不得推翻已驗證的權威快照。
        }
        interval.status = 'completed';
        this.failures.delete(request.start);
        this.safeLog({
          requestId,
          reason: request.reason,
          range: [request.start, request.end],
          resultCode: 'ok',
          cacheCount: this.cache.size
        });
        return { ok: true, value: { subtitles: validated.value } };
      }

      const error = isRecord(result?.error)
        ? result.error
        : { kind: 'domain-rejected', code: 'subtitle-fetch-failed', retryable: false };
      if (error.kind === 'stale-context') {
        interval.status = 'stale';
      } else {
        this.recordFailure(interval, error);
      }
      this.safeLog({
        requestId,
        reason: request.reason,
        range: [request.start, request.end],
        resultCode: error.code
      });
      return failure(error.kind, error.code, error.retryable === true);
    } finally {
      this.inFlight.delete(sequence);
      this.drainPending();
    }
  }

  recordFailure(interval, error) {
    interval.status = 'failed';
    const previous = this.failures.get(interval.start);
    if (error.retryable === true) {
      const attemptIndex = Math.min((previous?.attemptIndex ?? -1) + 1, RETRY_DELAYS_MS.length - 1);
      this.failures.set(interval.start, {
        start: interval.start,
        end: interval.end,
        attemptIndex,
        nextEligibleAt: this.clock() + RETRY_DELAYS_MS[attemptIndex],
        suppressed: false
      });
      return;
    }
    this.failures.set(interval.start, {
      start: interval.start,
      end: interval.end,
      attemptIndex: previous?.attemptIndex ?? 0,
      nextEligibleAt: Infinity,
      suppressed: true
    });
  }

  drainPending() {
    if (!this.pendingDemand || this.inFlight.size >= MAX_IN_FLIGHT) return;
    const pending = this.pendingDemand;
    this.pendingDemand = null;
    this.startRequest(pending.request).then(pending.resolve);
  }

  settlePending(result) {
    if (!this.pendingDemand) return;
    const pending = this.pendingDemand;
    this.pendingDemand = null;
    pending.resolve(result);
  }

  safeLog(entry) {
    try {
      this.onLog({
        requestId: entry.requestId,
        reason: entry.reason,
        range: entry.range,
        contextEpoch: this.context?.localEpoch ?? null,
        duration: FETCH_DURATION_SECONDS,
        resultCode: entry.resultCode,
        cacheCount: entry.cacheCount ?? this.cache.size
      });
    } catch {
      // 診斷輸出不得影響 fetch state machine。
    }
  }

  clearPlaybackTimer() {
    if (this.playbackTimer === null) return;
    this.clearIntervalFn(this.playbackTimer);
    this.playbackTimer = null;
  }

  cleanup() {
    this.clearPlaybackTimer();
    if (this.seekTimer !== null) {
      this.clearTimeoutFn(this.seekTimer);
      this.seekTimer = null;
    }
    this.settlePending(failure('cancelled', 'subtitle-query-cancelled', false));
    this.cache.clear();
    this.intervals = [];
    this.failures.clear();
    this.inFlight.clear();
    this.context = null;
    this.scopeKey = null;
  }
}

export {
  FETCH_DURATION_SECONDS,
  MAX_BATCH_SIZE,
  MAX_SUBTITLE_TEXT_LENGTH,
  PLAYBACK_TICK_MS,
  PREFETCH_THRESHOLD_SECONDS,
  RETRY_DELAYS_MS,
  SEEK_DEBOUNCE_MS,
  SubtitleFetchCoordinator,
  validateSubtitleBatch
};

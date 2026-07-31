import { fail, isResult, ok } from './result.js';
import { createDomTransport, createEnvelope } from './private-transports.js';

const CAPABILITY_DEADLINE_MS = 30_000;
const SUBTITLE_QUERY_CATEGORY = 'subtitle-query';
const REPLACEMENT_SUBTITLE_QUERY_VARIANT = 'replacement-subtitle-query';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameContext(left, right) {
  return isRecord(left) && isRecord(right) &&
    left.videoId === right.videoId &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch;
}

function normalizeResponse(response) {
  if (!isResult(response)) return fail('domain-rejected', 'subtitle-fetch-failed', false);
  if (response.ok) {
    return Array.isArray(response.value?.subtitles)
      ? ok({ subtitles: response.value.subtitles })
      : fail('domain-rejected', 'subtitle-fetch-failed', false);
  }
  switch (response.error.kind) {
    case 'timeout':
      return fail('timeout', 'subtitles-query-timeout', true);
    case 'disconnected':
      return fail('disconnected', 'background-port-disconnected', true);
    case 'cancelled':
      return fail('cancelled', 'subtitle-query-cancelled', false);
    case 'stale-context':
      return fail('stale-context', 'subtitle-query-stale-context', false);
    default:
      return fail('domain-rejected', 'subtitle-fetch-failed', false);
  }
}

export function parseSubtitleQuery(input) {
  if (!isRecord(input) || Object.keys(input).length !== 4 ||
    typeof input.videoId !== 'string' || !input.videoId ||
    !Number.isFinite(input.timestamp) || input.timestamp < 0 || input.duration !== 180 || !isRecord(input.context) ||
    Object.keys(input.context).length !== 3 || input.context.videoId !== input.videoId ||
    typeof input.context.sessionId !== 'string' || !input.context.sessionId ||
    !Number.isInteger(input.context.epoch) || input.context.epoch < 0) {
    return fail('invalid', 'subtitle-query', false);
  }
  return ok(input);
}

export function createSubtitles({ getCurrentContext, request, createRequestId = () => crypto.randomUUID(), setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  return Object.freeze({
    query(input, cancellation) {
      const parsed = parseSubtitleQuery(input);
      if (!parsed.ok) return Promise.resolve(parsed);
      const snapshot = getCurrentContext();
      if (!sameContext(parsed.value.context, snapshot)) {
        return Promise.resolve(fail('stale-context', 'subtitle-query-stale-context', false));
      }
      const callerSignal = cancellation?.signal ?? cancellation;
      return new Promise((resolve) => {
        const controller = new AbortController();
        let settled = false;
        let timerId;
        const cleanup = () => {
          clearTimeout(timerId);
          callerSignal?.removeEventListener?.('abort', cancel);
        };
        const settle = (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const cancel = () => {
          settle(fail('cancelled', 'subtitle-query-cancelled', false));
          controller.abort();
        };
        timerId = setTimeout(() => {
          settle(fail('timeout', 'subtitles-query-timeout', true));
          controller.abort();
        }, CAPABILITY_DEADLINE_MS);
        callerSignal?.addEventListener?.('abort', cancel, { once: true });
        if (callerSignal?.aborted) {
          cancel();
          return;
        }
        let requestResult;
        try {
          requestResult = request({
            requestId: createRequestId(),
            query: parsed.value,
            deadlineMs: CAPABILITY_DEADLINE_MS,
            signal: controller.signal
          });
        } catch (error) {
          void error;
          settle(fail('domain-rejected', 'subtitle-fetch-failed', false));
          return;
        }
        Promise.resolve(requestResult).then((response) => {
          if (!sameContext(snapshot, getCurrentContext())) {
            settle(fail('stale-context', 'subtitle-query-stale-context', false));
            return;
          }
          settle(normalizeResponse(response));
        }, () => settle(fail('domain-rejected', 'subtitle-fetch-failed', false)));
      });
    }
  });
}

export function createPageSubtitles({ window, getCurrentContext, createRequestId, setTimeout, clearTimeout }) {
  const transport = createDomTransport({
    window,
    makeEvent: (type, detail) => new CustomEvent(type, { detail }),
    setTimeout,
    clearTimeout
  });
  return createSubtitles({
    getCurrentContext,
    createRequestId,
    setTimeout,
    clearTimeout,
    request({ requestId, query, deadlineMs, signal }) {
      const payload = {
        category: SUBTITLE_QUERY_CATEGORY,
        variant: REPLACEMENT_SUBTITLE_QUERY_VARIANT,
        payload: query
      };
      return transport.request(createEnvelope({
        requestId,
        kind: 'subtitle-query',
        payload
      }), {
        deadlineMs,
        signal,
        wire: { messageId: requestId, message: payload }
      });
    }
  });
}

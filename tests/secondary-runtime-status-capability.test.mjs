import assert from 'node:assert/strict';
import { test } from 'node:test';

const context = (videoId = '801', epoch = 1) => ({ videoId, sessionId: `watch-${videoId}`, epoch });
const snapshot = (videoId = '801') => ({ videoId, effectiveLanguage: 'ja', quality: { isCC: true, degraded: true },
  status: 'ready', reason: 'same-primary-track', isManualFallback: false, updatedAt: 100 });
const request = (videoId = '801', epoch = 1, sequence = 1) => ({ category: 'secondary-runtime-status', variant: 'publish',
  payload: { context: context(videoId, epoch), sequence, snapshot: snapshot(videoId) } });

test('runtime publisher capability rejects extra authority, accessors and non-cloneable requests before any storage write', async () => {
  const { parseSecondaryRuntimeStatusRequest, createSecondaryRuntimeStatusOwner } = await import('../content/system/capabilities/secondary-runtime-status.js');
  let getters = 0;
  const accessor = request();
  Object.defineProperty(accessor.payload, 'snapshot', { enumerable: true, get() { getters++; return snapshot(); } });
  const writes = [];
  const owner = createSecondaryRuntimeStatusOwner({ storage: { async set(items) { writes.push(items); } },
    getCurrentContext: () => ({ ...context(), epoch: 99, state: 'ready' }) });
  assert.deepEqual(parseSecondaryRuntimeStatusRequest(request()), request().payload);
  for (const value of [null, [], { ...request(), storageKey: 'JWT' }, { ...request(), category: 'settings-change' },
    { ...request(), payload: { ...request().payload, key: 'JWT' } },
    { ...request(), payload: { ...request().payload, context: { ...context(), rawAudio: [] } } },
    { ...request(), payload: { ...request().payload, sequence: -1 } },
    { ...request(), payload: { ...request().payload, snapshot: snapshot('802') } },
    { ...request(), [Symbol('extra')]: 1 }, accessor, new Proxy(request(), {})]) {
    assert.equal(parseSecondaryRuntimeStatusRequest(value), null);
    assert.equal((await owner.publish(value)).ok, false);
  }
  assert.equal(getters, 0);
  assert.equal(writes.length, 0);
  assert.equal((await owner.publish(request())).ok, true, 'isolated epoch is not compared with the independent MAIN epoch');
  assert.deepEqual(Object.keys(writes[0]), ['subpalSecondaryRuntimeStatus']);
});

test('runtime owner serializes writes and drops obsolete sequence/context after asynchronous work without poisoning next publication', async () => {
  const { createSecondaryRuntimeStatusOwner } = await import('../content/system/capabilities/secondary-runtime-status.js');
  let current = { ...context(), state: 'ready' };
  const writes = [];
  let release;
  const owner = createSecondaryRuntimeStatusOwner({ getCurrentContext: () => current, storage: {
    async set(items) { writes.push(items); if (writes.length === 1) await new Promise(resolve => { release = resolve; }); }
  } });
  const first = owner.publish(request());
  while (!release) await Promise.resolve();
  const staleQueued = owner.publish(request('801', 1, 2));
  current = { ...context('802', 2), state: 'ready' };
  const latest = owner.publish(request('802', 2, 3));
  release();
  assert.equal((await first).ok, true);
  assert.equal((await staleQueued).ok, false);
  assert.equal((await latest).ok, true);
  assert.deepEqual(writes.map(items => items.subpalSecondaryRuntimeStatus.videoId), ['801', '802']);
  assert.equal((await owner.publish(request('801', 1, 4))).ok, false);
  assert.equal((await owner.publish(request('802', 2, 2))).ok, false);
  current = { ...context('802', 2), state: 'transitioning' };
  assert.equal((await owner.publish(request('802', 2, 5))).ok, false);
});

test('MAIN runtime client sends only the sealed publication and validates acknowledgement with bounded listener lifetime', async () => {
  const { createPageSecondaryRuntimeStatus } = await import('../content/system/capabilities/secondary-runtime-status.js');
  for (const response of [{ ok: true, value: { published: true } }, { ok: true, value: { published: true, token: 'private' } },
    { ok: false, error: { kind: 'timeout', code: 'transport-timeout', retryable: true } }]) {
    const listeners = new Map();
    const messages = [];
    const window = {
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      dispatchEvent(event) {
        messages.push(structuredClone(event.detail.message));
        listeners.get('responseFromContentScript')({ detail: { messageId: event.detail.messageId, response } });
      }
    };
    const result = await createPageSecondaryRuntimeStatus({ window }).publish(request().payload);
    assert.deepEqual(messages, [request()]);
    assert.equal(result.ok, response.ok === true && !Object.hasOwn(response.value, 'token'));
    assert.equal(listeners.size, 0);
  }
});

test('runtime owner remains best effort after context reader or storage failures and later publications can recover', async () => {
  const { createSecondaryRuntimeStatusOwner } = await import('../content/system/capabilities/secondary-runtime-status.js');
  let failContext = true;
  let failStorage = true;
  const writes = [];
  const owner = createSecondaryRuntimeStatusOwner({
    getCurrentContext() { if (failContext) throw new Error('context-not-ready'); return { ...context(), state: 'ready' }; },
    storage: { async set(items) { if (failStorage) throw new Error('offline'); writes.push(items); } }
  });
  assert.equal((await owner.publish(request())).ok, false);
  failContext = false;
  assert.equal((await owner.publish(request('801', 1, 2))).ok, false);
  failStorage = false;
  assert.equal((await owner.publish(request('801', 1, 3))).ok, true);
  assert.equal(writes.length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

const request = () => ({ category: 'settings-read', variant: 'last-manual-secondary-language', payload: {} });

test('last-manual read capability accepts only its exact empty request, never arbitrary storage keys or writes', async () => {
  const { parseLastManualSecondaryLanguageRequest, validateLastManualSecondaryLanguageResult } = await import('../content/system/capabilities/secondary-language-preference.js');
  assert.equal(parseLastManualSecondaryLanguageRequest(request()), true);
  let getterCalls = 0;
  const accessor = request();
  Object.defineProperty(accessor, 'payload', { enumerable: true, get() { getterCalls += 1; return {}; } });
  for (const input of [null, [], { ...request(), key: 'JWT' }, { ...request(), payload: { key: 'JWT' } },
    { ...request(), payload: { language: 'ja' } }, { ...request(), payload: { write: true } },
    { ...request(), [Symbol('extra')]: true }, { ...request(), payload: { [Symbol('extra')]: true } },
    { ...request(), variant: 'snapshot' }, { ...request(), category: 'settings-change' }, accessor,
    Object.assign(Object.create({ key: 'JWT' }), request()), new Proxy(request(), {})]) {
    assert.equal(parseLastManualSecondaryLanguageRequest(input), false);
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(validateLastManualSecondaryLanguageResult({ ok: true, value: { language: 'ja' } }), { ok: true, value: { language: 'ja' } });
  for (const value of [{ language: 'auto' }, { language: 'da' }, { language: 'ja', key: 'JWT' }]) {
    assert.equal(validateLastManualSecondaryLanguageResult({ ok: true, value }).ok, false);
  }
  const resultAccessor = {};
  Object.defineProperty(resultAccessor, 'language', { enumerable: true, get() { getterCalls += 1; return 'ja'; } });
  for (const input of [
    { ok: true, value: resultAccessor }, { ok: true, value: new Proxy({ language: 'ja' }, {}) },
    { ok: true, value: { language: 'ja', [Symbol('extra')]: true } },
    { ok: true, value: { language: 'ja' }, [Symbol('extra')]: true }
  ]) assert.equal(validateLastManualSecondaryLanguageResult(input).ok, false);
  assert.equal(getterCalls, 0);
});

test('MAIN preference client sends one sealed read and only accepts supported-language projection with no listener leak', async () => {
  const { createPageSecondaryLanguagePreference } = await import('../content/system/capabilities/secondary-language-preference.js');
  for (const response of [{ ok: true, value: { language: 'ja' } }, { ok: true, value: { language: 'ja', token: 'forbidden' } }]) {
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
    const result = await createPageSecondaryLanguagePreference({ window }).read();
    assert.deepEqual(messages, [request()]);
    assert.equal(result.ok, !Object.hasOwn(response.value, 'token'));
    assert.equal(listeners.size, 0);
  }
});

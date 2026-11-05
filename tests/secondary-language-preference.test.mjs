import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAllConfigKeys } from '../content/system/config/config-schema.js';

test('private last-manual preference defaults invalid records to English and never becomes a public setting', async () => {
  const { createSecondaryLanguagePreference, LAST_MANUAL_SECONDARY_LANGUAGE_KEY } = await import('../shared/secondary-language-preference.js');
  for (const value of [undefined, null, 'auto', 'invalid', {}, 1]) {
    const preference = createSecondaryLanguagePreference({ async get() { return { [LAST_MANUAL_SECONDARY_LANGUAGE_KEY]: value }; } });
    assert.equal(await preference.read(), 'en');
  }
  assert.equal(getAllConfigKeys().includes(LAST_MANUAL_SECONDARY_LANGUAGE_KEY), false);
});

test('private preference write failures do not report a failed transition after the public setting has already committed', async () => {
  const { createSecondaryLanguagePreference } = await import('../shared/secondary-language-preference.js');
  const preference = createSecondaryLanguagePreference({ async set() { throw new Error('private-storage-unavailable'); } });
  let writes = 0;
  await assert.rejects(preference.change('auto', 'ja', async () => { writes += 1; }), /private-storage-unavailable/);
  assert.equal(writes, 0);
});

test('manual to auto saves the prior choice before settings write; a concrete choice or restore uses manual language without storing auto', async () => {
  const { createSecondaryLanguagePreference, LAST_MANUAL_SECONDARY_LANGUAGE_KEY: key } = await import('../shared/secondary-language-preference.js');
  const events = [];
  const stored = {};
  const preference = createSecondaryLanguagePreference({
    async get() { return stored; },
    async set(items) { Object.assign(stored, items); events.push(['preference', items[key]]); }
  });
  const write = async value => events.push(['setting', value]);
  assert.equal(await preference.change('ja', 'auto', write), 'auto');
  assert.deepEqual(events, [['preference', 'ja'], ['setting', 'auto']]);
  assert.equal(await preference.change('auto', 'manual', write), 'ja');
  assert.equal(await preference.change('auto', 'ko', write), 'ko');
  assert.equal(await preference.read(), 'ko');
  stored[key] = 'auto';
  assert.equal(await preference.change('auto', 'manual', write), 'en');
  assert.equal(events.some(event => event[0] === 'preference' && event[1] === 'auto'), false);
  await assert.rejects(preference.change('auto', 'da', write), /language/);
});

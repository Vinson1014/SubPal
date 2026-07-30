import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

function plain(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

async function loadResult() {
  const source = await readFile(new URL('../content/system/capabilities/result.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context: vm.createContext({}) });
  await module.link(() => { throw new Error('result.js must not import dependencies'); });
  await module.evaluate();
  return module.namespace;
}

test('Given normalized Result helpers When success, failure, and thrown values are normalized Then callers receive the sealed Result contract', async () => {
  const result = await loadResult();
  assert.ok(result, 'Result capability is missing');

  assert.deepEqual(plain(result.ok('accepted')), { ok: true, value: 'accepted' });
  assert.deepEqual(plain(result.fail('invalid', 'malformed-page-observation', false, { field: 'payload' })), {
    ok: false,
    error: { kind: 'invalid', code: 'malformed-page-observation', retryable: false, meta: { field: 'payload' } }
  });
  assert.deepEqual(plain(result.fromThrown(new Error('downstream failed'), 'page-observation-dispatch-failed')), {
    ok: false,
    error: { kind: 'domain-rejected', code: 'page-observation-dispatch-failed', retryable: false }
  });
  assert.equal(result.isResult(result.ok(null)), true);
  assert.equal(result.isResult({ ok: false, error: { kind: 'invalid', code: 'x', retryable: false } }), true);
});

test('Given contradictory or extraneous Result fields When validated Then isResult rejects them while retaining an optional failure meta field', async () => {
  const result = await loadResult();
  assert.ok(result, 'Result capability is missing');
  for (const invalid of [
    { ok: true, value: 'accepted', error: {} }, { ok: true, value: 'accepted', extra: true },
    { ok: false, value: 'rejected', error: { kind: 'invalid', code: 'x', retryable: false } },
    { ok: false, error: { kind: 'invalid', code: 'x', retryable: false, extra: true } }
  ]) assert.equal(result.isResult(invalid), false);
  assert.equal(result.isResult({ ok: false, error: { kind: 'invalid', code: 'x', retryable: false, meta: { field: 'payload' } } }), true);
});

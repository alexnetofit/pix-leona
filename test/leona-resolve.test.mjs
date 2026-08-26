import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLeonaAccount } from '../lib/leona.js';

test('resolveLeonaAccount prioriza ID e só cai no e-mail se o ID não achar', async () => {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/accounts/5818/billing_profile')) {
      return { ok: true, status: 200, json: async () => ({ account_id: 5818, user: { email: 'a@x.com' } }) };
    }
    if (String(url).includes('/accounts/billing_profile?email=')) {
      return { ok: true, status: 200, json: async () => ({ account_id: 999, user: { email: 'a@x.com' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const byId = await resolveLeonaAccount({
    accountId: '5818',
    email: 'a@x.com',
    leonaToken: 'tok'
  });
  assert.equal(byId.source, 'id');
  assert.equal(byId.account_id, '5818');
  assert.equal(calls.some((u) => u.includes('email=')), false);

  calls.length = 0;
  const missingId = await resolveLeonaAccount({
    accountId: '404',
    email: 'a@x.com',
    leonaToken: 'tok'
  });
  assert.equal(missingId.source, 'email');
  assert.equal(missingId.account_id, '999');
  assert.equal(calls.some((u) => u.includes('/accounts/404/')), true);
  assert.equal(calls.some((u) => u.includes('email=')), true);

  globalThis.fetch = prev;
});

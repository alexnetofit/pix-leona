import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLeonaProfileActivelyPaid,
  listActiveLeonaAccountsByEmail,
  resolveLeonaAccount
} from '../lib/leona.js';

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

test('isLeonaProfileActivelyPaid exige status active e período vigente', () => {
  assert.equal(isLeonaProfileActivelyPaid({
    subscription_status: 'active',
    current_period_end: '2099-01-01T00:00:00-03:00'
  }), true);
  assert.equal(isLeonaProfileActivelyPaid({
    subscription_status: 'inactive',
    current_period_end: '2099-01-01T00:00:00-03:00'
  }), false);
  assert.equal(isLeonaProfileActivelyPaid({
    subscription_status: 'active',
    current_period_end: '2020-01-01T00:00:00-03:00'
  }), false);
});

test('listActiveLeonaAccountsByEmail devolve as duas contas ativas do 409', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('email=tamiris')) {
      return {
        ok: false,
        status: 409,
        json: async () => ({ account_ids: [12937, 14337] })
      };
    }
    if (String(url).includes('/accounts/12937/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          account_id: 12937,
          subscription_status: 'active',
          current_period_end: '2099-09-27T23:59:59-03:00'
        })
      };
    }
    if (String(url).includes('/accounts/14337/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          account_id: 14337,
          subscription_status: 'active',
          current_period_end: '2099-12-17T23:59:59-03:00'
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const accounts = await listActiveLeonaAccountsByEmail('tamirisdc12@gmail.com', 'tok');
  assert.equal(accounts.length, 2);
  globalThis.fetch = prev;
});

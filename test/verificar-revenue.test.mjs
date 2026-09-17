import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isVerificarEmail,
  lookupVerificarRevenue,
  normalizeVerificarEmail,
  presentVerificarAccount,
  presentVerificarResult,
  revenueBrlFromLifetime
} from '../lib/verificar-revenue.js';

test('normaliza e valida e-mail da busca', () => {
  assert.equal(normalizeVerificarEmail('  DavidMejiaCR7@gmail.com '), 'davidmejiacr7@gmail.com');
  assert.equal(isVerificarEmail('davidmejiacr7@gmail.com'), true);
  assert.equal(isVerificarEmail('sem-arroba'), false);
  assert.equal(isVerificarEmail(''), false);
});

test('revenueBrlFromLifetime usa só BRL', () => {
  assert.equal(revenueBrlFromLifetime({ revenue_by_currency: { BRL: 14766.51, USD: 10 } }), 14766.51);
  assert.equal(revenueBrlFromLifetime({ revenue_brl: 99.5 }), 99.5);
  assert.equal(revenueBrlFromLifetime({ revenue_by_currency: { USD: 10 } }), 0);
  assert.equal(revenueBrlFromLifetime(null), 0);
});

test('presentVerificarResult devolve só o faturamento somado', () => {
  const a = presentVerificarAccount(
    { account_id: 1, user: { name: 'A', email: 'a@x.com' }, subscription_status: 'active', plan_summary: '1 Starter' },
    { revenue_by_currency: { BRL: 100 } }
  );
  const b = presentVerificarAccount(
    { account_id: 2, user: { name: 'A', email: 'a@x.com' }, subscription_status: 'inactive', plan_summary: '—' },
    { revenue_by_currency: { BRL: 50.5 } }
  );
  assert.deepEqual(Object.keys(a), ['revenue_brl']);
  const result = presentVerificarResult([a, b]);
  assert.deepEqual(Object.keys(result).sort(), ['faturamento', 'faturamento_formatado']);
  assert.equal(result.faturamento, 150.5);
  assert.match(result.faturamento_formatado, /150/);
  assert.equal(result.email, undefined);
  assert.equal(result.accounts, undefined);
  assert.equal(result.found, undefined);
});

test('lookupVerificarRevenue soma contas do 409 e devolve 404 sem dados extras', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/accounts/billing_profile?email=')) {
      return {
        ok: false,
        status: 409,
        json: async () => ({ account_ids: [10, 11] })
      };
    }
    if (href.includes('/accounts/10/billing_profile')) {
      return { ok: true, status: 200, json: async () => ({ account_id: 10, user: { email: 'a@x.com', name: 'A' }, subscription_status: 'active', plan_summary: '2 Starter' }) };
    }
    if (href.includes('/accounts/11/billing_profile')) {
      return { ok: true, status: 200, json: async () => ({ account_id: 11, user: { email: 'a@x.com', name: 'A' }, subscription_status: 'inactive', plan_summary: '—' }) };
    }
    if (href.includes('/accounts/10/lifetime_revenue')) {
      return { ok: true, status: 200, json: async () => ({ revenue_by_currency: { BRL: 200 } }) };
    }
    if (href.includes('/accounts/11/lifetime_revenue')) {
      return { ok: true, status: 200, json: async () => ({ revenue_by_currency: { BRL: 30 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const found = await lookupVerificarRevenue('a@x.com', 'tok');
  assert.equal(found.ok, true);
  assert.equal(found.status, 200);
  assert.deepEqual(Object.keys(found.body).sort(), ['faturamento', 'faturamento_formatado']);
  assert.equal(found.body.faturamento, 230);
  assert.equal(found.body.accounts, undefined);
  assert.equal(found.body.email, undefined);

  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Conta não encontrada' }) });
  const missing = await lookupVerificarRevenue('sumiu@x.com', 'tok');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Conta não encontrada' });

  globalThis.fetch = prev;
});

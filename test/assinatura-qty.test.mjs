import test from 'node:test';
import assert from 'node:assert/strict';

import { qtyFromPlanName, resolveExpiredCheckoutQty } from '../lib/assinatura-qty.js';

test('lê a qty do nome da oferta', () => {
  assert.equal(qtyFromPlanName('Plano Starter - 12 conexões'), 12);
  assert.equal(qtyFromPlanName('Plano Starter - 1 conexão'), 1);
  assert.equal(qtyFromPlanName(''), null);
});

test('vencido com slot Leona conhecido usa o slot, não 1', () => {
  assert.equal(resolveExpiredCheckoutQty({
    leonaQty: 12,
    subscriptions: [{ offer_name: 'Plano Starter - 1 conexão', charged_times: 1, status_at: 9 }]
  }), 12);
});

test('sem slot Leona usa a última sub Guru que já foi cobrada', () => {
  assert.equal(resolveExpiredCheckoutQty({
    leonaQty: 0,
    subscriptions: [
      { offer_name: 'Plano Starter - 1 conexão', charged_times: 0, status_at: 10, cycle_end: '2026-07-09' },
      { offer_name: 'Plano Starter - 12 conexões', charged_times: 3, status_at: 20, cycle_end: '2026-08-14' }
    ]
  }), 12);
});

test('sem assinatura usa o último pagamento aprovado', () => {
  assert.equal(resolveExpiredCheckoutQty({
    leonaQty: 0,
    subscriptions: [],
    invoices: [
      { status: 'expired', offer_name: 'Plano Starter - 1 conexão', period_end: '2026-08-20' },
      { status: 'paid', offer_name: 'Plano Starter - 10 conexões', period_end: '2026-08-14' },
      { status: 'paid', offer_name: 'Plano Starter - 5 conexões', period_end: '2026-07-13' }
    ]
  }), 10);
});

test('sem histórico continua em 1', () => {
  assert.equal(resolveExpiredCheckoutQty({}), 1);
  assert.equal(resolveExpiredCheckoutQty({ leonaQty: 0, subscriptions: [], invoices: [] }), 1);
});

test('script do browser devolve a mesma qty que o helper', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const ctx = {};
  ctx.globalThis = ctx;
  runInNewContext(readFileSync(new URL('../public/assinatura-qty.js', import.meta.url), 'utf8'), ctx);
  const sample = {
    leonaQty: 0,
    subscriptions: [
      { offer_name: 'Plano Starter - 12 conexões', charged_times: 3, status_at: 20 }
    ]
  };
  assert.equal(ctx.AssinaturaQty.resolveExpiredCheckoutQty(sample), resolveExpiredCheckoutQty(sample));
});

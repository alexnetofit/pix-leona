import test from 'node:test';
import assert from 'node:assert/strict';

import {
  invoiceReadyForPayment,
  qtyFromLeonaCode,
  qtyFromPayment,
  qtyFromPlanName,
  resolveExpiredCheckoutQty
} from '../lib/assinatura-qty.js';
import { pagarmeOrderToPayment, paddleTxToPayment, shouldLoadAssinaturaPayments } from '../lib/assinatura-payments.js';

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

test('último pagamento de upgrade usa o plano alvo, não o delta cobrado', () => {
  // Guru: 10 → 12. A fatura é type=upgrade e o valor é só o pró-rata
  // das 2 extras (ex.: R$ 36,87), mas offer_name continua "12 conexões".
  assert.equal(resolveExpiredCheckoutQty({
    leonaQty: 0,
    subscriptions: [],
    invoices: [
      {
        status: 'paid',
        type: 'upgrade',
        offer_name: 'Plano Starter - 12 conexões',
        value: 36.87,
        period_end: '2026-08-12'
      },
      {
        status: 'paid',
        type: 'cycle',
        offer_name: 'Plano Starter - 10 conexões',
        value: 790,
        period_end: '2026-08-11'
      }
    ]
  }), 12);
});

test('com sub cobrada, o plano da sub ganha do último upgrade', () => {
  assert.equal(resolveExpiredCheckoutQty({
    leonaQty: 0,
    subscriptions: [
      { offer_name: 'Plano Starter - 12 conexões', charged_times: 2, status_at: 20, cycle_end: '2026-08-12' }
    ],
    invoices: [
      { status: 'paid', type: 'upgrade', offer_name: 'Plano Starter - 12 conexões', value: 36.87, period_end: '2026-08-12' }
    ]
  }), 12);
});

test('Pagar.me upgrade lê o plano alvo no código, não o item.quantity=1', () => {
  assert.equal(qtyFromLeonaCode('leona-11134-12-prorata'), 12);
  assert.equal(qtyFromPayment({
    status: 'paid',
    code: 'leona-11134-12-prorata',
    offer_name: 'Ajuste Leona — 12 conexões',
    item_quantity: 1,
    value: 36.87
  }), 12);
  assert.equal(resolveExpiredCheckoutQty({
    leonaQty: 0,
    invoices: [
      { status: 'paid', offer_name: 'Plano Starter - 10 conexões', period_end: '2026-08-11' }
    ],
    payments: [
      {
        status: 'paid',
        provider: 'pagarme',
        code: 'leona-11134-12-prorata',
        offer_name: 'Ajuste Leona — 12 conexões',
        item_quantity: 1,
        paid_at: '2026-08-12T12:00:00Z'
      }
    ]
  }), 12);
});

test('Paddle one-shot usa custom_data.qty, não o item avulso', () => {
  assert.equal(qtyFromPayment({
    status: 'paid',
    custom_data: { kind: 'one_shot', qty: '8' },
    offer_name: 'Ajuste Leona — 8 conexões',
    item_quantity: 1
  }), 8);
  assert.equal(resolveExpiredCheckoutQty({
    leonaQty: 0,
    payments: [{
      status: 'paid',
      provider: 'paddle',
      custom_data: { kind: 'one_shot', qty: '8' },
      offer_name: 'Ajuste Leona — 8 conexões',
      item_quantity: 1,
      paid_at: '2026-08-29T12:00:00Z'
    }]
  }), 8);
});

test('Paddle recorrente usa a quantity dos seats, não o nome "1 conexão"', () => {
  assert.equal(qtyFromPayment({
    status: 'paid',
    custom_data: { qty: '8' },
    offer_name: 'Leona Flow - 1 conexão',
    item_quantity: 8
  }), 8);
});

test('normaliza pedido Pagar.me real de ajuste', () => {
  const row = pagarmeOrderToPayment({
    status: 'paid',
    code: 'leona-11134-2-prorata',
    items: [{ description: 'Ajuste Leona — 2 conexões', quantity: 1, amount: 4023 }],
    charges: [{ status: 'paid', paid_at: '2026-08-29T11:55:00Z' }]
  }, ['11134']);
  assert.equal(row.qty, 2);
  assert.equal(row.account_id, '11134');
  assert.equal(pagarmeOrderToPayment({
    status: 'paid',
    code: 'leona-11134-2-prorata',
    items: [{ description: 'Ajuste Leona — 2 conexões', quantity: 1 }]
  }, ['99999']), null);
});

test('normaliza transação Paddle paga e ignora draft', () => {
  const paid = paddleTxToPayment({
    status: 'completed',
    billed_at: '2026-08-29T12:00:00Z',
    custom_data: { kind: 'one_shot', qty: '8', leona_account_id: '10864' },
    items: [{ quantity: 1, price_name: 'Ajuste Leona — 8 conexões' }]
  }, ['10864']);
  assert.equal(paid.qty, 8);
  assert.equal(paddleTxToPayment({
    status: 'draft',
    custom_data: { kind: 'one_shot', qty: '8', leona_account_id: '10864' },
    items: [{ quantity: 1, price_name: 'Ajuste Leona — 8 conexões' }]
  }, ['10864']), null);
});

test('só busca Pagar.me/Paddle quando o slot Leona não resolve', () => {
  assert.equal(shouldLoadAssinaturaPayments([{ starter_instances: 12 }]), false);
  assert.equal(shouldLoadAssinaturaPayments([{ starter_instances: 0 }]), true);
  assert.equal(shouldLoadAssinaturaPayments([]), true);
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
    subscriptions: [],
    payments: [{
      status: 'paid',
      code: 'leona-11134-12-prorata',
      offer_name: 'Ajuste Leona — 12 conexões',
      item_quantity: 1,
      paid_at: '2026-08-12T12:00:00Z'
    }]
  };
  assert.equal(ctx.AssinaturaQty.resolveExpiredCheckoutQty(sample), resolveExpiredCheckoutQty(sample));
});

test('fatura de downgrade com charge_at futuro não está liberada pra pagar', () => {
  const inv = {
    type: 'downgrade',
    status: 'waiting_payment',
    value: 198,
    charge_at: '2026-09-06',
    payment_url: 'https://go.leonaflow.com/pay/x/invoice'
  };
  assert.equal(invoiceReadyForPayment(inv, '2026-09-03'), false);
  assert.equal(invoiceReadyForPayment(inv, '2026-09-06'), true);
  assert.equal(invoiceReadyForPayment({ ...inv, status: 'paid' }, '2026-09-06'), false);
  assert.equal(invoiceReadyForPayment({ status: 'waiting_payment' }, '2026-09-03'), true);
});

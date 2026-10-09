import test from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyPagarmeAssinaturaReversal,
  pagarmeOrdersReversal
} from '../lib/pagarme-assinatura.js';

const intent = { email: 'cliente@x.com', dlocal_payment_id: 'pl_abc' };
const paidOrder = { id: 'or_paid', charges: [{ status: 'paid', paid_amount: 12700, canceled_amount: 0 }] };
const refundedOrder = { id: 'or_paid', charges: [{ status: 'canceled', paid_amount: 12700, canceled_amount: 12700 }] };
const failedAttempt = { id: 'or_fail', status: 'canceled', charges: [{ status: 'canceled' }] };

function deps(orders) {
  const sent = [];
  return {
    sent,
    opts: {
      findIntent: async () => intent,
      loadOrders: async () => orders,
      notify: async (payload) => {
        sent.push(payload);
        return { ok: true, http: 200, body: { status: 'refund_processed' } };
      }
    }
  };
}

test('estorno total do pedido avisa o painel com o mesmo id da venda', async () => {
  const { sent, opts } = deps([refundedOrder]);
  const out = await notifyPagarmeAssinaturaReversal('pl_abc', { type: 'charge.refunded', data: { status: 'refunded' } }, opts);
  assert.equal(out.status, 'refunded');
  assert.equal(out.retry, false);
  assert.deepEqual(sent, [{ txId: 'pagarme:pl_abc', email: 'cliente@x.com', status: 'refunded' }]);
});

test('tentativa cancelada que nunca pagou não derruba a comissão do link pago', async () => {
  const { sent, opts } = deps([failedAttempt, paidOrder]);
  const out = await notifyPagarmeAssinaturaReversal('pl_abc', { type: 'order.canceled', data: { status: 'canceled' } }, opts);
  assert.equal(out.skipped, true);
  assert.equal(sent.length, 0);
});

test('estorno parcial não reverte a comissão inteira', () => {
  assert.equal(pagarmeOrdersReversal([
    { charges: [{ status: 'paid', paid_amount: 197500, canceled_amount: 39500 }] }
  ]), null);
});

test('chargeback vira chargeback', () => {
  assert.equal(pagarmeOrdersReversal([
    { charges: [{ status: 'chargedback', paid_amount: 12700 }] }
  ]), 'chargeback');
});

test('evento de pagamento não consulta nada', async () => {
  let called = false;
  const out = await notifyPagarmeAssinaturaReversal('or_x', { type: 'order.paid', data: { status: 'paid' } }, {
    findIntent: async () => { called = true; return intent; }
  });
  assert.equal(out, null);
  assert.equal(called, false);
});

test('falha da Pagar.me pede reenvio do webhook', async () => {
  const out = await notifyPagarmeAssinaturaReversal('or_x', { type: 'charge.refunded' }, {
    findIntent: async () => intent,
    loadOrders: async () => null
  });
  assert.equal(out.retry, true);
});

test('painel fora do ar pede reenvio do webhook', async () => {
  const out = await notifyPagarmeAssinaturaReversal('or_x', { type: 'charge.refunded' }, {
    findIntent: async () => intent,
    loadOrders: async () => [refundedOrder],
    notify: async () => ({ ok: false, http: 503 })
  });
  assert.equal(out.retry, true);
});

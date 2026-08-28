import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPagarmeSubscriberSnapshot,
  intentAsPagarmeOrder,
  isPagarmeLeonaOrder,
  isPagarmeOneShotOrder,
  isPagarmeRefundedOrder,
  pagarmeGrossCents,
  pagarmeListDateWindow,
  pagarmeNetCents,
  pagarmePartyEmail,
  pagarmePaymentDay
} from '../lib/revenue-source.js';

test('so pedido Leona entra no faturamento da Pagar.me', () => {
  assert.equal(isPagarmeLeonaOrder({ code: 'leona-15099-1-sub' }), true);
  assert.equal(isPagarmeLeonaOrder({
    code: 'trilha-abc',
    items: [{ description: 'Placa trilha' }]
  }), false);
  assert.equal(isPagarmeLeonaOrder({
    metadata: { kind: 'one_shot' },
    items: [{ description: 'Ajuste Leona — 2 conexões' }]
  }), false);
  assert.equal(isPagarmeLeonaOrder({
    code: 'a29ab549-e291-42a0',
    metadata: { kind: 'subscription' },
    items: [{ description: 'Leona Flow' }]
  }), false);
});

test('ciclo novo e ajuste nao se misturam', () => {
  assert.equal(isPagarmeOneShotOrder({
    code: 'leona-684-40-prorata',
    metadata: { kind: 'one_shot' }
  }), true);
  assert.equal(isPagarmeOneShotOrder({
    code: 'leona-15099-1-sub',
    metadata: { kind: 'subscription' }
  }), false);
  assert.equal(isPagarmeOneShotOrder({ code: 'leona-10878-1-prorata' }), true);
});

test('bruto e liquido usam centavos BRL do pedido', () => {
  assert.equal(pagarmeGrossCents({ amount: 12700 }), 12700);
  assert.equal(pagarmeGrossCents({
    amount: 12700,
    charges: [{ paid_amount: 12700, amount: 12700 }]
  }), 12700);
  assert.equal(pagarmeNetCents({
    amount: 12700,
    charges: [{ paid_amount: 12700, last_transaction: { fee: 380 } }]
  }), 12320);
});

test('email e dia BRT saem do charge pago', () => {
  assert.equal(pagarmePartyEmail({
    customer: { email: 'Ana@X.com' }
  }), 'ana@x.com');
  assert.equal(pagarmePaymentDay({
    created_at: '2026-08-27T02:10:00.000Z',
    charges: [{ paid_at: '2026-08-27T03:10:00.000Z' }]
  }), '2026-08-27');
});

test('janela da listagem cobre a virada UTC', () => {
  assert.deepEqual(pagarmeListDateWindow(['2026-08-27']), {
    createdSince: '2026-08-26',
    createdUntil: '2026-08-29'
  });
});

test('intent da assinatura vira pedido Leona mesmo quando o id e pl_', () => {
  const order = intentAsPagarmeOrder({
    account_id: '15099',
    qty: 1,
    amount_cents: 12700,
    email: 'ana@x.com',
    status: 'paid',
    paid_at: '2026-08-27T23:10:00.000Z',
    dlocal_payment_id: 'pl_abc',
    details: { provider: 'pagarme', kind: 'subscription' }
  });
  assert.equal(isPagarmeLeonaOrder(order), true);
  assert.equal(isPagarmeOneShotOrder(order), false);
  assert.equal(pagarmeGrossCents(order), 12700);
  assert.equal(pagarmePartyEmail(order), 'ana@x.com');
  assert.equal(pagarmePaymentDay(order), '2026-08-27');
});

test('estorno nao conta como venda paga', () => {
  assert.equal(isPagarmeRefundedOrder({
    status: 'canceled',
    charges: [{ status: 'refunded', paid_at: '2026-08-27T12:00:00.000Z' }]
  }), true);
  assert.equal(isPagarmeRefundedOrder({
    status: 'paid',
    charges: [{ status: 'paid', paid_at: '2026-08-27T12:00:00.000Z' }]
  }), false);
});

test('pedido Guru (UUID) nao entra no checkout', () => {
  assert.equal(isPagarmeLeonaOrder({
    code: 'a2738d7d-26b4-4574-9502-a0a6c338098e',
    items: [{ description: 'Plano Starter - 3 conexões' }]
  }), false);
  assert.equal(isPagarmeLeonaOrder({
    code: 'leona-1767-1-sub',
    items: [{ description: 'Leona Flow — 1 conexão' }]
  }), true);
  assert.equal(isPagarmeLeonaOrder({
    order: { code: 'leona-8841-2-sub' }
  }), true);
});

test('payment link da /assinatura entra; Guru e trilha nao', () => {
  assert.equal(isPagarmeLeonaOrder({
    code: 'pl_x3Xg8Njod9ewkzqcA9FrgKM21YAr5bGV',
    items: [{ description: 'Leona Flow — 1 conexão' }],
    metadata: { payment_link_id: 'pl_x3Xg8Njod9ewkzqcA9FrgKM21YAr5bGV' }
  }), true);
  assert.equal(isPagarmeOneShotOrder({
    code: 'pl_LEvQpx6mPabjqdgwhkSzA78lZB20Dyk1',
    items: [{ description: 'Ajuste Leona — 40 conexões' }]
  }), true);
  assert.equal(isPagarmeLeonaOrder({
    code: 'pl_abc',
    items: [{ description: 'Placa trilha' }]
  }), false);
});

test('assinatura nativa conta no recorrente', () => {
  const snapshot = buildPagarmeSubscriberSnapshot({
    subscriptions: [
      { status: 'active', customer: { email: 'sub@x.com' } },
      { status: 'canceled', customer: { email: 'fora@x.com' } }
    ],
    orders: [
      {
        code: 'leona-1-1-sub',
        status: 'paid',
        metadata: { kind: 'subscription' },
        customer: { email: 'sub@x.com' },
        charges: [{ status: 'paid' }]
      }
    ]
  });
  assert.equal(snapshot.recurring, 1);
  assert.equal(snapshot.prepaid, 0);
  assert.equal(snapshot.count, 1);
});

test('assinante unico: ciclo novo ganha do ajuste no mesmo e-mail', () => {
  const snapshot = buildPagarmeSubscriberSnapshot({
    orders: [
      {
        code: 'leona-1-1-sub',
        status: 'paid',
        metadata: { kind: 'subscription' },
        customer: { email: 'a@x.com' },
        charges: [{ status: 'paid' }]
      },
      {
        code: 'leona-1-2-prorata',
        status: 'paid',
        metadata: { kind: 'one_shot' },
        customer: { email: 'a@x.com' },
        charges: [{ status: 'paid' }]
      },
      {
        code: 'leona-2-3-prorata',
        status: 'paid',
        metadata: { kind: 'one_shot' },
        customer: { email: 'b@x.com' },
        charges: [{ status: 'paid' }]
      }
    ]
  });
  assert.equal(snapshot.recurring, 1);
  assert.equal(snapshot.prepaid, 1);
  assert.equal(snapshot.count, 2);
});

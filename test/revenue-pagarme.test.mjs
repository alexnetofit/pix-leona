import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPagarmeSubscriberSnapshot,
  collapsePagarmeRepeatIntents,
  intentAsPagarmeOrder,
  isPagarmeLeonaOrder,
  isPagarmeOneShotOrder,
  isPagarmeRefundedOrder,
  isPagarmeSubscriptionRevenueOrder,
  isPagarmeTokenOrder,
  mergePagarmeOrdersById,
  pagarmeChunkWindows,
  pagarmeGrossCents,
  pagarmeListDateWindow,
  pagarmeNetCents,
  pagarmePartyEmail,
  pagarmePaymentDay,
  pendingPagarmeOrdersWithPaidCharge
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

test('snapshot da Pagar.me fatia a janela pra não cortar em 80 páginas', () => {
  assert.deepEqual(pagarmeChunkWindows('2026-08-14', '2026-08-28', 7), [
    { createdSince: '2026-08-14T00:00:00.000Z', createdUntil: '2026-08-21T00:00:00.000Z' },
    { createdSince: '2026-08-21T00:00:00.000Z', createdUntil: '2026-08-28T00:00:00.000Z' }
  ]);
  assert.deepEqual(pagarmeChunkWindows('2026-08-14', '2026-08-14', 7), []);
});

test('merge da Pagar.me junta API com intent sem duplicar o mesmo id', () => {
  const merged = mergePagarmeOrdersById(
    [{ id: 'or_1', code: 'leona-1-1-sub' }],
    [{ id: 'or_1', code: 'leona-1-1-sub' }, { id: 'pl_2', code: 'pl_2' }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, 'pl_2');
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

test('pedido pending com cobranca paga entra; pending sem pagamento nao', () => {
  const pixPago = {
    id: 'or_pix',
    code: 'leona-1875-7-sub-20260927-1790549846',
    status: 'pending',
    charges: [{ status: 'paid', paid_at: '2026-09-27T22:58:02Z', paid_amount: 55300 }]
  };
  const cartaoCapturado = {
    id: 'or_card',
    code: 'leona-2226-11-sub',
    status: 'pending',
    charges: [{ status: 'paid', paid_at: '2026-09-06T12:46:13Z', paid_amount: 86900 }]
  };
  const aguardando = {
    id: 'or_wait',
    code: 'leona-9-1-sub',
    status: 'pending',
    charges: [{ status: 'pending', paid_amount: 0 }]
  };
  const estornado = {
    id: 'or_ref',
    code: 'leona-10-1-sub',
    status: 'pending',
    charges: [{ status: 'refunded', paid_at: '2026-09-10T12:00:00Z', paid_amount: 12700 }]
  };
  const kept = pendingPagarmeOrdersWithPaidCharge([pixPago, cartaoCapturado, aguardando, estornado]);
  assert.deepEqual(kept.map((order) => order.id), ['or_pix', 'or_card']);
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

test('faturamento é só assinatura: trilha com Garrafa Leona e tokens ficam fora', () => {
  const trilha = {
    code: 'pl_pe62oyvY37AlOnatxf5VEDxJ1kWKZaMV',
    items: [
      { description: 'Carta + Pulseira + Pin 50k' },
      { description: 'Kit Placa Premium' },
      { description: 'Garrafa Leona' },
      { description: 'Jaqueta Leona' }
    ]
  };
  assert.equal(isPagarmeLeonaOrder(trilha), false);
  assert.equal(isPagarmeSubscriptionRevenueOrder(trilha), false);

  for (const token of [
    { code: 'leona-tokens-22-10000-110926', items: [{ description: '10000 tokens Leona' }] },
    { code: 'leona-c25489b488f8ffd24bebf45a4f9c04d3', items: [{ description: '12000 tokens Leona' }] },
    { code: 'pl_tok', items: [{ description: '10000 tokens Leona' }] }
  ]) {
    assert.equal(isPagarmeTokenOrder(token), true, token.code);
    assert.equal(isPagarmeSubscriptionRevenueOrder(token), false, token.code);
  }

  for (const sub of [
    { code: 'leona-1050-2-sub', items: [{ description: 'Leona Flow — 2 conexões' }] },
    { code: 'leona-1780-55-prorata', items: [{ description: 'Ajuste Leona — 55 conexões' }] },
    { code: 'leona-1-3-sub-20260901-1', items: [{ description: 'Regularização · 3 instâncias' }] },
    { code: 'pl_sub', items: [{ description: 'Leona Flow — 1 conexão' }] },
    { code: 'pl_adj', items: [{ description: 'Ajuste Leona — 4 conexões' }] }
  ]) {
    assert.equal(isPagarmeSubscriptionRevenueOrder(sub), true, sub.code);
  }
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
  assert.equal(snapshot.count, 1);
  assert.deepEqual(snapshot.emails, ['a@x.com']);
});

test('token e só pró-rata não viram assinante da Pagar.me', () => {
  assert.equal(isPagarmeTokenOrder({ code: 'leona-tokens-14232-1000-150926011213-e21fe98a' }), true);
  const snapshot = buildPagarmeSubscriberSnapshot({
    orders: [
      {
        code: 'leona-tokens-1-1000-x',
        status: 'paid',
        customer: { email: 'token@x.com' },
        charges: [{ status: 'paid' }]
      },
      {
        code: 'leona-9-2-prorata',
        status: 'paid',
        metadata: { kind: 'one_shot' },
        customer: { email: 'ajuste@x.com' },
        charges: [{ status: 'paid' }]
      }
    ]
  });
  assert.equal(snapshot.count, 0);
  assert.equal(snapshot.prepaid, 1);
  assert.deepEqual(snapshot.emails, []);
});

test('clique duplo na mesma conta some da contagem', () => {
  const kept = collapsePagarmeRepeatIntents([
    {
      account_id: '10878',
      amount_cents: 12700,
      created_at: '2026-08-28T00:43:39.014Z',
      details: { kind: 'subscription' }
    },
    {
      account_id: '10878',
      amount_cents: 12700,
      created_at: '2026-08-28T00:43:44.567Z',
      details: { kind: 'subscription' }
    },
    {
      account_id: '747',
      amount_cents: 7110,
      created_at: '2026-08-28T01:44:47.935Z',
      details: { kind: 'one_shot' }
    },
    {
      account_id: '747',
      amount_cents: 7110,
      created_at: '2026-08-28T02:25:44.035Z',
      details: { kind: 'one_shot' }
    }
  ]);
  assert.equal(kept.length, 3);
  assert.equal(kept.filter((row) => row.account_id === '10878').length, 1);
  assert.equal(kept.filter((row) => row.account_id === '747').length, 2);
});

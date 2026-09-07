import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPagarmeDowngradeItemPayload,
  pickActivePagarmeLeonaSub,
  pickPagarmeSubscriptionItem,
  resolvePagarmeDowngrade
} from '../lib/pagarme-downgrade.js';
import { buildPagarmeCardContext } from '../lib/pagarme-card.js';

test('PIX / sem sub_ só avisa; cartão com sub_ edita assinatura', () => {
  assert.deepEqual(resolvePagarmeDowngrade({
    hasSubscription: false,
    currentQty: 4,
    newQty: 1
  }), { ok: true, mode: 'notice', from: 4, to: 1 });
  assert.deepEqual(resolvePagarmeDowngrade({
    hasSubscription: true,
    currentQty: 4,
    newQty: 2
  }), { ok: true, mode: 'subscription', from: 4, to: 2 });
  assert.equal(resolvePagarmeDowngrade({
    hasSubscription: true,
    currentQty: 2,
    newQty: 2
  }).ok, false);
});

test('payload do item usa o preço Leona do plano menor', () => {
  const payload = buildPagarmeDowngradeItemPayload(1);
  assert.equal(payload.quantity, 1);
  assert.equal(payload.pricing_scheme.scheme_type, 'unit');
  assert.equal(payload.pricing_scheme.price, 12700);
  assert.match(payload.description, /1 conexão/);
  const four = buildPagarmeDowngradeItemPayload(4);
  assert.equal(four.pricing_scheme.price, 31600);
});

test('escolhe a sub Leona ativa e o item ativo', () => {
  const sub = pickActivePagarmeLeonaSub([
    { id: 'sub_old', status: 'canceled', code: 'leona-1-sub' },
    { id: 'sub_ok', status: 'active', code: 'leona-9-sub', items: [
      { id: 'si_dead', status: 'deleted' },
      { id: 'si_live', status: 'active' }
    ] }
  ]);
  assert.equal(sub.id, 'sub_ok');
  assert.equal(pickPagarmeSubscriptionItem(sub).id, 'si_live');
});

test('PIX Leona entra como billing Pagar.me sem assinatura recorrente', () => {
  const ctx = buildPagarmeCardContext({
    customer: { id: 'cus_pix' },
    cards: [],
    subscriptions: [],
    orders: [{
      status: 'paid',
      created_at: '2026-09-04T21:00:00Z',
      items: [{ description: 'Leona Flow — 1 conexão' }],
      charges: [{ payment_method: 'pix' }]
    }]
  });
  assert.equal(ctx.is_pagarme_billing, true);
  assert.equal(ctx.has_subscription, false);
  assert.equal(ctx.can_change_card, false);
  assert.equal(ctx.payment_method, 'pix');
});

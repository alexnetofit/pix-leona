import test from 'node:test';
import assert from 'node:assert/strict';
import { calcLeonaProrata, leonaAmountReais } from '../lib/leona-pricing.js';
import {
  buildPagarmeAssinaturaLinkPayload,
  resolvePagarmeAssinaturaCharge
} from '../lib/pagarme-assinatura.js';

test('pró-rata 5→7 usa (delta × dias) / 30', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-11T23:59:59-03:00';
  const calc = calcLeonaProrata(leonaAmountReais(5), leonaAmountReais(7), end, now);
  assert.equal(calc.diasRestantes, 16);
  assert.equal(calc.proRata, 84.27);
});

test('assinatura nova cobra o mês cheio', () => {
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 1,
    kind: 'subscription',
    profile: { starter_instances: 0 }
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.oneShot, false);
  assert.equal(charge.amountCents, 12700);
  assert.equal(charge.keepCycle, false);
});

test('upgrade mid-cycle cobra só o pró-rata e mantém vencimento', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-26T23:59:59-03:00';
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 7,
    kind: 'one_shot',
    profile: { starter_instances: 5, current_period_end: end },
    now
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.oneShot, true);
  assert.equal(charge.keepCycle, true);
  assert.equal(charge.dueDate, '2026-09-26');
  assert.equal(charge.amountCents, Math.round(charge.prorata.proRata * 100));
  assert.ok(charge.amountCents > 0);
});

test('payload do checkout tem PIX + cartão 1x', () => {
  const payload = buildPagarmeAssinaturaLinkPayload({
    accountId: '15221',
    qty: 1,
    oneShot: false,
    amountCents: 12700,
    productName: 'Leona Flow — 1 conexão',
    customer: { name: 'Ana', email: 'ana@test.com' }
  });
  assert.equal(payload.type, 'order');
  assert.deepEqual(payload.payment_settings.accepted_payment_methods, ['pix', 'credit_card']);
  assert.equal(payload.payment_settings.credit_card_settings.installments_setup.max_installments, 1);
  assert.equal(payload.cart_settings.items[0].amount, 12700);
  assert.match(payload.cart_settings.items[0].code, /leona-15221-1-sub/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REFUND_WINDOW_MS,
  refundEligibility,
  refundDecision,
  unitPriceForQuantity,
  totalPriceForQuantity,
  sumRecurringQuantity,
  brtYesterday,
  classifyQuantityChange,
  buildIntentFingerprint,
  shouldApplyEvent,
  isPixExpired,
  pixExpirationDecision,
  projectEntitlement
} from '../lib/paddle-policy.js';

const CAPTURED_AT = '2026-07-01T12:00:00.000Z';

function completedTransaction(overrides = {}) {
  return {
    status: 'completed',
    payments: [{ status: 'captured', captured_at: CAPTURED_AT }],
    details: { totals: { grand_total: '12700' } },
    ...overrides
  };
}

test('refundEligibility inclui a borda exata de sete dias e rejeita um milissegundo depois', () => {
  const paidAt = Date.parse(CAPTURED_AT);
  assert.equal(REFUND_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(refundEligibility(completedTransaction(), paidAt + REFUND_WINDOW_MS).eligible, true);
  assert.deepEqual(
    refundEligibility(completedTransaction(), paidAt + REFUND_WINDOW_MS + 1).reason,
    'refund_window_expired'
  );
});

test('refundEligibility prioriza captura válida e usa fallbacks na ordem definida', () => {
  const transaction = completedTransaction({
    completed_at: '2026-06-01T00:00:00Z',
    payments: [
      { status: 'failed', captured_at: '2026-05-01T00:00:00Z' },
      { status: 'completed', captured_at: CAPTURED_AT }
    ]
  });
  assert.equal(refundEligibility(transaction, '2026-07-02T00:00:00Z').source, 'payments.captured_at');

  const fallback = refundEligibility({
    status: 'completed',
    payments: [],
    completed_at: '2026-07-02T00:00:00Z',
    billed_at: '2026-07-01T00:00:00Z'
  }, '2026-07-03T00:00:00Z');
  assert.equal(fallback.source, 'completed_at');
});

test('refundEligibility exige completed e rejeita data futura ou inválida', () => {
  assert.equal(refundEligibility({ status: 'billed', created_at: CAPTURED_AT }, '2026-07-02').reason, 'transaction_not_completed');
  assert.equal(refundEligibility(completedTransaction(), '2026-06-30T00:00:00Z').reason, 'payment_in_future');
  assert.equal(refundEligibility({ status: 'completed', created_at: 'não-é-data' }, '2026-07-02').reason, 'invalid_date');
  assert.equal(refundEligibility(completedTransaction(), 'inválido').reason, 'invalid_date');
});

test('somente reembolso integral aprovado revoga entitlement', () => {
  const full = refundDecision({
    transaction: completedTransaction(),
    requestedAmount: 12700,
    approved: true,
    now: '2026-07-02T00:00:00Z'
  });
  assert.equal(full.kind, 'full');
  assert.equal(full.revokeEntitlement, true);

  const partial = refundDecision({
    transaction: completedTransaction(),
    requestedAmount: 5000,
    approved: true,
    now: '2026-07-02T00:00:00Z'
  });
  assert.equal(partial.kind, 'partial');
  assert.equal(partial.revokeEntitlement, false);

  const pendingFull = refundDecision({
    transaction: completedTransaction(),
    requestedAmount: 12700,
    approved: false,
    now: '2026-07-02T00:00:00Z'
  });
  assert.equal(pendingFull.revokeEntitlement, false);
});

test('precificação por quantidade respeita todos os tiers', () => {
  assert.equal(unitPriceForQuantity(1), 12700);
  assert.equal(unitPriceForQuantity(2), 9900);
  assert.equal(unitPriceForQuantity(3), 9900);
  assert.equal(unitPriceForQuantity(4), 7900);
  assert.equal(unitPriceForQuantity(100), 7900);
  assert.equal(totalPriceForQuantity(3), 29700);
  assert.equal(unitPriceForQuantity(0), null);
});

test('sumRecurringQuantity ignora itens one-time', () => {
  assert.equal(sumRecurringQuantity([
    { quantity: 2, price: { billing_cycle: { interval: 'month', frequency: 1 } } },
    { quantity: 50, price: { billing_cycle: null } },
    { quantity: 3, type: 'one_time' },
    { quantity: 1, type: 'recurring' },
    { quantity: 'inválida', type: 'recurring' }
  ]), 3);
});

test('brtYesterday usa o dia civil BRT de forma determinística', () => {
  assert.equal(brtYesterday('2026-07-23T02:59:59.999Z'), '2026-07-21');
  assert.equal(brtYesterday('2026-07-23T03:00:00.000Z'), '2026-07-22');
  assert.equal(brtYesterday('2026-01-01T03:00:00.000Z'), '2025-12-31');
  assert.equal(brtYesterday('inválido'), null);
});

test('classifyQuantityChange distingue upgrade, downgrade e inalterado', () => {
  assert.equal(classifyQuantityChange(1, 2), 'upgrade');
  assert.equal(classifyQuantityChange(3, 1), 'downgrade');
  assert.equal(classifyQuantityChange(2, 2), 'unchanged');
  assert.equal(classifyQuantityChange(-1, 2), 'invalid');
});

test('buildIntentFingerprint é estável e inclui somente os campos da intenção', () => {
  const first = buildIntentFingerprint({
    target: 3,
    account: 42,
    cycle: { frequency: 1, interval: 'month' },
    kind: 'upgrade',
    current: 1,
    ignored: 'x'
  });
  const second = buildIntentFingerprint({
    account: 42,
    kind: 'upgrade',
    current: 1,
    target: 3,
    cycle: { interval: 'month', frequency: 1 }
  });
  assert.equal(first, second);
  assert.notEqual(first, buildIntentFingerprint(42, 'upgrade', 1, 4, { interval: 'month', frequency: 1 }));
});

test('shouldApplyEvent impede eventos fora de ordem e empates', () => {
  const last = { occurred_at: '2026-07-23T12:00:00Z' };
  assert.equal(shouldApplyEvent({ occurred_at: '2026-07-23T12:00:01Z' }, last), true);
  assert.equal(shouldApplyEvent({ occurred_at: '2026-07-23T12:00:00Z' }, last), false);
  assert.equal(shouldApplyEvent({ occurred_at: '2026-07-23T11:59:59Z' }, last), false);
  assert.equal(shouldApplyEvent({ occurred_at: 'inválido' }, last), false);
  assert.equal(shouldApplyEvent({ occurred_at: '2026-07-23T12:00:00Z' }), true);
});

test('PIX liquidado não expira; pendente respeita expires_at e cutoff', () => {
  const now = '2026-07-23T12:00:00Z';
  assert.equal(isPixExpired({ status: 'PAID', expires_at: '2026-07-01T00:00:00Z' }, now), false);
  assert.equal(isPixExpired({ status: 'EXPIRED' }, now), true);
  assert.equal(isPixExpired({ status: 'PENDING', expires_at: now }, now), true);
  assert.deepEqual(
    pixExpirationDecision({ status: 'PENDING' }, now, '2026-07-23T12:00:00Z'),
    { expired: true, reason: 'cutoff' }
  );
  assert.equal(isPixExpired({ status: 'PENDING' }, now, '2026-07-23T12:00:01Z'), false);
});

test('downgrade muda quantidade financeira agora e entitlement no effective_at', () => {
  const input = {
    currentQuantity: 4,
    targetQuantity: 2,
    effectiveAt: '2026-08-01T00:00:00Z'
  };
  assert.deepEqual(projectEntitlement({ ...input, now: '2026-07-31T23:59:59.999Z' }), {
    change: 'downgrade',
    financialQuantity: 2,
    entitledQuantity: 4,
    effectiveAt: '2026-08-01T00:00:00.000Z'
  });
  assert.equal(projectEntitlement({ ...input, now: '2026-08-01T00:00:00Z' }).entitledQuantity, 2);
  assert.equal(projectEntitlement({ ...input, now: '2026-08-02T00:00:00Z' }).entitledQuantity, 2);
});

test('upgrade aplica quantidade financeira e entitlement imediatamente', () => {
  const projection = projectEntitlement({
    currentQuantity: 1,
    targetQuantity: 3,
    effectiveAt: '2026-08-01T00:00:00Z',
    now: '2026-07-20T00:00:00Z'
  });
  assert.equal(projection.financialQuantity, 3);
  assert.equal(projection.entitledQuantity, 3);
});

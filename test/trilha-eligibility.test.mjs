import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRILHA_MIN_PAID_MONTHS,
  buildTrilhaRedeemEligibility,
  mergePaidCycleKeys
} from '../lib/trilha-eligibility.js';

test('demo conta 1234 fica inelegível mesmo com meses', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '1234',
    paidMonths: 1,
    sources: { demo: true }
  });
  assert.equal(e.eligible, false);
  assert.equal(e.demo, true);
  assert.equal(e.paid_months, 1);
  assert.equal(e.missing_months, TRILHA_MIN_PAID_MONTHS - 1);
});

test('3+ meses pagos elegível', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '999',
    paidMonths: 3
  });
  assert.equal(e.eligible, true);
  assert.equal(e.missing_months, 0);
});

test('mergePaidCycleKeys une guru e paddle sem duplicar mesma chave', () => {
  const merged = mergePaidCycleKeys(
    new Set(['guru:sub1:c1', 'guru:sub1:c2']),
    new Set(['paddle:sub2:m2025-06'])
  );
  assert.equal(merged.size, 3);
});

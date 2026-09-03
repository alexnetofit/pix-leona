import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRILHA_MIN_PAID_MONTHS,
  buildTrilhaRedeemEligibility,
  isTrilhaRedeemGranted,
  mergePaidCycleKeys,
  resolveTrilhaRedeemEligibility
} from '../lib/trilha-eligibility.js';
import { TRILHA_DEMO_EMAIL } from '../lib/trilha-access.js';

test('demo conta 1234 fica inelegível mesmo com meses', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '1234',
    email: TRILHA_DEMO_EMAIL,
    paidMonths: 1,
    sources: { demo: true }
  });
  assert.equal(e.eligible, false);
  assert.equal(e.granted, false);
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
  assert.equal(e.granted, false);
  assert.equal(e.missing_months, 0);
});

test('grant só vale com account_id e e-mail certos', () => {
  assert.equal(isTrilhaRedeemGranted('15', 'praxedesconsultoriaoline@gmail.com'), true);
  assert.equal(isTrilhaRedeemGranted(15, 'Praxedesconsultoriaoline@gmail.com'), true);
  assert.equal(isTrilhaRedeemGranted('15', 'outro@gmail.com'), false);
  assert.equal(isTrilhaRedeemGranted('99', 'praxedesconsultoriaoline@gmail.com'), false);
  assert.equal(isTrilhaRedeemGranted('', 'praxedesconsultoriaoline@gmail.com'), false);
});

test('grant Praxedes libera resgate no preço normal sem meses pagos', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '15',
    email: 'praxedesconsultoriaoline@gmail.com',
    paidMonths: 0
  });
  assert.equal(e.eligible, true);
  assert.equal(e.granted, true);
  assert.equal(e.paid_months, TRILHA_MIN_PAID_MONTHS);
  assert.equal(e.missing_months, 0);
  assert.equal(e.sources.grant, true);
  assert.match(e.message, /suporte/);
});

test('sem grant e sem meses continua inelegível', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '15',
    email: 'outro@gmail.com',
    paidMonths: 0
  });
  assert.equal(e.eligible, false);
  assert.equal(e.granted, false);
  assert.equal(e.paid_months, 0);
});

test('resolveTrilhaRedeemEligibility do grant não consulta Guru/Paddle', async () => {
  const e = await resolveTrilhaRedeemEligibility({
    accountId: '15',
    email: 'praxedesconsultoriaoline@gmail.com',
    guruToken: 'token-falso-nao-deve-ser-usado'
  });
  assert.equal(e.eligible, true);
  assert.equal(e.granted, true);
  assert.equal(e.paid_months, TRILHA_MIN_PAID_MONTHS);
  assert.equal(e.sources.grant, true);
  assert.deepEqual(e.errors, []);
});

test('mergePaidCycleKeys une guru e paddle sem duplicar mesma chave', () => {
  const merged = mergePaidCycleKeys(
    new Set(['guru:sub1:c1', 'guru:sub1:c2']),
    new Set(['paddle:sub2:m2025-06'])
  );
  assert.equal(merged.size, 3);
});

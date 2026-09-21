import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRILHA_MIN_PAID_MONTHS,
  buildTrilhaRedeemEligibility,
  countDistinctPaidMonths,
  isTrilhaRedeemGranted,
  mergePaidCycleKeys,
  pagarmeCycleKey,
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
  assert.equal(isTrilhaRedeemGranted('24', 'Felipe.rubens@yahoo.com.br'), true);
  assert.equal(isTrilhaRedeemGranted('24', 'outro@yahoo.com.br'), false);
  assert.equal(isTrilhaRedeemGranted('1508', 'multicursossuporte@gmail.com'), true);
  assert.equal(isTrilhaRedeemGranted(1508, 'Multicursossuporte@gmail.com'), true);
  assert.equal(isTrilhaRedeemGranted('1508', 'outro@gmail.com'), false);
  assert.equal(isTrilhaRedeemGranted('8691', 'mktvirals@gmail.com'), true);
  assert.equal(isTrilhaRedeemGranted(8691, 'Mktvirals@gmail.com'), true);
  assert.equal(isTrilhaRedeemGranted('8691', 'outro@gmail.com'), false);
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

test('grant do Felipe libera resgate no preço da trilha', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '24',
    email: 'Felipe.rubens@yahoo.com.br',
    paidMonths: 0
  });
  assert.equal(e.eligible, true);
  assert.equal(e.granted, true);
  assert.equal(e.paid_months, TRILHA_MIN_PAID_MONTHS);
  assert.equal(e.missing_months, 0);
});

test('grant do Multicursos libera resgate no preço da trilha', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '1508',
    email: 'multicursossuporte@gmail.com',
    paidMonths: 0
  });
  assert.equal(e.eligible, true);
  assert.equal(e.granted, true);
  assert.equal(e.paid_months, TRILHA_MIN_PAID_MONTHS);
  assert.equal(e.missing_months, 0);
  assert.equal(e.sources.grant, true);
  assert.match(e.message, /suporte/);
});

test('grant do mktvirals libera resgate no preço da trilha', () => {
  const e = buildTrilhaRedeemEligibility({
    accountId: '8691',
    email: 'mktvirals@gmail.com',
    paidMonths: 1
  });
  assert.equal(e.eligible, true);
  assert.equal(e.granted, true);
  assert.equal(e.paid_months, TRILHA_MIN_PAID_MONTHS);
  assert.equal(e.missing_months, 0);
  assert.equal(e.sources.grant, true);
  assert.match(e.message, /suporte/);
});

test('mergePaidCycleKeys une guru, paddle e pagar.me sem duplicar mesma chave', () => {
  const merged = mergePaidCycleKeys(
    new Set(['guru:sub1:c1', 'guru:sub1:c2']),
    new Set(['paddle:sub2:m2025-06']),
    new Set(['pagarme:m2026-09'])
  );
  assert.equal(merged.size, 4);
});

test('countDistinctPaidMonths junta o mesmo mês Guru + Pagar.me', () => {
  assert.equal(countDistinctPaidMonths(new Set([
    'guru:sub1:c1:m2026-08',
    'pagarme:m2026-08',
    'pagarme:m2026-09',
    'pagarme:m2026-07'
  ])), 3);
});

test('pagarmeCycleKey conta renovação e checkout Guru, ignora pró-rata e token', () => {
  assert.equal(pagarmeCycleKey({
    status: 'paid',
    amount: 55300,
    code: 'leona-8691-7-sub',
    created_at: '2026-09-08T02:29:01Z',
    items: [{ description: 'Leona Flow — 7 conexões' }]
  }), 'pagarme:m2026-09');

  assert.equal(pagarmeCycleKey({
    status: 'paid',
    amount: 31600,
    code: 'a22afc91-910d-4cfd-b602-bf2b44028d27',
    charges: [{ status: 'paid', paid_at: '2026-07-03T05:15:16Z' }],
    items: [{ description: 'Plano Starter - 4 conexões' }]
  }), 'pagarme:m2026-07');

  assert.equal(pagarmeCycleKey({
    status: 'paid',
    amount: 6057,
    code: 'leona-8691-8-prorata',
    created_at: '2026-09-15T18:01:43Z',
    items: [{ description: 'Ajuste Leona — 8 conexões' }]
  }), null);

  assert.equal(pagarmeCycleKey({
    status: 'paid',
    amount: 2370,
    code: 'a2570bb2-0afc-44a2-89f3-122d4f3f805f',
    created_at: '2026-07-25T02:43:53Z',
    items: [{ description: 'Plano Starter - 6 conexões' }]
  }), null);

  assert.equal(pagarmeCycleKey({
    status: 'paid',
    amount: 500,
    code: 'leona-tokens-8691-1000',
    created_at: '2026-09-01T00:00:00Z'
  }), null);
});

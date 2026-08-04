import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrilhaPayload,
  resolveTrilhaRevenue,
  formatRevenueDisplay
} from '../lib/trilha-prizes.js';

test('resolveTrilhaRevenue usa mock para conta 1234', () => {
  const r = resolveTrilhaRevenue('1234', null);
  assert.equal(r.value, 267_000);
  assert.equal(r.source, 'mock');
});

test('buildTrilhaPayload desbloqueia marcos até 250k com 267k', () => {
  const payload = buildTrilhaPayload({
    accountId: '1234',
    profile: { user: { name: 'Demo' }, plan_summary: '1 Starter', subscription_status: 'active' },
    revenueValue: 267_000,
    revenueSource: 'mock'
  });

  assert.equal(payload.summary.unlocked, 3);
  assert.equal(payload.prizes.find(p => p.id === '50k').unlocked, true);
  assert.equal(payload.prizes.find(p => p.id === '100k').unlocked, true);
  assert.equal(payload.prizes.find(p => p.id === '250k').unlocked, true);
  assert.equal(payload.prizes.find(p => p.id === '500k').unlocked, false);
  assert.equal(payload.revenue.next_milestone.id, '500k');
});

test('buildTrilhaPayload bloqueia resgate sem 3 meses pagos', () => {
  const payload = buildTrilhaPayload({
    accountId: '1234',
    profile: { user: { name: 'Demo' }, plan_summary: '1 Starter', subscription_status: 'active' },
    revenueValue: 267_000,
    revenueSource: 'mock',
    redeemEligibility: {
      eligible: false,
      required_months: 3,
      paid_months: 1,
      missing_months: 2,
      demo: true
    }
  });

  assert.equal(payload.prizes.find(p => p.id === '50k').unlocked, true);
  assert.equal(payload.prizes.find(p => p.id === '50k').status, 'ineligible');
  assert.equal(payload.prizes.find(p => p.id === '50k').redeem_blocked, true);
  assert.equal(payload.prizes.filter(p => p.status === 'available').length, 0);
});

test('formatRevenueDisplay compacto', () => {
  assert.equal(formatRevenueDisplay(267_000), 'R$ 267 mil');
});

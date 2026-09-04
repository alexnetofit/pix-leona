import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrilhaPayload,
  pickBrlLifetimeRevenue,
  resolveTrilhaRevenue,
  formatRevenueDisplay
} from '../lib/trilha-prizes.js';

test('resolveTrilhaRevenue usa mock para conta 1234', () => {
  const r = resolveTrilhaRevenue('1234', null);
  assert.equal(r.value, 267_000);
  assert.equal(r.source, 'mock');
});

test('grant de faturamento soma 85k só com conta e e-mail certos', () => {
  const email = 'directorquotealfredangelo@gmail.com';
  const granted = resolveTrilhaRevenue('5409', 136_888.1, email);
  assert.equal(granted.value, 221_888.1);
  assert.equal(granted.source, 'api+grant');
  const wrongEmail = resolveTrilhaRevenue('5409', 136_888.1, 'outro@gmail.com');
  assert.equal(wrongEmail.value, 136_888.1);
  assert.equal(wrongEmail.source, 'api');
  const bernardo = resolveTrilhaRevenue('3039', 224_304.99, 'bernardopicinatto.tfg@gmail.com');
  assert.equal(bernardo.value, 236_382.99);
  assert.equal(bernardo.source, 'api+grant');
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
  assert.equal(payload.prizes.find(p => p.id === '50k').can_anticipate, true);
  assert.equal(payload.prizes.find(p => p.id === '50k').anticipateCents, 6750);
  assert.equal(payload.prizes.find(p => p.id === '100k').status, 'ineligible');
  assert.equal(payload.prizes.find(p => p.id === '100k').can_anticipate, true);
  assert.equal(payload.prizes.find(p => p.id === '100k').anticipateCents, 34650);
  assert.equal(payload.prizes.filter(p => p.status === 'available').length, 0);
});

test('pickBrlLifetimeRevenue usa só BRL', () => {
  assert.equal(pickBrlLifetimeRevenue({ revenue_by_currency: { BRL: 10047.9, USD: 10 } }), 10047.9);
  assert.equal(pickBrlLifetimeRevenue({ revenue_by_currency: { PYG: 19433400 } }), null);
  assert.equal(pickBrlLifetimeRevenue({ revenue_by_currency: {} }), null);
});

test('prêmios de R$ 29,90 aparecem com o preço, não como GRÁTIS', () => {
  const payload = buildTrilhaPayload({
    accountId: '1234',
    profile: { user: { name: 'Demo' }, plan_summary: '1 Starter', subscription_status: 'active' },
    revenueValue: 267_000,
    revenueSource: 'mock'
  });
  const fifty = payload.prizes.find((p) => p.id === '50k');
  const placa = payload.prizes.find((p) => p.id === '100k');
  assert.equal(fifty.prizeFree, true);
  assert.match(fifty.priceFormatted, /29/);
  assert.equal(fifty.shippingLabel, 'Frete grátis');
  assert.equal(fifty.priceCents, 2990);
  assert.equal(placa.prizeFree, false);
  assert.match(placa.priceFormatted, /297/);
  assert.ok(placa.items.some((i) => i.highlight && /Grupo VIP/.test(i.text)));
  assert.equal(fifty.extraUnitCents, 6750);
  assert.equal(placa.extraUnitCents, 34650);
  assert.equal(payload.prizes.find((p) => p.id === '250k').extraUnitCents, 5450);
});

test('grant de suporte libera resgate no preço normal, não no custo', () => {
  const payload = buildTrilhaPayload({
    accountId: '15',
    profile: {
      user: { name: 'Praxedes', email: 'praxedesconsultoriaoline@gmail.com' },
      plan_summary: 'inactive',
      subscription_status: 'inactive'
    },
    revenueValue: 20_200_000,
    revenueSource: 'api',
    redeemEligibility: {
      eligible: true,
      granted: true,
      required_months: 3,
      paid_months: 3,
      missing_months: 0
    }
  });

  const fifty = payload.prizes.find((p) => p.id === '50k');
  const placa = payload.prizes.find((p) => p.id === '100k');
  assert.equal(payload.summary.unlocked, payload.prizes.length);
  assert.equal(fifty.status, 'available');
  assert.equal(fifty.can_anticipate, false);
  assert.equal(fifty.redeem_blocked, false);
  assert.equal(fifty.displayCents, 2990);
  assert.equal(fifty.cta, 'Resgatar');
  assert.equal(placa.status, 'available');
  assert.equal(placa.can_anticipate, false);
  assert.equal(placa.displayCents, 29700);
  assert.equal(placa.cta, 'Resgatar');
  assert.equal(payload.prizes.every((p) => p.status === 'available'), true);
});

test('quem já adquiriu vê o preço da unidade extra', () => {
  const payload = buildTrilhaPayload({
    accountId: '1234',
    profile: { user: { name: 'Demo' }, plan_summary: '1 Starter', subscription_status: 'active' },
    revenueValue: 267_000,
    revenueSource: 'mock',
    purchasedPrizeIds: ['50k']
  });
  const fifty = payload.prizes.find((p) => p.id === '50k');
  assert.equal(fifty.acquired, true);
  assert.equal(fifty.displayCents, 6750);
  assert.match(fifty.priceFormatted, /67/);
  assert.equal(payload.prizes.find((p) => p.id === '100k').acquired, false);
});

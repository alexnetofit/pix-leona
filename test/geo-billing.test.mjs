import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPaddleInternationalTransaction,
  countryFromAcceptLanguage,
  countryFromHeaders,
  findStarterPriceId,
  findStarterProductId,
  paddleInternationalReady,
  resolvePaddleInternationalCharge,
  suggestInternational
} from '../lib/geo-billing.js';

test('lê o país do IP da Vercel', () => {
  assert.equal(countryFromHeaders({ 'x-vercel-ip-country': 'us' }), 'US');
  assert.equal(countryFromHeaders({ 'cf-ipcountry': 'PT' }), 'PT');
  assert.equal(countryFromHeaders({ 'x-vercel-ip-country': 'xx' }), null);
});

test('infere país do Accept-Language', () => {
  assert.equal(countryFromAcceptLanguage('pt-BR,pt;q=0.9'), 'BR');
  assert.equal(countryFromAcceptLanguage('en-US,en;q=0.8'), 'US');
  assert.equal(countryFromAcceptLanguage('en'), null);
});

test('sugere Paddle só fora do Brasil', () => {
  assert.equal(suggestInternational('BR'), false);
  assert.equal(suggestInternational('US'), true);
  assert.equal(suggestInternational(null), false);
});

test('paddle_ready só precisa da API key (preço vem do catálogo)', () => {
  assert.equal(paddleInternationalReady({}), false);
  assert.equal(paddleInternationalReady({ PADDLE_API_KEY: 'x' }), true);
});

test('acha o preço Starter no catálogo se a env estiver vazia', () => {
  assert.equal(findStarterPriceId([], null), null);
  assert.equal(findStarterPriceId([], 'pri_env'), 'pri_env');
  assert.equal(findStarterPriceId([
    {
      name: 'Leona Flow',
      prices: [
        { id: 'pri_month', status: 'active', billing_cycle: { interval: 'month' } }
      ]
    }
  ], ''), 'pri_month');
});

test('transaction internacional leva account e qty sem CPF', () => {
  const body = buildPaddleInternationalTransaction({
    accountId: '14538',
    qty: 2,
    customerId: 'ctm_1',
    priceId: 'pri_starter',
    checkoutUrl: 'https://client.leonaflow.com/assinatura'
  });
  assert.equal(body.collection_mode, 'automatic');
  assert.equal(body.currency_code, 'BRL');
  assert.deepEqual(body.items, [{ price_id: 'pri_starter', quantity: 2 }]);
  assert.equal(body.custom_data.leona_account_id, '14538');
  assert.equal(body.custom_data.qty, '2');
  assert.equal(body.discount.type, 'flat_per_seat');
  assert.equal(body.discount.amount, '2800');
  assert.ok(!('document' in body));
});

test('1 conexão não aplica desconto de volume', () => {
  const body = buildPaddleInternationalTransaction({
    accountId: 10,
    qty: 1,
    customerId: 'ctm_1',
    priceId: 'pri_starter'
  });
  assert.equal(body.discount, undefined);
});

test('acha o product_id Starter no catálogo', () => {
  assert.equal(findStarterProductId([], null), null);
  assert.equal(findStarterProductId([
    { id: 'pro_flow', name: 'Leona Flow', prices: [{ id: 'pri_month' }] }
  ], ''), 'pro_flow');
  assert.equal(findStarterProductId([
    { id: 'pro_other', name: 'Outro', prices: [{ id: 'pri_env' }] }
  ], 'pri_env'), 'pro_other');
});

test('assinatura nova no exterior continua recorrente no valor cheio', () => {
  const charge = resolvePaddleInternationalCharge({
    qty: 8,
    kind: 'subscription',
    profile: { starter_instances: 0 }
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.oneShot, false);
  assert.equal(charge.amountCents, null);
});

test('upgrade 7→8 no ciclo aberto cobra só o pró-rata, não R$ 632', () => {
  const now = new Date('2026-08-29T12:00:00-03:00');
  const charge = resolvePaddleInternationalCharge({
    qty: 8,
    kind: 'subscription',
    profile: {
      starter_instances: 7,
      current_period_end: '2026-09-19T23:59:59-03:00'
    },
    now
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.oneShot, true);
  assert.equal(charge.keepCycle, true);
  assert.equal(charge.dueDate, '2026-09-19');
  assert.ok(charge.amountCents > 0);
  assert.ok(charge.amountCents < 20000, `pró-rata deveria ser ~R$ 55–60, veio ${charge.amountCents}`);
  assert.notEqual(charge.amountCents, 63200);
});

test('transaction one_shot da Paddle é avulsa no valor do pró-rata', () => {
  const body = buildPaddleInternationalTransaction({
    accountId: '10864',
    qty: 8,
    customerId: 'ctm_1',
    priceId: 'pri_starter',
    productId: 'pro_starter',
    kind: 'one_shot',
    amountCents: 5530
  });
  assert.equal(body.items[0].quantity, 1);
  assert.equal(body.items[0].price.unit_price.amount, '5530');
  assert.equal(body.items[0].price.product_id, 'pro_starter');
  assert.equal(body.items[0].price_id, undefined);
  assert.equal(body.discount, undefined);
  assert.equal(body.custom_data.kind, 'one_shot');
  assert.equal(body.custom_data.qty, '8');
  assert.equal(body.custom_data.amount_cents, '5530');
});

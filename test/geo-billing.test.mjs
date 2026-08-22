import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPaddleInternationalTransaction,
  countryFromAcceptLanguage,
  countryFromHeaders,
  findStarterPriceId,
  paddleInternationalReady,
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
